'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const { createDriverClient } = require('../driver-client.cjs');
const { createManualClock } = require('./helpers/manual-clock.cjs');

const pluginRoot = path.resolve(__dirname, '..');
const fakeDriver = path.join(pluginRoot, 'test', 'helpers', 'fake-driver.cjs');

// Let promise continuations run before the manual clock is advanced.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function recordingClock(base) {
  const delays = [];
  return {
    delays,
    clock: {
      now: () => base.now(),
      setTimeout(handler, delay) { delays.push(delay); return base.setTimeout(handler, delay); },
      clearTimeout: (handle) => base.clearTimeout(handle),
    },
  };
}

// A child that reports a spawn failure the way Node does for a missing binary.
function failingChild(code) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  process.nextTick(() => {
    const error = new Error(`spawn cua-driver ${code}`);
    error.code = code;
    child.emit('error', error);
    child.exitCode = 1;
    child.emit('close', 1);
  });
  return child;
}

async function makeDriver({ config = {}, clientOptions = {}, clock, delegate } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'driver-client-'));
  await writeFile(path.join(directory, 'fake-driver-config.json'), JSON.stringify(config), 'utf8');
  const baseClock = clock || createManualClock();
  const spawned = [];
  const spawnFn = (command, args, options) => {
    const child = delegate ? delegate(command, args, options) : spawn(command, args, options);
    const record = { child, writes: [] };
    const original = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => {
      record.writes.push(String(chunk));
      return original(chunk, ...rest);
    };
    spawned.push(record);
    return child;
  };
  const client = createDriverClient({
    command: process.execPath,
    args: [fakeDriver, 'mcp'],
    env: { ...process.env, TMP: directory, TEMP: directory },
    clock: baseClock,
    spawnFn,
    ...clientOptions,
  });
  return { client, clock: baseClock, spawned, directory };
}

test('starts lazily and only spawns the driver on demand', async (t) => {
  const { client, spawned, directory } = await makeDriver({ config: { tools: ['click'] } });
  t.after(async () => { await client.stop(); await rm(directory, { recursive: true, force: true }); });

  assert.equal(client.status, 'idle');
  assert.equal(spawned.length, 0);
  assert.equal(client.driverVersion, null);
  assert.equal(client.tools.size, 0);
  assert.equal(client.lastError, null);

  await client.start();
  assert.equal(spawned.length, 1);
  assert.equal(client.status, 'ready');
  assert.equal(client.driverVersion, '0.38.0');
  assert.equal(client.tools.get('click').name, 'click');
  assert.ok(client.tools.get('click').inputSchema);
});

test('rejects an older driver version, names both versions, and recovers on a later start', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'driver-client-version-'));
  const configPath = path.join(directory, 'fake-driver-config.json');
  await writeFile(configPath, JSON.stringify({ version: '0.37.0' }), 'utf8');
  const clock = createManualClock();
  const client = createDriverClient({
    command: process.execPath,
    args: [fakeDriver, 'mcp'],
    env: { ...process.env, TMP: directory, TEMP: directory },
    clock,
    minimumVersion: '0.38.0',
  });
  t.after(async () => { await client.stop(); await rm(directory, { recursive: true, force: true }); });

  await assert.rejects(client.start(), (error) => {
    assert.match(error.message, /0\.37\.0/);
    assert.match(error.message, /0\.38\.0/);
    return true;
  });
  assert.equal(client.status, 'failed');
  assert.ok(client.lastError instanceof Error);

  // The version failure is recoverable: a later start retries with a fresh child.
  await writeFile(configPath, JSON.stringify({ version: '0.38.0' }), 'utf8');
  const initialized = await client.start();
  assert.equal(client.status, 'ready');
  assert.equal(client.driverVersion, '0.38.0');
  assert.ok(initialized.serverInfo);
});

test('health reports false without a live child and true once the driver answers', async (t) => {
  const { client, spawned, directory } = await makeDriver({ config: { tools: ['click'] } });
  t.after(async () => { await client.stop(); await rm(directory, { recursive: true, force: true }); });

  assert.equal(await client.health(), false);
  await client.start();
  assert.equal(await client.health(), true);
  assert.equal(spawned.length, 1);
});

test('restarts automatically after an unexpected exit and serves the next call from a new child', async (t) => {
  const { client, clock, spawned, directory } = await makeDriver({ config: { tools: ['click'], exitAfterCalls: 1 } });
  t.after(async () => { await client.stop(); await rm(directory, { recursive: true, force: true }); });

  await client.start();
  const first = await client.call('tools/call', { name: 'click', arguments: { x: 1 } });
  assert.match(first.content[0].text, /"name":"click"/);

  await assert.rejects(client.call('tools/call', { name: 'click', arguments: { x: 2 } }), /exited/i);
  assert.equal(client.status, 'failed');
  assert.match(client.lastError.message, /exited/i);
  assert.equal(spawned.length, 1);

  // The restart waits for the backoff delay before a new child is spawned.
  await clock.advance(250);
  assert.equal(spawned.length, 2);
  assert.notEqual(spawned[0].child.pid, spawned[1].child.pid);
  assert.equal(client.status, 'ready');
  assert.equal(client.restartAttempts, 0);

  const second = await client.call('tools/call', { name: 'click', arguments: { x: 3 } });
  assert.match(second.content[0].text, /"name":"click"/);
});

test('backs off between automatic restarts and stops after the attempt budget', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'driver-client-backoff-'));
  const configPath = path.join(directory, 'fake-driver-config.json');
  await writeFile(configPath, JSON.stringify({ exitOnStart: true }), 'utf8');
  const base = createManualClock();
  const { clock, delays } = recordingClock(base);
  const spawned = [];
  const client = createDriverClient({
    command: process.execPath,
    args: [fakeDriver, 'mcp'],
    env: { ...process.env, TMP: directory, TEMP: directory },
    clock,
    handshakeTimeoutMs: 60_000,
    callTimeoutMs: 120_000,
    backoff: { initialMs: 100, maxMs: 250, factor: 2, maxAttempts: 4 },
    spawnFn: (command, args, options) => {
      const child = spawn(command, args, options);
      spawned.push(child);
      return child;
    },
  });
  t.after(async () => { await client.stop(); await rm(directory, { recursive: true, force: true }); });

  await assert.rejects(client.start(), /exited/i);
  assert.equal(client.status, 'failed');

  await base.advance(100);
  await base.advance(200);
  await base.advance(250);
  await base.advance(250);
  await base.advance(1_000);

  // Handshake and call timeouts are far above the backoff ceiling, so the
  // filtered delays are exactly the restart backoff sequence.
  assert.deepEqual(delays.filter((delay) => delay <= 250), [100, 200, 250, 250]);
  assert.ok(delays.includes(60_000));
  assert.equal(client.restartAttempts, 4);
  assert.equal(spawned.length, 5);
  assert.equal(client.status, 'failed');

  // The budget is exhausted, but the client stays recoverable.
  await writeFile(configPath, JSON.stringify({ version: '0.38.0' }), 'utf8');
  await client.restart();
  assert.equal(client.status, 'ready');
  assert.equal(client.restartAttempts, 0);
});

test('rejects a call the driver never answers, using the injected clock', async (t) => {
  const { client, clock, directory } = await makeDriver({
    config: { tools: ['get_desktop_state'], noRespond: ['get_desktop_state'] },
  });
  t.after(async () => { await client.stop(); await rm(directory, { recursive: true, force: true }); });

  await client.start();
  const pending = client.call('tools/call', { name: 'get_desktop_state', arguments: {} });
  await flush();
  await clock.advance(60_000);
  await assert.rejects(pending, /timed out/i);
});

test('never writes to a dead child and spawns a fresh one instead', async (t) => {
  const { client, clock, spawned, directory } = await makeDriver({ config: { tools: ['click'], exitAfterCalls: 1 } });
  t.after(async () => { await client.stop(); await rm(directory, { recursive: true, force: true }); });

  await client.start();
  await client.call('tools/call', { name: 'click', arguments: {} });
  await assert.rejects(client.call('tools/call', { name: 'click', arguments: {} }), /exited/i);
  const writesAfterDeath = spawned[0].writes.length;

  await clock.advance(250);
  assert.equal(spawned.length, 2);
  await client.call('tools/call', { name: 'click', arguments: {} });

  assert.equal(spawned[0].writes.length, writesAfterDeath);
  assert.ok(spawned[1].writes.length >= 4);
});

test('a failed start does not lock the client and a later start can succeed', async (t) => {
  let attempts = 0;
  const { client, directory } = await makeDriver({
    config: { tools: ['click'] },
    delegate: (command, args, options) => {
      attempts += 1;
      if (attempts === 1) return failingChild('ENOENT');
      return spawn(command, args, options);
    },
  });
  t.after(async () => { await client.stop(); await rm(directory, { recursive: true, force: true }); });

  await assert.rejects(client.start(), /not installed/i);
  assert.equal(client.status, 'failed');
  assert.ok(client.lastError instanceof Error);

  const initialized = await client.start();
  assert.equal(client.status, 'ready');
  assert.equal(attempts, 2);
  assert.equal(client.driverVersion, '0.38.0');
  assert.ok(initialized.serverInfo);
});

test('surfaces driver errors, reports status changes, and stops cleanly', async (t) => {
  const { client, directory } = await makeDriver({
    config: { tools: ['click'], scenario: { click: { error: 'driver refused the click' } } },
  });
  t.after(async () => { await client.stop(); await rm(directory, { recursive: true, force: true }); });

  const seen = [];
  const unsubscribe = client.subscribe((next) => seen.push(next));
  await client.start();
  assert.deepEqual(seen, ['starting', 'ready']);

  await assert.rejects(client.call('tools/call', { name: 'click', arguments: {} }), /driver refused the click/);

  unsubscribe();
  await client.stop();
  assert.equal(client.status, 'stopped');
  assert.deepEqual(seen, ['starting', 'ready']);
});

'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSession } = require('../session.cjs');

async function tempDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// A live process that only exists to be named as the lease owner.
function spawnIdle() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  return child;
}

test('the lease is taken by the first session', async (t) => {
  const directory = await tempDir(t);
  const session = createSession({ dataDir: directory });
  const lease = await session.acquireLease();
  assert.equal(lease.ok, true);
  assert.equal(lease.owner, process.pid);
  assert.equal(session.holdsLease(), true);

  const stored = JSON.parse(await readFile(path.join(directory, 'computer-use-lease.json'), 'utf8'));
  assert.equal(stored.pid, process.pid);
});

test('a live owner blocks another session', async (t) => {
  const directory = await tempDir(t);
  const child = spawnIdle();
  t.after(() => child.kill('SIGKILL'));
  await writeFile(path.join(directory, 'computer-use-lease.json'), JSON.stringify({ pid: child.pid, acquiredAt: Date.now() }), 'utf8');

  const session = createSession({ dataDir: directory });
  const lease = await session.acquireLease();
  assert.equal(lease.ok, false);
  assert.equal(lease.owner, child.pid);
  assert.equal(session.holdsLease(), false);
});

test('a lease left behind by a dead process is taken over', async (t) => {
  const directory = await tempDir(t);
  const child = spawnIdle();
  const pid = child.pid;
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));
  await writeFile(path.join(directory, 'computer-use-lease.json'), JSON.stringify({ pid, acquiredAt: Date.now() }), 'utf8');

  const session = createSession({ dataDir: directory });
  const lease = await session.acquireLease();
  assert.equal(lease.ok, true);
  assert.equal(lease.owner, process.pid);
});

test('releasing the lease removes the file', async (t) => {
  const directory = await tempDir(t);
  const session = createSession({ dataDir: directory });
  await session.acquireLease();
  assert.equal(await session.releaseLease(), true);
  assert.equal(session.holdsLease(), false);
  await assert.rejects(() => readFile(path.join(directory, 'computer-use-lease.json'), 'utf8'));
});

test('releasing a lease that was never taken does nothing', async (t) => {
  const directory = await tempDir(t);
  const session = createSession({ dataDir: directory });
  assert.equal(await session.releaseLease(), false);
});

test('the stop switch latches with its reason', () => {
  const session = createSession({ dataDir: null });
  assert.equal(session.isStopped(), false);
  const stopped = session.stop('the user asked');
  assert.deepEqual(stopped, { stopped: true, reason: 'the user asked' });
  assert.equal(session.isStopped(), true);
  assert.equal(session.stopReason(), 'the user asked');
});

test('a session without a data directory still reports a usable lease', async () => {
  const session = createSession({ dataDir: null });
  const lease = await session.acquireLease();
  assert.equal(lease.ok, true);
  assert.equal(lease.skipped, true);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const { createManagedBrowser } = require('../managed-browser.cjs');

const fixtures = new Set();

function createFakeChromium() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-managed-chrome-'));
  fixtures.add(root);
  const scriptPath = path.join(root, 'fake-cdp.cjs');
  const launcherPath = path.join(root, 'fake-chromium');
  const logPath = path.join(root, 'commands.jsonl');
  const argsLogPath = path.join(root, 'launch-args.json');
  const script = `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argsLogPath)}, JSON.stringify(process.argv.slice(2)));
const input = fs.createReadStream(null, { fd: 3 });
let buffer = '';
function write(value) { fs.writeSync(4, JSON.stringify(value) + '\\0'); }
input.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let split;
  while ((split = buffer.indexOf('\\0')) !== -1) {
    const raw = buffer.slice(0, split);
    buffer = buffer.slice(split + 1);
    if (!raw) continue;
    const command = JSON.parse(raw);
    fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(command) + '\\n');
    const result = (value = {}) => write({ id: command.id, result: value });
    if (command.method === 'Target.getTargets') {
      result({ targetInfos: [{ targetId: 'target-0', type: 'page', url: 'about:blank' }] });
    } else if (command.method === 'Target.createTarget') {
      result({ targetId: 'target-' + Date.now() });
    } else if (command.method === 'Target.attachToTarget') {
      result({ sessionId: 'session-' + command.params.targetId });
    } else if (command.method === 'Page.navigate') {
      result({ frameId: 'main-frame' });
      setTimeout(() => write({ method: 'Page.loadEventFired', sessionId: command.sessionId, params: { timestamp: Date.now() } }), 5);
    } else if (command.method === 'Runtime.evaluate') {
      result({ result: { type: 'string', value: 'complete' } });
    } else if (command.method === 'Target.closeTarget') {
      result({ success: true });
    } else if (command.method === 'Test.fail') {
      write({ id: command.id, error: { code: -32000, message: 'fake CDP failure' } });
    } else if (command.method === 'Test.noResponse') {
      // Keep the command pending until the parent exercises its timeout path.
    } else if (command.method === 'Browser.close') {
      result();
      setTimeout(() => process.exit(0), 10);
    } else {
      result();
    }
  }
});
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o600 });
  fs.writeFileSync(launcherPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`, { mode: 0o700 });
  fs.chmodSync(launcherPath, 0o700);
  return { root, logPath, argsLogPath, executablePath: launcherPath };
}

afterEach(() => {
  for (const root of fixtures) fs.rmSync(root, { recursive: true, force: true });
  fixtures.clear();
});

test('owns a lazy CDP browser process and keeps one page session per logical tab', async () => {
  const fixture = createFakeChromium();
  const backend = createManagedBrowser({
    dataPath: path.join(fixture.root, 'plugin-data'),
    executablePath: fixture.executablePath,
    timeoutMs: 1000,
  });

  assert.equal((await backend.health()).running, false);
  assert.deepEqual(await backend.send('Page.enable'), {});
  assert.deepEqual(await backend.send('Page.navigate', { url: 'https://example.com' }), { frameId: 'main-frame' });
  assert.deepEqual(await backend.waitForLoad('tab_0', 500), { loaded: true });
  assert.deepEqual(await backend.send('Page.enable', {}, 'tab_1'), {});
  assert.equal((await backend.send('Runtime.evaluate', { expression: 'document.readyState' }, 'tab_1')).result.value, 'complete');

  const commands = fs.readFileSync(fixture.logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const attached = commands.filter((command) => command.method === 'Target.attachToTarget');
  assert.equal(attached.length, 2);
  assert.notEqual(attached[0].params.targetId, attached[1].params.targetId);
  assert.ok(commands.every((command) => command.method !== 'Target.setDiscoverTargets'));
  const launchArgs = JSON.parse(fs.readFileSync(fixture.argsLogPath, 'utf8'));
  assert.ok(launchArgs.includes('--remote-debugging-pipe'));
  assert.ok(launchArgs.includes(`--user-data-dir=${path.join(fixture.root, 'plugin-data', 'managed-chromium-profile')}`));
  assert.ok(!launchArgs.includes('--no-sandbox'));
  assert.equal(await backend.closeTab('tab_1').then((result) => result.tabId), 'tab_1');
  await backend.close();
  await backend.close();
  await assert.rejects(backend.send('Page.enable'), /backend is closed/);
});

test('surfaces CDP errors and command timeouts without wedging the pipe', async () => {
  const fixture = createFakeChromium();
  const backend = createManagedBrowser({
    dataPath: path.join(fixture.root, 'plugin-data'),
    executablePath: fixture.executablePath,
    timeoutMs: 100,
  });
  await assert.rejects(backend.send('Test.fail'), /fake CDP failure/);
  await assert.rejects(backend.send('Test.noResponse'), /timed out after 100ms/);
  assert.deepEqual(await backend.send('Page.enable'), {});
  await backend.close();
});

test('refuses a profile directory that is a symlink', () => {
  const fixture = createFakeChromium();
  const dataPath = path.join(fixture.root, 'plugin-data');
  const externalPath = path.join(fixture.root, 'external-profile');
  fs.mkdirSync(dataPath, { recursive: true });
  fs.mkdirSync(externalPath);
  fs.symlinkSync(externalPath, path.join(dataPath, 'managed-chromium-profile'), 'dir');
  assert.throws(() => createManagedBrowser({ dataPath, executablePath: fixture.executablePath }), /must be a real directory/);
});

test('does not let custom arguments replace the owned profile or remote-debugging pipe', () => {
  const fixture = createFakeChromium();
  assert.throws(() => createManagedBrowser({
    dataPath: path.join(fixture.root, 'plugin-data'),
    executablePath: fixture.executablePath,
    args: ['--remote-debugging-port=9222'],
  }), /does not allow overriding/);
});

'use strict';

// Integration test against the real Cua Driver.
//
// The fake driver mirrors the real schemas, but only the real driver can
// prove that the plugin's argument translation, its observation parsing and
// its failure handling match the platform.
//
// The test is skipped unless COMPUTER_USE_REAL_DRIVER points at a cua-driver
// executable. It never dispatches input: the one write call it makes carries
// an empty text, so the driver validates the arguments and sends nothing.
//
//   COMPUTER_USE_REAL_DRIVER=C:\path\to\cua-driver.exe npm test

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const pluginRoot = path.resolve(__dirname, '..');
const server = path.join(pluginRoot, 'server.cjs');
const driverPath = (process.env.COMPUTER_USE_REAL_DRIVER || '').trim();
const skip = driverPath ? false : 'set COMPUTER_USE_REAL_DRIVER to run against the real Cua Driver';

function startBridge(env) {
  const child = spawn(process.execPath, [server], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  let id = 0;
  return {
    child,
    get stderr() { return stderr; },
    request(method, params = {}) {
      const requestId = ++id;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Timed out waiting for ${method}; stderr: ${stderr}`));
        }, 60000);
        pending.set(requestId, (message) => { clearTimeout(timer); resolve(message); });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      return promise;
    },
  };
}

test('the plugin speaks the real driver contract', { skip, timeout: 180000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-real-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bridge = startBridge({
    ...process.env,
    CUA_DRIVER_PATH: driverPath,
    CUA_DRIVER_ARGS: '',
    TMP: directory,
    TEMP: directory,
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  });
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });

  const initialized = await bridge.request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'real-driver-test', version: '1' },
  });
  assert.ok(initialized.result, JSON.stringify(initialized));
  assert.equal(initialized.result.serverInfo.name, 'computer_cua');

  const catalog = await bridge.request('tools/list');
  const names = catalog.result.tools.map((tool) => tool.name);
  for (const expected of ['get_desktop_state', 'get_window_state', 'list_windows', 'click', 'type_text', 'verify_state']) {
    assert.ok(names.includes(expected), `${expected} is missing from the tool surface`);
  }
  for (const expected of ['computer_use_status', 'computer_use_revoke', 'computer_use_screenshot', 'computer_use_stop']) {
    assert.ok(names.includes(expected), `${expected} is missing from the local tool surface`);
  }
  // The plugin adds its own handle to the write tools and keeps everything
  // else the driver declared.
  const click = catalog.result.tools.find((tool) => tool.name === 'click');
  assert.ok(click.inputSchema.properties.state_id, JSON.stringify(click.inputSchema));
  assert.ok(click.inputSchema.properties.pid, JSON.stringify(click.inputSchema));

  const observed = await bridge.request('tools/call', { name: 'get_desktop_state', arguments: {} });
  assert.ok(observed.result, JSON.stringify(observed));
  const state = observed.result.structuredContent;
  assert.match(state.state_id, /^st_[0-9a-f]{8}$/);
  assert.ok(state.screenshot.width > 0, JSON.stringify(state.screenshot));
  assert.ok(state.screenshot.height > 0, JSON.stringify(state.screenshot));
  assert.ok(state.observed_at, JSON.stringify(state));

  const capture = await bridge.request('tools/call', { name: 'computer_use_screenshot', arguments: {} });
  assert.ok(capture.result, JSON.stringify(capture));
  const image = capture.result.content.find((block) => block.type === 'image');
  assert.ok(image, JSON.stringify(capture.result.content));
  assert.equal(image.mimeType, 'image/png');
  assert.ok(image.data.length > 0);

  const windows = await bridge.request('tools/call', { name: 'list_windows', arguments: {} });
  assert.ok(windows.result, JSON.stringify(windows));

  // The write path: the plugin translates the arguments, the driver accepts
  // them. An empty text sends no characters, so nothing is dispatched.
  const empty = await bridge.request('tools/call', { name: 'type_text', arguments: { text: '', state_id: state.state_id } });
  const message = empty.error ? empty.error.message : '';
  assert.doesNotMatch(message, /unknown argument/i, `the driver rejected the plugin's arguments: ${message}`);
  assert.doesNotMatch(message, /^(POLICY_DENIED|STALE_STATE|CONTROL_STOPPED|CONTROL_BUSY)/, `the plugin refused the call before the driver saw it: ${message}`);
  if (empty.result) {
    assert.equal(empty.result.structuredContent.outcome, 'delivered');
    assert.equal(empty.result.structuredContent.state_id, state.state_id);
  }

  // A missing driver argument is the driver's own validation, and the plugin
  // reports it as a failure instead of a delivery.
  const missing = await bridge.request('tools/call', { name: 'type_text', arguments: { state_id: state.state_id } });
  assert.ok(missing.error, JSON.stringify(missing));
  assert.match(missing.error.message, /^INVALID_REQUEST:/);

  bridge.child.stdin.end();
  const [code] = await once(bridge.child, 'exit');
  assert.equal(code, 0);
});

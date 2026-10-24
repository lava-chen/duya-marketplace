'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, writeFile, readFile, rm, copyFile, link } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { encodePng } = require('../png.cjs');

const pluginRoot = path.resolve(__dirname, '..');
const server = path.join(pluginRoot, 'server.cjs');
const fakeDriver = path.join(pluginRoot, 'test', 'helpers', 'fake-driver.cjs');

const toolCatalog = [
  'get_guide', 'click', 'set_value', 'get_desktop_state', 'get_window_state', 'list_windows',
];
const localTools = ['computer_use_status', 'computer_use_revoke', 'computer_use_screenshot', 'computer_use_stop'];

// The plugin forwards only an allowlisted environment to the driver child, so
// the fake driver is configured through a file in the temporary directory.
async function writeFakeConfig(directory, config) {
  await writeFile(path.join(directory, 'fake-driver-config.json'), JSON.stringify(config), 'utf8');
}

function driverEnv(directory, extra = {}) {
  return {
    CUA_DRIVER_PATH: process.execPath,
    CUA_DRIVER_ARGS: JSON.stringify([fakeDriver, 'mcp']),
    TMP: directory,
    TEMP: directory,
    ...extra,
  };
}

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
    waitForStderr(pattern, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve, reject) => {
        const check = () => {
          if (pattern.test(stderr)) return resolve(stderr);
          if (Date.now() > deadline) return reject(new Error(`stderr never matched ${pattern}; stderr: ${stderr}`));
          setTimeout(check, 25);
        };
        check();
      });
    },
    request(method, params = {}) {
      const requestId = ++id;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Timed out waiting for ${method}; stderr: ${stderr}`));
        }, 15000);
        pending.set(requestId, (message) => { clearTimeout(timer); resolve(message); });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      return promise;
    },
  };
}

async function connect(bridge) {
  const initialized = await bridge.request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(initialized.result.serverInfo.name, 'computer_cua');
  return initialized;
}

async function closeBridge(bridge) {
  bridge.child.stdin.end();
  const [code] = await once(bridge.child, 'exit');
  return code;
}

// Observe and return the state handle the plugin minted.
async function observe(bridge, name = 'get_desktop_state', args = {}) {
  const response = await bridge.request('tools/call', { name, arguments: args });
  assert.ok(response.result, JSON.stringify(response));
  return response.result.structuredContent;
}

test('uses the configured driver, filters tools, and limits the child environment', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog });
  const bridge = startBridge(driverEnv(directory, {
    CUA_DRIVER_PERMISSION_MODE: 'standard',
    COMPUTER_USE_TEST_SECRET: 'must-not-reach-driver',
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });

  await connect(bridge);
  const catalog = await bridge.request('tools/list');
  assert.deepEqual(catalog.result.tools.map((tool) => tool.name), [...toolCatalog, ...localTools]);

  const result = await bridge.request('tools/call', { name: 'get_guide', arguments: { topic: 'permissions' } });
  const payload = JSON.parse(result.result.content[0].text);
  assert.equal(payload.name, 'get_guide');
  assert.deepEqual(payload.arguments, { topic: 'permissions' });
  assert.equal(payload.driverEnv.secretReached, false);
  assert.equal(payload.driverEnv.permissionMode, 'standard');

  const denied = await bridge.request('tools/call', { name: 'terminate_process', arguments: {} });
  assert.match(denied.error.message, /unavailable/);
  assert.equal(await closeBridge(bridge), 0);
});

test('the write tools advertise the state parameter they need', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-state-param-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog });
  const bridge = startBridge(driverEnv(directory));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const catalog = await bridge.request('tools/list');
  const click = catalog.result.tools.find((tool) => tool.name === 'click');
  assert.ok(click.inputSchema.properties.state_id, JSON.stringify(click.inputSchema));
  const guide = catalog.result.tools.find((tool) => tool.name === 'get_guide');
  assert.equal(guide.inputSchema.properties?.state_id, undefined);
  assert.equal(await closeBridge(bridge), 0);
});

test('discovers the driver from PATH when the setup path is empty', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog });
  const executable = path.join(directory, process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver');
  try {
    await link(process.execPath, executable);
  } catch {
    await copyFile(process.execPath, executable);
  }
  const bridge = startBridge({
    ...process.env,
    CUA_DRIVER_PATH: '',
    CUA_DRIVER_ARGS: JSON.stringify([fakeDriver, 'mcp']),
    TMP: directory,
    TEMP: directory,
    PATH: `${directory}${path.delimiter}${process.env.PATH || ''}`,
  });
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });

  await connect(bridge);
  const catalog = await bridge.request('tools/list');
  assert.deepEqual(catalog.result.tools.map((tool) => tool.name), [...toolCatalog, ...localTools]);
  assert.equal(await closeBridge(bridge), 0);
});

test('local revoke control denies writes and app policy errors fail closed', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-revoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_AUDIT_PATH: path.join(directory, 'audit.jsonl'),
    COMPUTER_USE_ACCESS_POLICY: '{bad json',
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });

  await connect(bridge);
  const deniedByInvalidPolicy = await bridge.request('tools/call', { name: 'click', arguments: {} });
  assert.match(deniedByInvalidPolicy.error.message, /Invalid Computer Use access policy/);
  const revoked = await bridge.request('tools/call', { name: 'computer_use_revoke', arguments: { duration_seconds: 30 } });
  assert.match(revoked.result.content[0].text, /"revoked":true/);
  const deniedByRevoke = await bridge.request('tools/call', { name: 'click', arguments: {} });
  assert.match(deniedByRevoke.error.message, /revoked/);
  const status = await bridge.request('tools/call', { name: 'computer_use_status' });
  assert.match(status.result.content[0].text, /"revoked":true/);
  assert.equal(await closeBridge(bridge), 0);
});

test('the app guard binds the policy check to the observed identity', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'deny', allowed_apps: ['allowed.exe'] }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const spoofedTitle = await bridge.request('tools/call', { name: 'click', arguments: { title: 'Allowed App' } });
  assert.match(spoofedTitle.error.message, /not in the configured allow list/);
  const observedTarget = await bridge.request('tools/call', { name: 'set_value', arguments: { window_id: 2, value: 'safe' } });
  assert.ok(observedTarget.result, JSON.stringify(observedTarget));
  const forgedWindow = await bridge.request('tools/call', { name: 'set_value', arguments: { window_id: 999, title: 'Allowed App', value: 'safe' } });
  assert.match(forgedWindow.error.message, /re-observe the desktop/);
  assert.equal(await closeBridge(bridge), 0);
});

test('revoke ledger is shared across separate plugin MCP processes', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-shared-revoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog });
  const sharedEnv = driverEnv(directory, { DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data') });
  const first = startBridge(sharedEnv);
  const second = startBridge(sharedEnv);
  t.after(() => { for (const bridge of [first, second]) if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await Promise.all([connect(first), connect(second)]);

  const revoked = await first.request('tools/call', { name: 'computer_use_revoke', arguments: { duration_seconds: 30 } });
  assert.match(revoked.result.content[0].text, /"revoked":true/);
  const status = await second.request('tools/call', { name: 'computer_use_status' });
  assert.match(status.result.content[0].text, /"revoked":true/);
  const denied = await second.request('tools/call', { name: 'click', arguments: {} });
  assert.match(denied.error.message, /revoked/);
  const codes = [];
  for (const bridge of [first, second]) codes.push(await closeBridge(bridge));
  assert.deepEqual(codes, [0, 0]);
});

test('a missing driver fails startup with an actionable message', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-missing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bridge = startBridge({
    ...process.env,
    CUA_DRIVER_PATH: path.join(directory, 'does-not-exist'),
    CUA_DRIVER_ARGS: JSON.stringify(['mcp']),
  });
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });

  const failed = await bridge.request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  assert.ok(failed.error, JSON.stringify(failed));
  assert.match(failed.error.message, /could not start|exited/i);
  assert.match(failed.error.message, /Cua Driver/);
});

test('a failing driver call is reported and recorded in the audit log', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-call-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditPath = path.join(directory, 'audit.jsonl');
  await writeFakeConfig(directory, {
    tools: toolCatalog,
    scenario: { click: { error: 'driver refused the click' } },
  });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_AUDIT_PATH: auditPath,
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const failed = await bridge.request('tools/call', { name: 'click', arguments: {} });
  assert.ok(failed.error, JSON.stringify(failed));
  assert.match(failed.error.message, /driver refused the click/);
  assert.match(failed.error.message, /\(retry: /);

  await new Promise((resolve) => setTimeout(resolve, 300));
  const lines = (await readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const entry = lines.find((item) => item.tool === 'click');
  assert.ok(entry, JSON.stringify(lines));
  assert.equal(entry.result, 'error');
  assert.equal(entry.tier, 'write');
  assert.ok(entry.callId, JSON.stringify(entry));
  assert.equal(await closeBridge(bridge), 0);
});

test('revocation blocks write tools while read tools stay available', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-revoke-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_AUDIT_PATH: path.join(directory, 'audit.jsonl'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  await bridge.request('tools/call', { name: 'computer_use_revoke', arguments: { duration_seconds: 60 } });
  const denied = await bridge.request('tools/call', { name: 'click', arguments: {} });
  assert.match(denied.error.message, /revoked/);
  const observation = await bridge.request('tools/call', { name: 'get_desktop_state', arguments: {} });
  assert.ok(observation.result, JSON.stringify(observation));
  assert.equal(await closeBridge(bridge), 0);
});

test('an unwritable audit log degrades instead of failing the tool call', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-audit-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blocker = path.join(directory, 'audit-file');
  await writeFile(blocker, 'not a directory', 'utf8');
  await writeFakeConfig(directory, { tools: toolCatalog });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_AUDIT_PATH: path.join(blocker, 'audit.jsonl'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const observed = await bridge.request('tools/call', { name: 'get_desktop_state', arguments: {} });
  assert.ok(observed.result, JSON.stringify(observed));
  await bridge.waitForStderr(/audit write failed/i);
  assert.equal(await closeBridge(bridge), 0);
});

test('the plugin recovers after the driver crashes mid session', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog, exitAfterCalls: 1 });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const first = await bridge.request('tools/call', { name: 'get_desktop_state', arguments: {} });
  assert.ok(first.result, JSON.stringify(first));

  const crashed = await bridge.request('tools/call', { name: 'list_windows', arguments: {} });
  assert.ok(crashed.error, JSON.stringify(crashed));
  assert.match(crashed.error.message, /exited|crashed/i);

  const recovered = await bridge.request('tools/call', { name: 'get_desktop_state', arguments: {} });
  assert.ok(recovered.result, JSON.stringify(recovered));
  assert.equal(await closeBridge(bridge), 0);
});

test('a driver older than the supported minimum is refused at startup', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog, version: '0.30.0' });
  const bridge = startBridge(driverEnv(directory, { COMPUTER_USE_MIN_DRIVER_VERSION: '0.38.0' }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });

  const failed = await bridge.request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  assert.ok(failed.error, JSON.stringify(failed));
  assert.match(failed.error.message, /0\.30\.0/);
  assert.match(failed.error.message, /0\.38\.0/);
});

test('an observation returns a state handle with the target and the capture size', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog, screen: { width: 8, height: 6 } });
  const bridge = startBridge(driverEnv(directory));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const state = await observe(bridge);
  assert.match(state.state_id, /^st_[0-9a-f]{8}$/);
  assert.equal(state.generation, 1);
  assert.ok(state.observed_at);
  assert.equal(state.target.pid, 101);
  assert.equal(state.screenshot.width, 8);
  assert.equal(state.screenshot.height, 6);

  const second = await observe(bridge);
  assert.equal(second.generation, 2);
  assert.notEqual(second.state_id, state.state_id);
  assert.equal(await closeBridge(bridge), 0);
});

test('a coordinate action without a state is refused', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-coordinate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog, screen: { width: 8, height: 6 } });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const refused = await bridge.request('tools/call', { name: 'click', arguments: { x: 3, y: 3 } });
  assert.ok(refused.error, JSON.stringify(refused));
  assert.match(refused.error.message, /^STALE_STATE:/);
  assert.match(refused.error.message, /state_id/);
  assert.match(refused.error.message, /\(retry: reobserve\)/);
  assert.equal(await closeBridge(bridge), 0);
});

test('a coordinate outside the capture of the state is refused', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-outside-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog, screen: { width: 8, height: 6 } });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const state = await observe(bridge);
  const refused = await bridge.request('tools/call', { name: 'click', arguments: { x: 40, y: 40, state_id: state.state_id } });
  assert.ok(refused.error, JSON.stringify(refused));
  assert.match(refused.error.message, /lies outside the 8x6 capture/);
  assert.equal(await closeBridge(bridge), 0);
});

test('an unknown state is refused as stale', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-unknown-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const refused = await bridge.request('tools/call', { name: 'click', arguments: { x: 1, y: 1, state_id: 'st_deadbeef' } });
  assert.ok(refused.error, JSON.stringify(refused));
  assert.match(refused.error.message, /unknown, superseded or expired/);
  assert.equal(await closeBridge(bridge), 0);
});

test('an element reference must be paired with the state it came from', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-element-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const withoutState = await bridge.request('tools/call', { name: 'set_value', arguments: { element_token: 's12345678:1', value: 'safe' } });
  assert.ok(withoutState.error, JSON.stringify(withoutState));
  assert.match(withoutState.error.message, /must be paired with the state_id/);

  const desktopState = await observe(bridge, 'get_desktop_state');
  const wrongState = await bridge.request('tools/call', { name: 'set_value', arguments: { element_token: 's12345678:1', value: 'safe', state_id: desktopState.state_id } });
  assert.ok(wrongState.error, JSON.stringify(wrongState));
  assert.match(wrongState.error.message, /carries no element references/);

  const windowState = await observe(bridge, 'get_window_state', { pid: 202, window_id: 2 });
  const accepted = await bridge.request('tools/call', { name: 'set_value', arguments: { element_token: 's12345678:1', value: 'safe', state_id: windowState.state_id } });
  assert.ok(accepted.result, JSON.stringify(accepted));
  assert.equal(await closeBridge(bridge), 0);
});

test('an action with a valid state costs one driver round trip', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-round-trip-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog, screen: { width: 8, height: 6 } });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const state = await observe(bridge);
  const before = state.generation;
  const click = await bridge.request('tools/call', { name: 'click', arguments: { x: 3, y: 3, state_id: state.state_id } });
  assert.ok(click.result, JSON.stringify(click));
  const receipt = click.result.structuredContent;
  assert.equal(receipt.state_id, state.state_id);
  assert.equal(receipt.outcome, 'delivered');
  assert.equal(receipt.action_sent, true);
  assert.equal(receipt.code, null);
  assert.ok(receipt.duration_ms >= 0);
  // The observation was not repeated for the action.
  assert.equal(receipt.calls, 2);
  assert.equal(before, 1);
  assert.equal(await closeBridge(bridge), 0);
});

test('the receipt carries the driver dispatch status when it reports one', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-receipt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, {
    tools: toolCatalog,
    screen: { width: 8, height: 6 },
    receipt: { action_sent: true, dispatch_status: 'possibly_sent' },
  });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const state = await observe(bridge);
  const click = await bridge.request('tools/call', { name: 'click', arguments: { x: 3, y: 3, state_id: state.state_id } });
  const receipt = click.result.structuredContent;
  assert.equal(receipt.action_sent, true);
  assert.equal(receipt.dispatch_status, 'possibly_sent');
  assert.equal(receipt.outcome, 'delivered');
  assert.equal(await closeBridge(bridge), 0);
});

test('a failed action that may have landed reports an unknown outcome', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-unknown-outcome-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditPath = path.join(directory, 'audit.jsonl');
  await writeFakeConfig(directory, {
    tools: toolCatalog,
    screen: { width: 8, height: 6 },
    scenario: { click: { error: 'the driver lost the connection' } },
    errorReceipt: { action_sent: true },
  });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_AUDIT_PATH: auditPath,
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const state = await observe(bridge);
  const failed = await bridge.request('tools/call', { name: 'click', arguments: { x: 3, y: 3, state_id: state.state_id } });
  assert.ok(failed.error, JSON.stringify(failed));

  await new Promise((resolve) => setTimeout(resolve, 300));
  const lines = (await readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const entry = lines.find((item) => item.tool === 'click');
  assert.ok(entry, JSON.stringify(lines));
  assert.equal(entry.result, 'error');
  assert.equal(entry.outcome, 'unknown');
  assert.equal(entry.actionSent, true);
  assert.ok(entry.code);
  assert.ok(entry.retry);
  assert.equal(await closeBridge(bridge), 0);
});

test('a stopped session refuses every later write', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-stop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog, screen: { width: 8, height: 6 } });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const stopped = await bridge.request('tools/call', { name: 'computer_use_stop', arguments: { reason: 'user asked' } });
  assert.match(stopped.result.content[0].text, /"stopped":true/);

  const state = await observe(bridge);
  const refused = await bridge.request('tools/call', { name: 'click', arguments: { x: 3, y: 3, state_id: state.state_id } });
  assert.ok(refused.error, JSON.stringify(refused));
  assert.match(refused.error.message, /^CONTROL_STOPPED:/);
  assert.equal(await closeBridge(bridge), 0);
});

test('a second plugin process cannot take the desktop', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-lease-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog, screen: { width: 8, height: 6 } });
  const shared = driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  });
  const first = startBridge(shared);
  const second = startBridge(shared);
  t.after(() => { for (const bridge of [first, second]) if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await Promise.all([connect(first), connect(second)]);

  const state = await observe(first);
  const owner = await first.request('tools/call', { name: 'click', arguments: { x: 3, y: 3, state_id: state.state_id } });
  assert.ok(owner.result, JSON.stringify(owner));

  const blocked = await second.request('tools/call', { name: 'click', arguments: { x: 3, y: 3, state_id: state.state_id } });
  assert.ok(blocked.error, JSON.stringify(blocked));
  assert.match(blocked.error.message, /^CONTROL_BUSY:/);
  assert.match(blocked.error.message, new RegExp(`pid ${first.child.pid}`));

  await closeBridge(first);
  // The takeover process has to observe again: a state handle names one
  // observation and it never crosses a process boundary.
  const takeover = await observe(second);
  const afterRelease = await second.request('tools/call', { name: 'click', arguments: { x: 3, y: 3, state_id: takeover.state_id } });
  assert.ok(afterRelease.result, JSON.stringify(afterRelease));
  assert.equal(await closeBridge(second), 0);
});

test('the screenshot tool returns a cropped capture with a state handle', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-screenshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const png = encodePng({ width: 8, height: 6, pixels: Buffer.alloc(8 * 6 * 4, 120) });
  await writeFakeConfig(directory, {
    tools: toolCatalog,
    scenario: {
      get_desktop_state: { result: { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] } },
    },
  });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const capture = await bridge.request('tools/call', { name: 'computer_use_screenshot', arguments: { region: { x: 1, y: 1, width: 4, height: 3 } } });
  assert.ok(capture.result, JSON.stringify(capture));
  const image = capture.result.content.find((block) => block.type === 'image');
  assert.ok(image, JSON.stringify(capture.result.content));
  assert.equal(image.mimeType, 'image/png');
  const summary = JSON.parse(capture.result.content.find((block) => block.type === 'text').text);
  assert.equal(summary.width, 4);
  assert.equal(summary.height, 3);
  assert.equal(summary.cropped, true);
  assert.equal(summary.cached, false);
  assert.match(summary.state_id, /^st_[0-9a-f]{8}$/);
  assert.equal(await closeBridge(bridge), 0);
});

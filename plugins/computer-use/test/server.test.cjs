'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, writeFile, readFile, rm, copyFile, link } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const pluginRoot = path.resolve(__dirname, '..');
const server = path.join(pluginRoot, 'server.cjs');
const fakeDriver = path.join(pluginRoot, 'test', 'helpers', 'fake-driver.cjs');

const toolCatalog = [
  'get_guide', 'click', 'set_value', 'get_desktop_state', 'get_window_state', 'list_windows',
];
const windowScenario = {
  get_desktop_state: {
    result: {
      content: [{ type: 'text', text: JSON.stringify({
        windows: [
          { window_id: 1, pid: 101, title: 'Blocked App', process_name: 'blocked.exe' },
          { window_id: 2, pid: 202, title: 'Allowed App', process_name: 'allowed.exe' },
        ],
        active_window_id: 1,
      }) }],
    },
  },
  list_windows: {
    result: {
      content: [{ type: 'text', text: JSON.stringify({
        windows: [
          { window_id: 1, pid: 101, title: 'Blocked App', process_name: 'blocked.exe' },
          { window_id: 2, pid: 202, title: 'Allowed App', process_name: 'allowed.exe' },
        ],
      }) }],
    },
  },
  get_window_state: {
    result: {
      structuredContent: { snapshot_id: 's12345678', window_title: 'Allowed App', app_name: 'allowed.exe' },
      content: [{ type: 'text', text: 'window snapshot s12345678' }],
    },
  },
};

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

test('uses the configured driver, filters tools, and limits the child environment', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog, scenario: windowScenario });
  const bridge = startBridge(driverEnv(directory, {
    CUA_DRIVER_PERMISSION_MODE: 'standard',
    COMPUTER_USE_TEST_SECRET: 'must-not-reach-driver',
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });

  await connect(bridge);
  const catalog = await bridge.request('tools/list');
  assert.deepEqual(catalog.result.tools.map((tool) => tool.name), [...toolCatalog, 'computer_use_revoke', 'computer_use_status']);

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
    FAKE_DRIVER_TOOLS: JSON.stringify(toolCatalog),
    PATH: `${directory}${path.delimiter}${process.env.PATH || ''}`,
  });
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });

  await connect(bridge);
  const catalog = await bridge.request('tools/list');
  assert.deepEqual(catalog.result.tools.map((tool) => tool.name), [...toolCatalog, 'computer_use_revoke', 'computer_use_status']);
  assert.equal(await closeBridge(bridge), 0);
});

test('local revoke control denies writes and app policy errors fail closed', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-revoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog, scenario: windowScenario });
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

test('app guard uses observed active identity and only permits an observed requested window', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog, scenario: windowScenario });
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
  assert.equal(JSON.parse(observedTarget.result.content[0].text).name, 'set_value');
  const forgedWindow = await bridge.request('tools/call', { name: 'set_value', arguments: { window_id: 999, title: 'Allowed App', value: 'safe' } });
  assert.match(forgedWindow.error.message, /fresh, observed target window identity/);
  await bridge.request('tools/call', { name: 'get_window_state', arguments: { pid: 202, window_id: 2 } });
  const conflictingElementTarget = await bridge.request('tools/call', { name: 'set_value', arguments: { element_token: 's12345678:1', target: { kind: 'window', pid: 101, window_id: 1 }, value: 'safe' } });
  assert.match(conflictingElementTarget.error.message, /disagree/);
  const elementTarget = await bridge.request('tools/call', { name: 'set_value', arguments: { element_token: 's12345678:1', value: 'safe' } });
  assert.equal(JSON.parse(elementTarget.result.content[0].text).name, 'set_value');
  assert.equal(await closeBridge(bridge), 0);
});

test('revoke ledger is shared across separate plugin MCP processes', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-shared-revoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog, scenario: windowScenario });
  const sharedEnv = { ...process.env, ...driverEnv(directory), DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data') };
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
  const status = await bridge.request('tools/call', { name: 'computer_use_status' });
  assert.ok(status.error || status.result);
});

test('a failing driver call is reported and recorded in the audit log', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-call-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditPath = path.join(directory, 'audit.jsonl');
  await writeFakeConfig(directory, {
    tools: toolCatalog,
    scenario: { ...windowScenario, click: { error: 'driver refused the click' } },
  });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_AUDIT_PATH: auditPath,
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const failed = await bridge.request('tools/call', { name: 'click', arguments: { x: 1, y: 2 } });
  assert.ok(failed.error, JSON.stringify(failed));
  assert.match(failed.error.message, /driver refused the click/);

  await new Promise((resolve) => setTimeout(resolve, 300));
  const lines = (await readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const entry = lines.find((item) => item.action === 'click');
  assert.ok(entry, JSON.stringify(lines));
  assert.equal(entry.ok, false);
  assert.equal(entry.errorCode, 'DRIVER_ERROR');
  assert.equal(await closeBridge(bridge), 0);
});

test('revocation blocks write tools while read tools stay available', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-revoke-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog, scenario: windowScenario });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_AUDIT_PATH: path.join(directory, 'audit.jsonl'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'allow' }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  await bridge.request('tools/call', { name: 'computer_use_revoke', arguments: { duration_seconds: 60 } });
  const denied = await bridge.request('tools/call', { name: 'click', arguments: { x: 1, y: 2 } });
  assert.match(denied.error.message, /revoked/);
  const observation = await bridge.request('tools/call', { name: 'get_desktop_state', arguments: {} });
  assert.ok(observation.result, JSON.stringify(observation));
  assert.match(observation.result.content[0].text, /Blocked App/);
  assert.equal(await closeBridge(bridge), 0);
});

test('an unwritable audit log degrades instead of failing the tool call', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-audit-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blocker = path.join(directory, 'audit-file');
  await writeFile(blocker, 'not a directory', 'utf8');
  await writeFakeConfig(directory, { tools: toolCatalog, scenario: windowScenario });
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
  await writeFakeConfig(directory, {
    tools: toolCatalog,
    scenario: windowScenario,
    exitAfterCalls: 1,
  });
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
  const bridge = startBridge(driverEnv(directory, {
    COMPUTER_USE_MIN_DRIVER_VERSION: '0.38.0',
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });

  const failed = await bridge.request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  assert.ok(failed.error, JSON.stringify(failed));
  assert.match(failed.error.message, /0\.30\.0/);
  assert.match(failed.error.message, /0\.38\.0/);
});

test('an element reference that no observation backs is refused', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-stale-token-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog, scenario: windowScenario });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'deny', allowed_apps: ['allowed.exe'] }),
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  const unknownToken = await bridge.request('tools/call', { name: 'set_value', arguments: { element_token: 'sdeadbeef:1', value: 'safe' } });
  assert.ok(unknownToken.error, JSON.stringify(unknownToken));
  assert.match(unknownToken.error.message, /stale or unknown/);
  assert.equal(await closeBridge(bridge), 0);
});

test('a burst of writes reuses one observation instead of recapturing the desktop', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-observation-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFakeConfig(directory, { tools: toolCatalog, scenario: windowScenario });
  const bridge = startBridge(driverEnv(directory, {
    DUYA_PLUGIN_DATA: path.join(directory, 'plugin-data'),
    COMPUTER_USE_ACCESS_POLICY: JSON.stringify({ default_access: 'deny', allowed_apps: ['allowed.exe'] }),
    COMPUTER_USE_OBSERVATION_TTL_MS: '60000',
  }));
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });
  await connect(bridge);

  for (let index = 0; index < 3; index++) {
    const write = await bridge.request('tools/call', { name: 'set_value', arguments: { window_id: 2, value: `value-${index}` } });
    assert.ok(write.result, JSON.stringify(write));
  }
  assert.equal(await closeBridge(bridge), 0);
});

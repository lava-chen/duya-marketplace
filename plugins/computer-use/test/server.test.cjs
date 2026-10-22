'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, chmod, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const server = path.resolve(__dirname, '..', 'server.cjs');
const fakeDriverSource = `#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') {
    result = { protocolVersion: request.params.protocolVersion, capabilities: {}, serverInfo: { name: 'fake-cua', version: '1' } };
  } else if (request.method === 'tools/list') {
    result = { tools: [
      { name: 'get_guide', description: 'Read the guide', inputSchema: { type: 'object' } },
      { name: 'click', description: 'Click', inputSchema: { type: 'object' } },
      { name: 'terminate_process', description: 'Not allowed', inputSchema: { type: 'object' } }
    ] };
  } else if (request.method === 'tools/call') {
    result = { content: [{ type: 'text', text: JSON.stringify({
      name: request.params.name,
      arguments: request.params.arguments,
      secretPassed: process.env.COMPUTER_USE_TEST_SECRET !== undefined,
      mode: process.env.CUA_DRIVER_PERMISSION_MODE
    }) }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`;

async function makeDriver(directory, executableName = 'fake-cua-driver') {
  const file = path.join(directory, executableName);
  await writeFile(file, fakeDriverSource, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
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
    request(method, params = {}) {
      const requestId = ++id;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Timed out waiting for ${method}; stderr: ${stderr}`));
        }, 3000);
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
}

test('uses the configured driver, filters tools, and limits the child environment', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const driverPath = await makeDriver(directory);
  const bridge = startBridge({
    ...process.env,
    CUA_DRIVER_PATH: driverPath,
    CUA_DRIVER_PERMISSION_MODE: 'standard',
    COMPUTER_USE_TEST_SECRET: 'must-not-reach-driver',
  });
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });

  await connect(bridge);
  const catalog = await bridge.request('tools/list');
  assert.deepEqual(catalog.result.tools.map((tool) => tool.name), ['get_guide', 'click', 'computer_use_revoke', 'computer_use_status']);

  const result = await bridge.request('tools/call', { name: 'get_guide', arguments: { topic: 'permissions' } });
  const payload = JSON.parse(result.result.content[0].text);
  assert.equal(payload.name, 'get_guide');
  assert.deepEqual(payload.arguments, { topic: 'permissions' });
  assert.equal(payload.secretPassed, false);
  assert.equal(payload.mode, 'standard');

  const denied = await bridge.request('tools/call', { name: 'terminate_process', arguments: {} });
  assert.match(denied.error.message, /unavailable/);
  bridge.child.stdin.end();
  const [code] = await once(bridge.child, 'exit');
  assert.equal(code, 0);
});

test('discovers cua-driver from PATH when setup path is empty', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await makeDriver(directory, 'cua-driver');
  const bridge = startBridge({
    ...process.env,
    CUA_DRIVER_PATH: '',
    PATH: `${directory}${path.delimiter}${process.env.PATH || ''}`,
  });
  t.after(() => { if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL'); });

  await connect(bridge);
  const catalog = await bridge.request('tools/list');
  assert.deepEqual(catalog.result.tools.map((tool) => tool.name), ['get_guide', 'click', 'computer_use_revoke', 'computer_use_status']);
  bridge.child.stdin.end();
  const [code] = await once(bridge.child, 'exit');
  assert.equal(code, 0);
});

test('local revoke control denies writes and app policy errors fail closed', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-revoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const driverPath = await makeDriver(directory);
  const bridge = startBridge({
    ...process.env,
    CUA_DRIVER_PATH: driverPath,
    COMPUTER_USE_AUDIT_PATH: path.join(directory, 'audit.jsonl'),
    COMPUTER_USE_ACCESS_POLICY: '{bad json',
  });
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
  bridge.child.stdin.end();
  const [code] = await once(bridge.child, 'exit');
  assert.equal(code, 0);
});

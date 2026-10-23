'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { after, before, test } = require('node:test');

const pluginRoot = path.resolve(__dirname, '..');
const serverPath = path.join(pluginRoot, 'server.cjs');
let bridgePort;
let nodeModulesDir;
let fixtureRoot;
let fakeChromiumPath;
let managedCdpLogPath;
const systemTabs = [{ id: 72, url: 'https://openai.com', title: 'OpenAI', active: true }];
const attachedSystemTabs = new Set();
const browserCommands = [];
let mcp;
let mcpBuffer = '';
let pending = new Map();
let nextId = 1;
let extensionSocket;

function maskedFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

async function connectMockExtension(port) {
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  let socket;
  for (let attempt = 0; attempt < 40; attempt++) {
    socket = net.connect(port, '127.0.0.1');
    try {
      await once(socket, 'connect');
      break;
    } catch (error) {
      socket.destroy();
      if (error.code !== 'ECONNREFUSED' || attempt === 39) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  socket.write([
    'GET /ext HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13',
    `Origin: chrome-extension://${id}`, '', '',
  ].join('\r\n'));
  let buffer = Buffer.alloc(0);
  const messageWaiters = [];
  let ready;
  const connected = new Promise((resolve, reject) => { ready = { resolve, reject }; });
  let upgraded = false;
  const send = (message) => socket.write(maskedFrame(message));
  const handleMessage = (message) => {
    const waiter = messageWaiters.shift();
    if (waiter) waiter(message);
    if (!message?.id) return;
    browserCommands.push(message);
    let data = {};
    if (message.action === 'tabs' && message.op === 'available') data = systemTabs;
    else if (message.action === 'tabs' && message.op === 'attach') {
      attachedSystemTabs.add(message.tabId);
      data = systemTabs.find((item) => item.id === message.tabId);
    } else if (message.action === 'tabs' && message.op === 'select') data = systemTabs.find((item) => item.id === message.tabId);
    else if (message.action === 'tabs' && message.op === 'list') data = systemTabs.filter((tab) => attachedSystemTabs.has(tab.id));
    else if (message.action === 'evaluate') {
      const tab = systemTabs.find((item) => item.id === message.tabId) ?? systemTabs[0];
      data = { url: tab.url, title: tab.title, text: tab.title, elements: [] };
    }
    send({ id: message.id, ok: true, data });
  };
  const consume = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const boundary = buffer.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const headers = buffer.subarray(0, boundary).toString('utf8');
      if (!headers.startsWith('HTTP/1.1 101')) return ready.reject(new Error(`Mock extension upgrade failed: ${headers}`));
      buffer = buffer.subarray(boundary + 4);
      upgraded = true;
      ready.resolve();
    }
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x1) handleMessage(JSON.parse(payload.toString('utf8')));
    }
  };
  socket.on('data', consume);
  socket.once('error', (error) => ready.reject(error));
  await connected;
  const waitMessage = () => new Promise((resolve) => messageWaiters.push(resolve));
  send({ type: 'hello', name: 'DUYA Browser Bridge', version: '1.5.9', extensionId: id });
  assert.deepEqual(await waitMessage(), { type: 'hello_ack', ok: true });
  return socket;
}

async function freeTcpPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function createFakeChromium(root) {
  const scriptPath = path.join(root, 'fake-cdp.cjs');
  const launcherPath = path.join(root, 'fake-chromium');
  managedCdpLogPath = path.join(root, 'managed-cdp.jsonl');
  const script = `
const fs = require('node:fs');
const input = fs.createReadStream(null, { fd: 3 });
let buffer = '';
const urls = new Map([['session-target-0', 'about:blank']]);
function write(value) { fs.writeSync(4, JSON.stringify(value) + '\\0'); }
input.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let split;
  while ((split = buffer.indexOf('\\0')) !== -1) {
    const raw = buffer.slice(0, split);
    buffer = buffer.slice(split + 1);
    if (!raw) continue;
    const command = JSON.parse(raw);
    fs.appendFileSync(${JSON.stringify(managedCdpLogPath)}, JSON.stringify(command) + '\\n');
    const result = (value = {}) => write({ id: command.id, result: value });
    if (command.method === 'Target.getTargets') {
      result({ targetInfos: [{ targetId: 'target-0', type: 'page', url: 'about:blank' }] });
    } else if (command.method === 'Target.createTarget') {
      result({ targetId: 'target-' + Date.now() });
    } else if (command.method === 'Target.attachToTarget') {
      const sessionId = 'session-' + command.params.targetId;
      urls.set(sessionId, 'about:blank');
      result({ sessionId });
    } else if (command.method === 'Page.navigate') {
      const url = command.params.url;
      urls.set(command.sessionId, url);
      result({ frameId: 'main-frame' });
      setTimeout(() => write({ method: 'Page.loadEventFired', sessionId: command.sessionId, params: { timestamp: Date.now() } }), 5);
    } else if (command.method === 'Runtime.evaluate') {
      const url = urls.get(command.sessionId) || 'about:blank';
      const title = url === 'about:blank' ? '' : 'Example Domain';
      const value = command.params.expression.includes('document.body?.innerText')
        ? { url, title, text: title || '', elements: [] }
        : { url, title };
      result({ result: { type: 'object', value } });
    } else if (command.method === 'Page.getNavigationHistory') {
      result({ currentIndex: 0, entries: [] });
    } else if (command.method === 'Page.captureScreenshot') {
      result({ data: Buffer.from('png').toString('base64') });
    } else if (command.method === 'Target.closeTarget') {
      result({ success: true });
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
  fs.writeFileSync(launcherPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}\n`, { mode: 0o700 });
  fs.chmodSync(launcherPath, 0o700);
  return launcherPath;
}

before(async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-cua-repl-'));
  nodeModulesDir = path.join(fixtureRoot, 'node_modules');
  const fixtureDir = path.join(nodeModulesDir, 'cua-fixture');
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'index.js'), 'module.exports = { answer: 42 };\n');
  fakeChromiumPath = createFakeChromium(fixtureRoot);
  bridgePort = await freeTcpPort();
  mcp = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      DUYA_BROWSER_EXECUTABLE: fakeChromiumPath,
      DUYA_PLUGIN_DATA: path.join(fixtureRoot, 'plugin-data'),
      DUYA_BROWSER_BRIDGE_PORT: String(bridgePort),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  mcp.stdout.setEncoding('utf8');
  mcp.stdout.on('data', (chunk) => {
    mcpBuffer += chunk;
    while (true) {
      const newline = mcpBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = mcpBuffer.slice(0, newline).trim();
      mcpBuffer = mcpBuffer.slice(newline + 1);
      if (!line) continue;
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (waiter) {
        pending.delete(response.id);
        waiter.resolve(response);
      }
    }
  });
  extensionSocket = await connectMockExtension(bridgePort);
});

after(async () => {
  extensionSocket?.destroy();
  if (mcp && mcp.exitCode === null) {
    mcp.stdin.end();
    await once(mcp, 'exit');
  }
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timed out: ${method}`));
    }, 5000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
    });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function js(code) {
  const response = await rpc('tools/call', { name: 'js', arguments: { code } });
  return response.result;
}

test('exposes the three CUA REPL tools and the documented initialization sequence', async () => {
  const initialized = await rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.result.serverInfo.name, 'duya-browser-cua-repl');

  const listed = await rpc('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['js', 'js_add_node_module_dir', 'js_reset']);
  assert.deepEqual(listed.result.tools[0].inputSchema.required, ['code']);
  assert.equal(listed.result.tools[0].inputSchema.properties.timeout_ms.type, 'integer');

  const blocked = await js('1 + 1');
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /first js call must contain only await cua\.getApiDocs/);

  const docs = await js('await cua.getApiDocs()');
  assert.match(docs.content[0].text, /Browser CUA API v1/);

  const state = await js('await cua.getState()');
  assert.match(state.content[0].text, /about:blank/);
  const sameCallAction = await js('await cua.getState(); await cua.browser.navigate("https://blocked.example")');
  assert.equal(sameCallAction.isError, true);
  assert.match(sameCallAction.content[0].text, /only await cua\.getState\(\)/);
});

test('keeps JavaScript bindings and browser state across calls, and reset only clears the REPL', async () => {
  const navigated = await js('await cua.browser.navigate("https://example.com"); const answer = 6 * 7; answer');
  assert.match(navigated.content[0].text, /42/);

  const persisted = await js('answer + " " + (await cua.browser.snapshot()).url');
  assert.match(persisted.content[0].text, /https:\/\/example\.com/);
  const screenshot = await js('await cua.browser.screenshot()');
  assert.equal(screenshot.content[0].type, 'image');
  assert.equal(screenshot.content[0].mimeType, 'image/png');

  const reset = await rpc('tools/call', { name: 'js_reset', arguments: {} });
  assert.match(reset.result.content[0].text, /browser state were preserved/);
  const blocked = await js('1 + 1');
  assert.equal(blocked.isError, true);

  const docs = await js('await cua.getApiDocs()');
  assert.match(docs.content[0].text, /Browser CUA API v1/);
  const state = await js('await cua.getState()');
  assert.match(state.content[0].text, /https:\/\/example\.com/);
});

test('selects an existing Chrome tab by ID and attaches it to the CUA session', async () => {
  const selected = await js('await cua.browser.selectTarget({browser:"Chrome", tabId:72})');
  assert.match(selected.content[0].text, /https:\/\/openai\.com/);
  assert.ok(browserCommands.some((command) => command.action === 'tabs' && command.op === 'attach' && command.tabId === 72));
  assert.ok(browserCommands.some((command) => command.action === 'tabs' && command.op === 'select' && command.tabId === 72));
  const beforeState = await js('await cua.browser.navigate("https://blocked.example")');
  assert.equal(beforeState.isError, true);
  assert.match(beforeState.content[0].text, /getState\(\) in a separate js call/);
  const state = await js('await cua.getState()');
  assert.match(state.content[0].text, /https:\/\/openai\.com/);
});

test('opens and closes isolated Managed Chromium tabs by CUA tab ID', async () => {
  const selected = await js('await cua.browser.selectTarget({browser:"Managed Chromium"})');
  assert.match(selected.content[0].text, /Managed Chromium/);
  await js('await cua.getState()');
  const opened = await js('await cua.browser.newTab("https://second.example")');
  assert.match(opened.content[0].text, /tab_1/);
  await js('await cua.getState()');
  const listed = await js('(await cua.browser.tabs()).map(tab => tab.id).join(",")');
  assert.match(listed.content[0].text, /tab_0,tab_1/);
  const closed = await js('await cua.browser.closeTab("tab_1")');
  assert.match(closed.content[0].text, /tab_1/);
  const commands = fs.readFileSync(managedCdpLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(commands.some((command) => command.method === 'Target.closeTarget'));
});

test('adds an absolute node_modules directory to persistent REPL require lookup', async () => {
  const added = await rpc('tools/call', { name: 'js_add_node_module_dir', arguments: { path: nodeModulesDir } });
  assert.match(added.result.content[0].text, /Added node module directory/);
  const loaded = await js('const fixtureModule = require("cua-fixture"); fixtureModule.answer');
  assert.match(loaded.content[0].text, /42/);
});

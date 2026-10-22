'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { after, before, test } = require('node:test');

const pluginRoot = path.resolve(__dirname, '..');
const serverPath = path.join(pluginRoot, 'server.cjs');
let browserServer;
let browserPort;
let browserUrl = 'about:blank';
let nodeModulesDir;
const systemTabs = [{ id: 72, url: 'https://openai.com', title: 'OpenAI', active: true }];
const attachedSystemTabs = new Set();
const browserCommands = [];
const closedWebviewSessions = [];
let mcp;
let mcpBuffer = '';
let pending = new Map();
let nextId = 1;

before(async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-cua-repl-'));
  nodeModulesDir = path.join(tempRoot, 'node_modules');
  const fixtureDir = path.join(nodeModulesDir, 'cua-fixture');
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'index.js'), 'module.exports = { answer: 42 };\n');
  browserServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const respond = (data, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url === '/ping') return respond({ ok: true, extensionConnected: true });
    if (req.url === '/webview-wait-load') return respond({ ok: true });
    if (req.url === '/webview-close') {
      closedWebviewSessions.push(body.sessionId);
      return respond({ ok: true });
    }
    if (req.url === '/command') {
      browserCommands.push(body);
      if (body.action === 'tabs' && body.op === 'available') return respond({ ok: true, data: systemTabs });
      if (body.action === 'tabs' && body.op === 'attach') {
        attachedSystemTabs.add(body.tabId);
        const tab = systemTabs.find((item) => item.id === body.tabId);
        return respond({ ok: true, data: tab });
      }
      if (body.action === 'tabs' && body.op === 'select') {
        const tab = systemTabs.find((item) => item.id === body.tabId);
        return respond({ ok: true, data: tab });
      }
      if (body.action === 'tabs' && body.op === 'list') {
        return respond({ ok: true, data: systemTabs.filter((tab) => attachedSystemTabs.has(tab.id)) });
      }
      if (body.action === 'evaluate') {
        const tab = systemTabs.find((item) => item.id === body.tabId) ?? systemTabs[0];
        return respond({ ok: true, data: { url: tab.url, title: tab.title, text: tab.title, elements: [] } });
      }
      return respond({ ok: true, data: {} });
    }
    if (req.url === '/webview-command') {
      if (body.method === 'Page.navigate') {
        browserUrl = body.params.url;
        return respond({ id: body.id, ok: true, result: { frameId: 'main-frame' } });
      }
      if (body.method === 'Page.getNavigationHistory') {
        return respond({ id: body.id, ok: true, result: { currentIndex: 0, entries: [] } });
      }
      if (body.method === 'Runtime.evaluate') {
        const value = body.params.expression.includes('document.body?.innerText')
          ? { url: browserUrl, title: browserUrl === 'about:blank' ? '' : 'Example Domain', text: 'Example Domain', elements: [] }
          : { url: browserUrl, title: browserUrl === 'about:blank' ? '' : 'Example Domain' };
        return respond({ id: body.id, ok: true, result: { result: { value } } });
      }
      if (body.method === 'Page.captureScreenshot') {
        return respond({ id: body.id, ok: true, result: { data: Buffer.from('png').toString('base64') } });
      }
      return respond({ id: body.id, ok: true, result: {} });
    }
    return respond({ error: 'unexpected route' }, 404);
  });
  browserServer.listen(0, '127.0.0.1');
  await once(browserServer, 'listening');
  browserPort = browserServer.address().port;
  mcp = spawn(process.execPath, [serverPath], {
    env: { ...process.env, DUYA_CUA_DAEMON_PORT: String(browserPort) },
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
});

after(async () => {
  mcp?.kill();
  if (browserServer) await new Promise((resolve) => browserServer.close(resolve));
  if (nodeModulesDir) fs.rmSync(path.dirname(nodeModulesDir), { recursive: true, force: true });
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
  assert.match(docs.content[0].text, /DUYA CUA API v1/);

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
  assert.match(docs.content[0].text, /DUYA CUA API v1/);
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

test('opens and closes isolated DUYA webview tabs by CUA tab ID', async () => {
  await js('await cua.browser.selectTarget({browser:"DUYA"})');
  await js('await cua.getState()');
  const opened = await js('await cua.browser.newTab("https://second.example")');
  assert.match(opened.content[0].text, /tab_1/);
  await js('await cua.getState()');
  const listed = await js('(await cua.browser.tabs()).map(tab => tab.id).join(",")');
  assert.match(listed.content[0].text, /tab_0,tab_1/);
  const closed = await js('await cua.browser.closeTab("tab_1")');
  assert.match(closed.content[0].text, /tab_1/);
  assert.ok(closedWebviewSessions.some((id) => id.endsWith('::tab_1')));
});

test('adds an absolute node_modules directory to persistent REPL require lookup', async () => {
  const added = await rpc('tools/call', { name: 'js_add_node_module_dir', arguments: { path: nodeModulesDir } });
  assert.match(added.result.content[0].text, /Added node module directory/);
  const loaded = await js('const fixtureModule = require("cua-fixture"); fixtureModule.answer');
  assert.match(loaded.content[0].text, /42/);
});

#!/usr/bin/env node
'use strict';

const os = require('node:os');
const path = require('node:path');
const { createManagedBrowser } = require('./managed-browser.cjs');
const { createLinkSnapshotTool } = require('./link-snapshot.cjs');

const storePath = path.resolve(process.env.DUYA_CANVAS_STORE || path.join(os.homedir(), '.duya', 'plugins', 'conductor-canvas', 'canvases.json'));
const browser = createManagedBrowser({
  dataPath: path.dirname(storePath),
  executablePath: process.env.DUYA_BROWSER_EXECUTABLE || process.env.CHROME_BIN,
  timeoutMs: 20_000,
});
const capture = createLinkSnapshotTool({ browser, assetDir: path.join(path.dirname(storePath), 'assets') });
const tool = {
  name: 'canvas_link_snapshot',
  description: 'Capture an external URL in isolated plugin-owned Chromium and save the JPEG in Canvas assets.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      mode: { type: 'string', enum: ['desktop-head', 'desktop-full', 'mobile-head', 'mobile-full'] },
    },
    required: ['url', 'mode'],
    additionalProperties: false,
  },
};

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function errorResponse(id, error) { return { jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }; }

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || message.id === undefined) return null;
  try {
    if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'conductor_canvas_snapshot', version: '0.1.0' } } };
    if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} };
    if (message.method === 'tools/list') return { jsonrpc: '2.0', id: message.id, result: { tools: [tool] } };
    if (message.method === 'tools/call') {
      if (message.params?.name !== tool.name) throw new Error(`Unknown Canvas snapshot tool: ${message.params?.name}`);
      try { return { jsonrpc: '2.0', id: message.id, result: textResult(await capture(message.params?.arguments || {})) }; }
      catch (error) { return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: error.message || String(error) }], isError: true } }; }
    }
    throw new Error(`Unsupported MCP method: ${message.method}`);
  } catch (error) { return errorResponse(message.id, error); }
}

let input = '';
let queue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  while (true) {
    const index = input.indexOf('\n');
    if (index < 0) break;
    const line = input.slice(0, index);
    input = input.slice(index + 1);
    if (!line.trim()) continue;
    queue = queue.then(async () => {
      try { const response = await handle(JSON.parse(line)); if (response) send(response); }
      catch (error) { send(errorResponse(null, error)); }
    });
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void browser.close().finally(() => process.exit(0)); });
}

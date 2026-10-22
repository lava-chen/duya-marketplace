'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function startServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], {
    env: { ...process.env, DUYA_CANVAS_STORE: path.join(root, 'canvases.json'), DUYA_PLUGIN_DATA: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let pending = '';
  const responses = new Map();
  const waiters = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    for (;;) {
      const index = pending.indexOf('\n');
      if (index < 0) break;
      const line = pending.slice(0, index); pending = pending.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const resolve = waiters.get(message.id);
      if (resolve) { waiters.delete(message.id); resolve(message); }
      else responses.set(message.id, message);
    }
  });
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { waiters.delete(requestId); reject(new Error(`MCP request timed out: ${method}`)); }, 3000);
    waiters.set(requestId, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const response = await request('tools/call', { name, arguments: args });
    if (response.error) throw new Error(response.error.message);
    if (response.result?.isError) throw new Error(response.result.content?.[0]?.text || 'tool failed');
    return response.result.structuredContent;
  };
  return { request, call };
}

test('native Conductor actions preserve endpoint references, metadata, and freeform positions', async (t) => {
  const mcp = startServer(t);
  const canvas = (await mcp.call('canvas_create', { name: 'Domain model' })).canvas;
  const first = await mcp.call('canvas_execute_action', { action: {
    action: 'element.create_native', canvasId: canvas.id, nodeType: 'database',
    position: { x: -12.5, y: 8.25, w: 22.5, h: 15.75, zIndex: 4, rotation: 17 },
    content: { title: 'Records' }, style: { color: '#123456' },
  } });
  const second = await mcp.call('canvas_execute_action', { action: {
    action: 'element.create_native', canvasId: canvas.id, nodeType: 'text',
    position: { x: 40, y: -3, w: 8, h: 4, zIndex: 5, rotation: 0 }, content: { text: 'Consumer' },
  } });
  const endpoint = { kind: 'bound', nodeId: first.result.element.id, bindingPoint: { u: 0.25, v: 0.75 } };
  const connected = await mcp.call('canvas_execute_action', { action: {
    action: 'connector.create', canvasId: canvas.id, source: endpoint,
    target: { kind: 'free', point: { x: 55, y: 9 } }, routingMode: 'curve', curvature: 0.45,
    strokeStyle: 'dotted', lineWidth: 2, color: '#abcdef', startMarker: 'circle', endMarker: 'arrow',
  } });
  const snapshot = connected.snapshot;
  assert.deepEqual(snapshot.elements[0].position, { x: -12.5, y: 8.25, w: 22.5, h: 15.75, zIndex: 4, rotation: 17 });
  assert.equal(snapshot.elements[0].elementKind, 'native/database');
  assert.equal(snapshot.elements[0].config.style.color, '#123456');
  assert.equal(snapshot.elements[1].id, second.result.element.id);
  assert.deepEqual(snapshot.elements[2].config.source, endpoint);
  assert.equal(snapshot.elements[2].config.routingMode, 'curve');
});

test('legacy bundle assets are imported into plugin storage and references are remapped', async (t) => {
  const mcp = startServer(t);
  const bytes = Buffer.from('canvas attachment');
  const imported = await mcp.call('canvas_import_bundle', { bundle: {
    format: 'duya.conductor-legacy-bundle', version: 1, groups: [],
    canvases: [{ canvas: { id: 'old-canvas', name: 'Archive' }, elements: [{
      id: 'old-element', canvasId: 'old-canvas', elementKind: 'native/file', native_kind: 'file',
      type: 'file', position: { x: -2, y: 3, w: 9, h: 4, zIndex: 7, rotation: 0 },
      config: { assetId: 'legacy-asset', mimeType: 'text/plain' },
      metadata: { tag: 'imported', owner: 'user' }, state: 'idle', dataVersion: 4,
      permissions: { agentCanRead: true, agentCanWrite: false, agentCanDelete: true },
      createdAt: 123, updatedAt: 456,
    }], widgets: [] }],
    assets: [{ assetId: 'legacy-asset', name: 'note.txt', mimeType: 'text/plain', base64: bytes.toString('base64') }],
  } });
  assert.equal(imported.importedAssets, 1);
  const snapshot = await mcp.call('canvas_get_snapshot', { canvasId: imported.currentCanvasId });
  const element = snapshot.elements[0];
  assert.equal(element.elementKind, 'native/file');
  assert.equal(element.native_kind, 'file');
  assert.equal(element.metadata.owner, 'user');
  assert.equal(element.dataVersion, 4);
  assert.equal(element.legacy.createdAt, 123);
  assert.notEqual(element.config.assetId, 'legacy-asset');
  const asset = await mcp.call('canvas_asset_get', { assetId: element.config.assetId });
  assert.equal(Buffer.from(asset.base64, 'base64').toString(), bytes.toString());
  const portable = await mcp.call('canvas_export', { canvasId: imported.currentCanvasId });
  assert.equal(portable.assets.length, 1);
  const roundTrip = await mcp.call('canvas_import', { snapshot: portable });
  const roundTripSnapshot = await mcp.call('canvas_get_snapshot', { canvasId: roundTrip.canvas.id });
  const roundTripAsset = await mcp.call('canvas_asset_get', { assetId: roundTripSnapshot.elements[0].config.assetId });
  assert.equal(Buffer.from(roundTripAsset.base64, 'base64').toString(), bytes.toString());
});

test('project database command contract is available through the plugin MCP server', async (t) => {
  const mcp = startServer(t);
  const projectPath = '/workspace/mcp-project';
  const created = await mcp.call('canvas_project_database', { request: { projectPath, command: { type: 'source.create', name: 'Workbench' } } });
  const sourceId = created.source.id;
  const record = await mcp.call('canvas_project_database', { request: { projectPath, command: { type: 'record.create', sourceId, title: 'Integrated' } } });
  const queried = await mcp.call('canvas_project_database', { request: { projectPath, command: { type: 'query', sourceId } } });
  assert.equal(queried.records[0].record.id, record.record.id);
});

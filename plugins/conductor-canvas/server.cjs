#!/usr/bin/env node
'use strict';

// Conductor Canvas is implemented inside this marketplace package. The MCP
// process owns its canvas data and exposes the same editing vocabulary to the
// agent and Mini App; it does not reach into DUYA's private Electron APIs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const storePath = path.resolve(process.env.DUYA_CANVAS_STORE || path.join(os.homedir(), '.duya', 'plugins', 'conductor-canvas', 'canvases.json'));
const WIDTH = 40;
const HEIGHT = 30;
const MAX_CANVASES = 500;
const MAX_ELEMENTS = 5000;
const lockPath = `${storePath}.lock`;

// The agent and a Mini App may each run their own MCP process. Keep the
// read/modify/write transaction under one cross-process lock so an edit from
// either process cannot silently overwrite the other's newer snapshot.
async function withStoreLock(action) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const deadline = Date.now() + 15_000;
  let fd;
  while (fd === undefined) {
    try {
      const opened = fs.openSync(lockPath, 'wx', 0o600);
      try { fs.writeSync(opened, String(process.pid)); fd = opened; }
      catch (writeError) { fs.closeSync(opened); fs.unlinkSync(lockPath); throw writeError; }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 60_000) {
          const pid = Number(fs.readFileSync(lockPath, 'utf8'));
          let alive = Number.isSafeInteger(pid) && pid > 0;
          if (alive) {
            try { process.kill(pid, 0); }
            catch (probeError) { alive = probeError.code !== 'ESRCH'; }
          }
          if (!alive) { fs.unlinkSync(lockPath); continue; }
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      if (Date.now() >= deadline) fail('Canvas store is busy. Retry the operation.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await action(); }
  finally {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  }
}

function readStore() {
  try {
    const value = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (value && Array.isArray(value.canvases)) return { groups: [], ...value };
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  return { version: 1, currentCanvasId: null, canvases: [], groups: [] };
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const temp = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temp, storePath);
}

function now() { return new Date().toISOString(); }
function text(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; }
function fail(message) { throw new Error(message); }
function canvasById(store, canvasId) {
  const id = typeof canvasId === 'string' && canvasId ? canvasId : store.currentCanvasId;
  if (!id) fail('No canvas is selected. Use canvas_manage list or create first.');
  const canvas = store.canvases.find((item) => item.id === id);
  if (!canvas) fail(`Canvas not found: ${id}`);
  return canvas;
}
function elementById(canvas, elementId) {
  const element = canvas.elements.find((item) => item.id === elementId);
  if (!element) fail(`Element not found: ${elementId}`);
  return element;
}
function finite(value, name, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) fail(`${name} must be a finite number.`);
  return number;
}
function clampPosition(position) {
  const w = Math.max(1, Math.min(WIDTH, finite(position.w, 'w', 5)));
  const h = Math.max(1, Math.min(HEIGHT, finite(position.h, 'h', 3)));
  return {
    x: Math.max(0, Math.min(WIDTH - w, finite(position.x, 'x', 1))),
    y: Math.max(0, Math.min(HEIGHT - h, finite(position.y, 'y', 1))),
    w, h,
    zIndex: finite(position.zIndex, 'zIndex', 1),
  };
}
function summary(canvas) {
  return { id: canvas.id, name: canvas.name, description: canvas.description, updatedAt: canvas.updatedAt, elementCount: canvas.elements.length, isFavorite: canvas.isFavorite === true, tags: canvas.tags || [], groupId: canvas.groupId || null };
}
function snapshot(canvas) {
  return { canvas: { id: canvas.id, name: canvas.name, description: canvas.description, width: WIDTH, height: HEIGHT }, elements: canvas.elements, actionCursor: canvas.actionCursor };
}
function findEmpty(canvas, input) {
  const w = Math.max(1, Math.min(WIDTH, finite(input.w, 'w', 5)));
  const h = Math.max(1, Math.min(HEIGHT, finite(input.h, 'h', 3)));
  const occupied = canvas.elements.map((element) => element.position);
  const preferredX = Math.max(0, Math.min(WIDTH - w, finite(input.preferredX, 'preferredX', 1)));
  const preferredY = Math.max(0, Math.min(HEIGHT - h, finite(input.preferredY, 'preferredY', 1)));
  for (let y = preferredY; y <= HEIGHT - h; y++) {
    for (let x = preferredX; x <= WIDTH - w; x++) {
      if (!occupied.some((p) => x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y)) return { x, y, w, h };
    }
  }
  fail('No free region of the requested size remains on this canvas.');
}
function elementSummary(element) {
  const config = element.config || {};
  return { id: element.id, type: element.type, position: element.position, title: config.title || '', text: config.text || config.markdown || config.url || config.fileName || '' };
}

const string = { type: 'string' };
const number = { type: 'number' };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tools = [
  { name: 'canvas_manage', description: 'List canvases, read the selected canvas, or select a canvas.', inputSchema: object({ action: { type: 'string', enum: ['list', 'get_current', 'switch'] }, canvasId: string }, ['action']) },
  { name: 'canvas_create', description: 'Create a canvas and select it.', inputSchema: object({ name: string, description: string }) },
  { name: 'canvas_update_metadata', description: 'Update canvas favorite state, tags, and group assignment.', inputSchema: object({ canvasId: string, isFavorite: { type: 'boolean' }, tags: { type: 'array', items: string }, groupId: string }) },
  { name: 'canvas_group_list', description: 'List canvas groups.', inputSchema: object({}) },
  { name: 'canvas_group_create', description: 'Create a canvas group.', inputSchema: object({ name: string }, ['name']) },
  { name: 'canvas_group_rename', description: 'Rename a canvas group.', inputSchema: object({ groupId: string, name: string }, ['groupId', 'name']) },
  { name: 'canvas_group_delete', description: 'Delete a canvas group and unassign its canvases.', inputSchema: object({ groupId: string }, ['groupId']) },
  { name: 'canvas_rename', description: 'Rename a canvas.', inputSchema: object({ canvasId: string, name: string }, ['name']) },
  { name: 'canvas_delete', description: 'Delete a canvas and all of its elements.', inputSchema: object({ canvasId: string }, ['canvasId']) },
  { name: 'canvas_get_snapshot', description: 'Read one canvas with all positions and element content.', inputSchema: object({ canvasId: string }) },
  { name: 'canvas_export', description: 'Export a canvas snapshot as portable JSON.', inputSchema: object({ canvasId: string }) },
  { name: 'canvas_import', description: 'Import a Conductor Canvas snapshot JSON object as a new canvas.', inputSchema: object({ snapshot: { type: 'object' }, name: string }, ['snapshot']) },
  { name: 'canvas_list_elements', description: 'List elements with compact identifiers, content summaries, and positions.', inputSchema: object({ canvasId: string }) },
  { name: 'canvas_create_element', description: 'Add a shape, sticky, text, document, table, link, image, file, or widget element.', inputSchema: object({ canvasId: string, type: { type: 'string', enum: ['shape', 'sticky', 'text', 'document', 'table', 'link', 'image', 'file', 'widget'] }, position: object({ x: number, y: number, w: number, h: number }), config: { type: 'object' } }, ['type', 'position']) },
  { name: 'canvas_connect_elements', description: 'Connect two canvas elements with a labeled relationship line.', inputSchema: object({ canvasId: string, sourceId: string, targetId: string, label: string }, ['sourceId', 'targetId']) },
  { name: 'canvas_group_elements', description: 'Group selected canvas elements together.', inputSchema: object({ canvasId: string, elementIds: { type: 'array', items: string }, name: string }, ['elementIds']) },
  { name: 'canvas_ungroup_elements', description: 'Remove a group while keeping its member elements.', inputSchema: object({ canvasId: string, groupId: string }, ['groupId']) },
  { name: 'canvas_move_element', description: 'Move an element to x and y grid coordinates.', inputSchema: object({ canvasId: string, elementId: string, x: number, y: number }, ['elementId', 'x', 'y']) },
  { name: 'canvas_resize_element', description: 'Resize an element in grid units.', inputSchema: object({ canvasId: string, elementId: string, width: number, height: number }, ['elementId', 'width', 'height']) },
  { name: 'canvas_fill_content', description: 'Merge content fields into an existing element.', inputSchema: object({ canvasId: string, elementId: string, content: { type: 'object' } }, ['elementId', 'content']) },
  { name: 'canvas_style_element', description: 'Change an element color and style.', inputSchema: object({ canvasId: string, elementId: string, color: string, bgColor: string, fontSize: number, opacity: number }, ['elementId']) },
  { name: 'canvas_delete_element', description: 'Delete one element by ID.', inputSchema: object({ canvasId: string, elementId: string }, ['elementId']) },
  { name: 'canvas_undo', description: 'Undo the last element change on a canvas.', inputSchema: object({ canvasId: string }) },
  { name: 'canvas_redo', description: 'Redo the last undone element change on a canvas.', inputSchema: object({ canvasId: string }) },
  { name: 'canvas_find_empty_space', description: 'Find an open rectangle for a new element.', inputSchema: object({ canvasId: string, preferredX: number, preferredY: number, w: number, h: number }) },
  { name: 'canvas_auto_layout', description: 'Preview a compact grid layout for the current canvas.', inputSchema: object({ canvasId: string, columns: number }) },
  { name: 'canvas_apply_layout', description: 'Apply a layout preview returned by canvas_auto_layout.', inputSchema: object({ canvasId: string, positions: { type: 'array', items: object({ elementId: string, x: number, y: number }) } }, ['positions']) },
  { name: 'canvas_get_knowledge', description: 'Return usage guidance for creating readable canvas layouts.', inputSchema: object({ section: string }) },
];
const mutatingTools = new Set([
  'canvas_create_element', 'canvas_connect_elements', 'canvas_group_elements', 'canvas_ungroup_elements', 'canvas_move_element', 'canvas_resize_element',
  'canvas_fill_content', 'canvas_style_element', 'canvas_delete_element', 'canvas_apply_layout',
]);

async function callUnlocked(name, input) {
  const store = readStore();
  let result;
  if (name === 'canvas_manage') {
    switch (input.action) {
      case 'list': result = { canvases: store.canvases.map(summary), currentCanvasId: store.currentCanvasId }; break;
      case 'get_current': result = { currentCanvas: store.canvases.find((item) => item.id === store.currentCanvasId) ? summary(canvasById(store)) : null }; break;
      case 'switch': { const canvas = canvasById(store, input.canvasId); store.currentCanvasId = canvas.id; writeStore(store); result = { currentCanvas: summary(canvas), currentCanvasId: canvas.id }; break; }
      default: fail('Unsupported canvas_manage action.');
    }
  } else if (name === 'canvas_group_list') {
    result = { groups: store.groups };
  } else if (name === 'canvas_group_create') {
    const group = { id: randomUUID(), name: String(input.name || '').trim().slice(0, 80) || fail('name is required.'), createdAt: now() }; store.groups.push(group); writeStore(store); result = { group };
  } else if (name === 'canvas_group_rename') {
    const group = store.groups.find((item) => item.id === input.groupId); if (!group) fail('Group not found.'); group.name = String(input.name || '').trim().slice(0, 80) || fail('name is required.'); writeStore(store); result = { group };
  } else if (name === 'canvas_group_delete') {
    const group = store.groups.find((item) => item.id === input.groupId); if (!group) fail('Group not found.'); store.groups = store.groups.filter((item) => item.id !== group.id); store.canvases.forEach((canvas) => { if (canvas.groupId === group.id) canvas.groupId = null; }); writeStore(store); result = { deleted: group.id };
  } else if (name === 'canvas_create') {
    if (store.canvases.length >= MAX_CANVASES) fail('Canvas limit reached.');
    const canvas = { id: randomUUID(), name: String(input.name || 'Untitled canvas').trim().slice(0, 100), description: String(input.description || ''), createdAt: now(), updatedAt: now(), isFavorite: false, tags: [], groupId: null, elements: [], actionCursor: 0, undoStack: [], redoStack: [] };
    store.canvases.unshift(canvas); store.currentCanvasId = canvas.id; writeStore(store); result = { canvas: summary(canvas), currentCanvasId: canvas.id };
  } else if (name === 'canvas_rename') {
    const canvas = canvasById(store, input.canvasId); canvas.name = String(input.name || '').trim().slice(0, 100) || fail('name is required.'); canvas.updatedAt = now(); writeStore(store); result = { canvas: summary(canvas) };
  } else if (name === 'canvas_update_metadata') {
    const canvas = canvasById(store, input.canvasId);
    if (input.isFavorite !== undefined) canvas.isFavorite = input.isFavorite === true;
    if (input.tags !== undefined) canvas.tags = Array.isArray(input.tags) ? input.tags.map(String).map((tag) => tag.trim().slice(0, 40)).filter(Boolean).slice(0, 20) : [];
    if (input.groupId !== undefined) { if (input.groupId && !store.groups.some((group) => group.id === input.groupId)) fail('Group not found.'); canvas.groupId = input.groupId || null; }
    canvas.updatedAt = now(); writeStore(store); result = { canvas: summary(canvas) };
  } else if (name === 'canvas_delete') {
    const canvas = canvasById(store, input.canvasId); store.canvases = store.canvases.filter((item) => item.id !== canvas.id); if (store.currentCanvasId === canvas.id) store.currentCanvasId = store.canvases[0]?.id || null; writeStore(store); result = { deleted: canvas.id, currentCanvasId: store.currentCanvasId };
  } else if (name === 'canvas_get_knowledge') {
    result = { coordinateSystem: 'Canvas uses 40 × 30 grid units with origin at the top-left.', guidance: 'Leave breathing room between elements, place related notes close together, and connect only directly related items.' };
  } else if (name === 'canvas_import') {
    const outer = input.snapshot && typeof input.snapshot === 'object' ? input.snapshot : fail('snapshot must be an object.');
    const source = outer.result && typeof outer.result === 'object' && outer.result.canvas ? outer.result : outer;
    if (JSON.stringify(source).length > 10_000_000) fail('Snapshot import is limited to 10 MB.');
    const sourceCanvas = source.canvas && typeof source.canvas === 'object' ? source.canvas : {};
    const sourceElements = Array.isArray(source.elements) ? source.elements : [];
    if (sourceElements.length > MAX_ELEMENTS) fail(`Import is limited to ${MAX_ELEMENTS} elements.`);
    if (store.canvases.length >= MAX_CANVASES) fail('Canvas limit reached.');
    const canvas = {
      id: randomUUID(),
      name: String(input.name || sourceCanvas.name || 'Imported canvas').trim().slice(0, 100),
      description: String(sourceCanvas.description || ''),
      createdAt: now(), updatedAt: now(), actionCursor: 0,
      elements: sourceElements.map((item) => {
        const kind = String(item.type || item.elementKind || 'shape').split('/').pop();
        const type = ['sticky', 'shape', 'text', 'document', 'table', 'link', 'image', 'file', 'widget', 'connector', 'group'].includes(kind) ? kind : 'shape';
        return {
          id: typeof item.id === 'string' && item.id ? item.id : randomUUID(),
          type,
          position: clampPosition(item.position || {}),
          config: (() => {
            const config = item.config && typeof item.config === 'object' ? { ...item.config } : {};
            if (type === 'connector') {
              const endpointId = (endpoint) => typeof endpoint === 'string' ? endpoint : endpoint && typeof endpoint.nodeId === 'string' ? endpoint.nodeId : undefined;
              config.sourceId = config.sourceId || endpointId(config.source);
              config.targetId = config.targetId || endpointId(config.target);
              if (!config.sourceId || !config.targetId) config.orphanedLegacyConnector = true;
            }
            return config;
          })(),
          ...(item.vizSpec && typeof item.vizSpec === 'object' ? { vizSpec: item.vizSpec } : {}),
          createdAt: item.createdAt || now(), updatedAt: now(),
        };
      }), undoStack: [], redoStack: [],
    };
    store.canvases.unshift(canvas); store.currentCanvasId = canvas.id; writeStore(store); result = { canvas: summary(canvas), currentCanvasId: canvas.id, importedElements: canvas.elements.length };
  } else {
    const canvas = canvasById(store, input.canvasId);
    const beforeElements = JSON.parse(JSON.stringify(canvas.elements));
    switch (name) {
      case 'canvas_get_snapshot':
      case 'canvas_export': result = snapshot(canvas); break;
      case 'canvas_list_elements': result = { canvasId: canvas.id, elements: canvas.elements.map(elementSummary), count: canvas.elements.length }; break;
      case 'canvas_create_element': {
        if (canvas.elements.length >= MAX_ELEMENTS) fail('Element limit reached.');
        const element = { id: randomUUID(), canvasId: canvas.id, type: input.type, position: clampPosition(input.position || {}), config: input.config && typeof input.config === 'object' ? input.config : {}, createdAt: now(), updatedAt: now() };
        canvas.elements.push(element); result = { element }; break;
      }
      case 'canvas_connect_elements': {
        if (input.sourceId === input.targetId) fail('Choose two different elements.');
        const source = elementById(canvas, input.sourceId); const target = elementById(canvas, input.targetId);
        const sourceCenter = { x: source.position.x + source.position.w / 2, y: source.position.y + source.position.h / 2 };
        const targetCenter = { x: target.position.x + target.position.w / 2, y: target.position.y + target.position.h / 2 };
        const element = { id: randomUUID(), canvasId: canvas.id, type: 'connector', position: { x: Math.min(sourceCenter.x, targetCenter.x), y: Math.min(sourceCenter.y, targetCenter.y), w: Math.abs(sourceCenter.x - targetCenter.x), h: Math.abs(sourceCenter.y - targetCenter.y), zIndex: 0 }, config: { sourceId: source.id, targetId: target.id, label: String(input.label || '') }, createdAt: now(), updatedAt: now() };
        canvas.elements.push(element); result = { element }; break;
      }
      case 'canvas_group_elements': {
        const ids = Array.isArray(input.elementIds) ? [...new Set(input.elementIds.filter((id) => typeof id === 'string'))] : [];
        if (ids.length < 2) fail('Select at least two elements to group.');
        const members = ids.map((id) => elementById(canvas, id));
        const left = Math.min(...members.map((item) => item.position.x)); const top = Math.min(...members.map((item) => item.position.y));
        const right = Math.max(...members.map((item) => item.position.x + item.position.w)); const bottom = Math.max(...members.map((item) => item.position.y + item.position.h));
        const element = { id: randomUUID(), canvasId: canvas.id, type: 'group', position: clampPosition({ x: left, y: top, w: right - left, h: bottom - top }), config: { memberIds: ids, name: String(input.name || 'Group') }, createdAt: now(), updatedAt: now() };
        canvas.elements.push(element); result = { group: element }; break;
      }
      case 'canvas_ungroup_elements': {
        const group = elementById(canvas, input.groupId); if (group.type !== 'group') fail('The selected element is not a group.');
        canvas.elements = canvas.elements.filter((item) => item.id !== group.id); result = { ungrouped: group.id, memberIds: group.config?.memberIds || [] }; break;
      }
      case 'canvas_move_element': { const element = elementById(canvas, input.elementId); element.position = Object.assign({}, element.position, clampPosition(Object.assign({}, element.position, { x: input.x, y: input.y }))); element.updatedAt = now(); result = { element }; break; }
      case 'canvas_resize_element': { const element = elementById(canvas, input.elementId); element.position = Object.assign({}, element.position, clampPosition(Object.assign({}, element.position, { w: input.width, h: input.height }))); element.updatedAt = now(); result = { element }; break; }
      case 'canvas_fill_content': { const element = elementById(canvas, input.elementId); element.config = Object.assign({}, element.config, input.content || {}); element.updatedAt = now(); result = { element }; break; }
      case 'canvas_style_element': { const element = elementById(canvas, input.elementId); element.config = Object.assign({}, element.config, Object.fromEntries(['color', 'bgColor', 'fontSize', 'opacity'].filter((key) => input[key] !== undefined).map((key) => [key, input[key]]))); element.updatedAt = now(); result = { element }; break; }
      case 'canvas_delete_element': { const element = elementById(canvas, input.elementId); canvas.elements = canvas.elements.filter((item) => item.id !== element.id && !(item.type === 'connector' && (item.config?.sourceId === element.id || item.config?.targetId === element.id))); result = { deleted: element.id }; break; }
      case 'canvas_undo': {
        if (!canvas.undoStack || !canvas.undoStack.length) fail('There is no canvas change to undo.');
        canvas.redoStack = canvas.redoStack || []; canvas.redoStack.push(JSON.parse(JSON.stringify(canvas.elements)));
        canvas.elements = canvas.undoStack.pop(); result = { undone: true }; break;
      }
      case 'canvas_redo': {
        if (!canvas.redoStack || !canvas.redoStack.length) fail('There is no canvas change to redo.');
        canvas.undoStack = canvas.undoStack || []; canvas.undoStack.push(JSON.parse(JSON.stringify(canvas.elements)));
        canvas.elements = canvas.redoStack.pop(); result = { redone: true }; break;
      }
      case 'canvas_find_empty_space': result = findEmpty(canvas, input); break;
      case 'canvas_auto_layout': {
        const columns = Math.max(1, Math.min(8, Math.round(finite(input.columns, 'columns', 4))));
        const cellW = Math.floor(WIDTH / columns); const cellH = Math.max(3, Math.min(7, Math.floor(HEIGHT / Math.max(1, Math.ceil(canvas.elements.length / columns)))));
        result = { positions: canvas.elements.map((element, index) => ({ elementId: element.id, x: (index % columns) * cellW, y: Math.floor(index / columns) * cellH })) }; break;
      }
      case 'canvas_apply_layout': {
        const positions = Array.isArray(input.positions) ? input.positions : [];
        positions.forEach((position) => { const element = elementById(canvas, position.elementId); element.position = Object.assign({}, element.position, clampPosition(Object.assign({}, element.position, position))); element.updatedAt = now(); });
        result = { updated: positions.length }; break;
      }
      default: fail(`Unknown Canvas tool: ${name}`);
    }
    if (mutatingTools.has(name)) {
      canvas.undoStack = canvas.undoStack || [];
      canvas.undoStack.push(beforeElements);
      if (canvas.undoStack.length > 100) canvas.undoStack.shift();
      canvas.redoStack = [];
    }
    if (mutatingTools.has(name) || name === 'canvas_undo' || name === 'canvas_redo') {
      canvas.updatedAt = now(); canvas.actionCursor += 1; writeStore(store);
    }
  }
  return result;
}

function call(name, input) { return withStoreLock(() => callUnlocked(name, input)); }

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function errorResponse(id, error) { return { jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }; }
async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || message.id === undefined) return null;
  try {
    if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'conductor_canvas', version: '0.2.0' } } };
    if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} };
    if (message.method === 'tools/list') return { jsonrpc: '2.0', id: message.id, result: { tools } };
    if (message.method === 'tools/call') {
      const name = message.params?.name; const input = message.params?.arguments || {};
      if (!tools.some((tool) => tool.name === name)) fail(`Unknown tool: ${name}`);
      try { const value = await call(name, input); return { jsonrpc: '2.0', id: message.id, result: text(value) }; }
      catch (error) { return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: error.message || String(error) }], isError: true } }; }
    }
    fail(`Unsupported MCP method: ${message.method}`);
  } catch (error) { return errorResponse(message.id, error); }
}

let input = '';
let requestQueue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  while (true) {
    const index = input.indexOf('\n'); if (index < 0) break;
    const line = input.slice(0, index); input = input.slice(index + 1); if (!line.trim()) continue;
    requestQueue = requestQueue.then(async () => {
      try { const response = await handle(JSON.parse(line)); if (response) send(response); }
      catch (error) { send(errorResponse(null, error)); }
    });
  }
});

#!/usr/bin/env node
'use strict';

// Conductor Canvas is implemented inside this marketplace package. The MCP
// process owns its canvas data and exposes the same editing vocabulary to the
// agent and Mini App; it does not reach into DUYA's private Electron APIs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { createProjectDatabase } = require('./project-database.cjs');
const { createSettingsStore } = require('./settings-store.cjs');
const { createRefineProvider } = require('./refine-provider.cjs');

const storePath = path.resolve(process.env.DUYA_CANVAS_STORE || path.join(os.homedir(), '.duya', 'plugins', 'conductor-canvas', 'canvases.json'));
const WIDTH = 40;
const HEIGHT = 30;
const MAX_CANVASES = 500;
const MAX_ELEMENTS = 5000;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const lockPath = `${storePath}.lock`;
const assetDir = path.join(path.dirname(storePath), 'assets');
const projectDatabase = createProjectDatabase({ dataRoot: process.env.DUYA_PLUGIN_DATA || path.dirname(storePath) });
const settingsStore = createSettingsStore(process.env.DUYA_PLUGIN_DATA || path.dirname(storePath));
const callRefine = createRefineProvider({ settings: settingsStore });

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
    try { fs.closeSync(fd); }
    finally { fs.unlinkSync(lockPath); }
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
    rotation: finite(position.rotation, 'rotation', 0),
  };
}
function summary(canvas) {
  return { id: canvas.id, name: canvas.name, description: canvas.description, createdAt: canvas.createdAt, updatedAt: canvas.updatedAt, elementCount: canvas.elements.length + (canvas.widgets || []).length, isFavorite: canvas.isFavorite === true, tags: canvas.tags || [], groupId: canvas.groupId || null, layoutConfig: canvas.layoutConfig || {}, sortOrder: canvas.sortOrder || 0, projectPath: canvas.projectPath || null };
}
function snapshot(canvas) {
  return { canvas: { id: canvas.id, name: canvas.name, description: canvas.description, layoutConfig: canvas.layoutConfig || {}, sortOrder: canvas.sortOrder || 0, projectPath: canvas.projectPath || null, createdAt: canvas.createdAt, updatedAt: canvas.updatedAt, isFavorite: canvas.isFavorite, tags: canvas.tags, groupId: canvas.groupId, legacy: canvas.legacy }, elements: canvas.elements, widgets: canvas.widgets || [], actions: canvas.actions || [], actionCursor: canvas.actionCursor, canUndo: (canvas.undoStack || []).length > 0, canRedo: (canvas.redoStack || []).length > 0 };
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
  { name: 'canvas_update', description: 'Update canvas metadata and saved layout settings.', inputSchema: object({ canvasId: string, name: string, description: string, layoutConfig: { type: 'object' }, sortOrder: number, isFavorite: { type: 'boolean' }, groupId: string, tags: { type: 'array', items: string } }, ['canvasId']) },
  { name: 'canvas_delete', description: 'Delete a canvas and all of its elements.', inputSchema: object({ canvasId: string }, ['canvasId']) },
  { name: 'canvas_get_snapshot', description: 'Read one canvas with all positions and element content.', inputSchema: object({ canvasId: string }) },
  { name: 'canvas_execute_action', description: 'Apply a Conductor domain action to a canvas, preserving native element fields and freeform positions.', inputSchema: { type: 'object', properties: { action: { type: 'object', properties: {}, additionalProperties: true } }, required: ['action'], additionalProperties: false } },
  { name: 'canvas_project_database', description: 'Read or update the plugin-owned project database using its typed source, property, record, view, and query commands.', inputSchema: { type: 'object', properties: { request: { type: 'object', properties: { projectPath: string, command: { type: 'object', properties: {}, additionalProperties: true } }, required: ['projectPath', 'command'], additionalProperties: false } }, required: ['request'], additionalProperties: false } },
  { name: 'canvas_settings_get', description: 'Read a persisted non-secret Canvas plugin setting.', inputSchema: object({ key: string }, ['key']) },
  { name: 'canvas_settings_set', description: 'Persist a JSON Canvas plugin setting. Provider secrets must use canvas_provider_configure.', inputSchema: object({ key: string, value: {} }, ['key', 'value']) },
  { name: 'canvas_provider_status', description: 'Read OpenAI-compatible Canvas provider setup status without revealing the API key.', inputSchema: object({}) },
  { name: 'canvas_provider_list', description: 'List the configured OpenAI-compatible provider for the Canvas model selector.', inputSchema: object({}) },
  { name: 'canvas_provider_configure', description: 'Configure the optional OpenAI-compatible refine provider.', inputSchema: object({ baseURL: string, model: string, secretAPIkey: { type: ['string', 'null'] } }) },
  { name: 'canvas_refine_call', description: 'Refine one widget data object using the configured OpenAI-compatible provider.', inputSchema: object({ sessionId: string, userRequest: string, widgetType: string, currentData: { type: 'object' }, iteration: number, maxIterations: number, screenshotBase64: string }, ['sessionId', 'userRequest', 'widgetType', 'currentData', 'iteration', 'maxIterations', 'screenshotBase64']) },
  { name: 'canvas_export', description: 'Export a canvas snapshot as portable JSON.', inputSchema: object({ canvasId: string }) },
  { name: 'canvas_import', description: 'Import a Conductor Canvas snapshot JSON object as a new canvas.', inputSchema: object({ snapshot: { type: 'object' }, name: string }, ['snapshot']) },
  { name: 'canvas_import_bundle', description: 'Import a legacy Conductor export bundle with canvases and groups in one transaction.', inputSchema: object({ bundle: { type: 'object' } }, ['bundle']) },
  { name: 'canvas_asset_put', description: 'Store a local image or file in the Canvas plugin data directory.', inputSchema: object({ name: string, mimeType: string, base64: string }, ['name', 'mimeType', 'base64']) },
  { name: 'canvas_asset_get', description: 'Read a Canvas plugin asset by its content hash.', inputSchema: object({ assetId: string }, ['assetId']) },
  { name: 'canvas_list_elements', description: 'List elements with compact identifiers, content summaries, and positions.', inputSchema: object({ canvasId: string }) },
  { name: 'canvas_create_element', description: 'Add a native canvas element, file, link, table, database view, or widget.', inputSchema: object({ canvasId: string, type: { type: 'string', enum: ['shape', 'sticky', 'text', 'document', 'table', 'link', 'image', 'file', 'pdf', 'database', 'section', 'frame', 'widget'] }, position: object({ x: number, y: number, w: number, h: number }), config: { type: 'object' } }, ['type', 'position']) },
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

function importedCanvas(snapshotInput, name, groupIds = new Map()) {
  const outer = snapshotInput && typeof snapshotInput === 'object' ? snapshotInput : fail('snapshot must be an object.');
  const source = outer.result && typeof outer.result === 'object' && outer.result.canvas ? outer.result : outer;
  const { assets: _assets, ...model } = source;
  if (JSON.stringify(model).length > 10_000_000) fail('A snapshot model is limited to 10 MB, excluding embedded assets.');
  const sourceCanvas = source.canvas && typeof source.canvas === 'object' ? source.canvas : {};
  const sourceElements = Array.isArray(source.elements) ? source.elements : [];
  const importedId = randomUUID();
  if (sourceElements.length > MAX_ELEMENTS) fail(`Import is limited to ${MAX_ELEMENTS} elements per canvas.`);
  const createdAt = now();
  const canvas = {
    id: importedId, name: String(name || sourceCanvas.name || 'Imported canvas').trim().slice(0, 100),
    description: String(sourceCanvas.description || ''), layoutConfig: sourceCanvas.layoutConfig || {},
    sortOrder: Number(sourceCanvas.sortOrder) || 0, projectPath: typeof sourceCanvas.projectPath === 'string' ? sourceCanvas.projectPath : null,
    createdAt: sourceCanvas.createdAt || createdAt, updatedAt: sourceCanvas.updatedAt || createdAt, actionCursor: Number(source.actionCursor) || 0,
    isFavorite: sourceCanvas.isFavorite === true,
    tags: Array.isArray(sourceCanvas.tags) ? sourceCanvas.tags.filter((item) => typeof item === 'string').slice(0, 20) : [],
    groupId: groupIds.get(sourceCanvas.groupId) || null,
    // Keep fields the smaller editor cannot yet interpret. A later plugin
    // version can replay or render them without revisiting DUYA's database.
    legacy: { ...sourceCanvas.legacy, id: sourceCanvas.legacy?.id || sourceCanvas.id, layoutConfig: sourceCanvas.layoutConfig || sourceCanvas.legacy?.layoutConfig,
      sortOrder: sourceCanvas.sortOrder, projectPath: sourceCanvas.projectPath,
      createdAt: sourceCanvas.createdAt, updatedAt: sourceCanvas.updatedAt,
      widgets: source.widgets || sourceCanvas.legacy?.widgets, actions: source.actions || sourceCanvas.legacy?.actions },
    actions: Array.isArray(source.actions) ? source.actions : Array.isArray(sourceCanvas.legacy?.actions) ? sourceCanvas.legacy.actions : [],
    elements: sourceElements.map((item) => {
      const rawKind = String(item.type || item.elementKind || item.nativeKind || item.native_kind || 'shape');
      const kind = String(item.nativeKind || item.native_kind || rawKind).split('/').pop();
      const inferredKind = kind === 'pdf' || (kind === 'file' && item.config?.mimeType === 'application/pdf') ? 'file' : kind;
      const type = ['sticky', 'shape', 'text', 'document', 'table', 'link', 'image', 'file', 'pdf', 'database', 'section', 'frame', 'widget', 'connector', 'group'].includes(inferredKind) ? inferredKind : rawKind.startsWith('widget/') ? 'widget' : 'widget';
      const config = item.config && typeof item.config === 'object' ? { ...item.config } : {};
      if (type === 'connector') {
        const endpointId = (endpoint) => typeof endpoint === 'string' ? endpoint : endpoint && typeof endpoint.nodeId === 'string' ? endpoint.nodeId : undefined;
        config.sourceId = config.sourceId || endpointId(config.source);
        config.targetId = config.targetId || endpointId(config.target);
        if (!config.sourceId || !config.targetId) config.orphanedLegacyConnector = true;
      }
      return {
        ...item,
        id: typeof item.id === 'string' && item.id ? item.id : randomUUID(), canvasId: importedId, type,
        elementKind: item.elementKind || rawKind,
        nativeKind: item.nativeKind ?? item.native_kind ?? (rawKind.startsWith('native/') ? rawKind.slice(7) : null),
        native_kind: item.native_kind ?? item.nativeKind ?? (rawKind.startsWith('native/') ? rawKind.slice(7) : null),
        position: freeformPosition(item.position || {}), config,
        ...(item.vizSpec && typeof item.vizSpec === 'object' ? { vizSpec: item.vizSpec } : {}),
        ...(item.sourceCode ? { sourceCode: item.sourceCode } : {}),
        ...(item.state ? { state: item.state } : {}),
        ...(item.permissions && typeof item.permissions === 'object' ? { permissions: item.permissions } : {}),
        ...(item.metadata && typeof item.metadata === 'object' ? { metadata: item.metadata } : {}),
        ...(Number.isFinite(Number(item.dataVersion)) ? { dataVersion: Number(item.dataVersion) } : {}),
        legacy: { ...item.legacy, id: item.legacy?.id || item.id, canvasId: item.legacy?.canvasId || item.canvasId, type: item.type || item.legacy?.type,
          elementKind: item.elementKind || item.legacy?.elementKind, nativeKind: item.nativeKind || item.legacy?.nativeKind,
          position: item.legacy?.position || item.position, sourceCode: item.sourceCode || item.legacy?.sourceCode, state: item.state || item.legacy?.state,
          dataVersion: item.dataVersion, permissions: item.permissions,
          metadata: item.metadata, createdAt: item.createdAt, updatedAt: item.updatedAt },
        createdAt: item.createdAt || createdAt, updatedAt: item.updatedAt || createdAt,
      };
    }), widgets: Array.isArray(source.widgets) ? source.widgets.map((widget) => ({ ...widget, canvasId: importedId, position: freeformPosition(widget.position || {}) })) : [], undoStack: [], redoStack: [],
  };
  if (!canvas.name) fail('Canvas name is required.');
  return canvas;
}

function validateBundleAssets(assets) {
  if (assets === undefined) return [];
  if (!Array.isArray(assets) || assets.length > 1000) fail('Legacy bundle assets must be an array with at most 1000 files.');
  let total = 0;
  return assets.map((asset) => {
    if (!asset || typeof asset.assetId !== 'string' || asset.assetId.length > 100) fail('Invalid legacy asset reference.');
    const encoded = String(asset.base64 || '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4 + 4) fail(`Legacy asset ${asset.name || asset.assetId} exceeds the 5 MB asset limit or is invalid.`);
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES) fail(`Legacy asset ${asset.name || asset.assetId} must be between 1 byte and 5 MB.`);
    const mimeType = String(asset.mimeType || 'application/octet-stream').slice(0, 120);
    if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(mimeType)) fail('Invalid legacy asset MIME type.');
    total += bytes.length;
    if (total > 35 * 1024 * 1024) fail('Legacy bundle assets are limited to 35 MB total.');
    return { oldId: asset.assetId, name: path.basename(String(asset.name || 'asset')).slice(0, 180), mimeType, bytes };
  });
}

function remapAssetReferences(value, assetIds) {
  if (Array.isArray(value)) return value.map((item) => remapAssetReferences(item, assetIds));
  if (!value || typeof value !== 'object') return value;
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, { value: ['assetId', 'snapshotAssetId'].includes(key) && assetIds.has(item)
      ? assetIds.get(item)
      : remapAssetReferences(item, assetIds), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function storeBundleAssets(assets) {
  const assetIds = new Map();
  for (const asset of assets) {
    const assetId = createHash('sha256').update(asset.bytes).digest('hex');
    const dataPath = path.join(assetDir, assetId);
    const metadataPath = path.join(assetDir, `${assetId}.json`);
    fs.mkdirSync(assetDir, { recursive: true });
    if (!fs.existsSync(dataPath)) fs.writeFileSync(dataPath, asset.bytes, { flag: 'wx', mode: 0o600 });
    if (!fs.existsSync(metadataPath)) fs.writeFileSync(metadataPath, JSON.stringify({ name: asset.name, mimeType: asset.mimeType, size: asset.bytes.length }), { flag: 'wx', mode: 0o600 });
    assetIds.set(asset.oldId, assetId);
  }
  return assetIds;
}

function referencedAssetIds(value, ids = new Set()) {
  if (Array.isArray(value)) { for (const item of value) referencedAssetIds(item, ids); return ids; }
  if (!value || typeof value !== 'object') return ids;
  for (const [key, item] of Object.entries(value)) {
    if (['assetId', 'snapshotAssetId'].includes(key) && typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)) ids.add(item);
    referencedAssetIds(item, ids);
  }
  return ids;
}

function snapshotWithAssets(canvas) {
  const result = snapshot(canvas);
  result.assets = [];
  for (const assetId of referencedAssetIds(result)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(assetDir, `${assetId}.json`), 'utf8'));
      const bytes = fs.readFileSync(path.join(assetDir, assetId));
      result.assets.push({ assetId, name: metadata.name, mimeType: metadata.mimeType, base64: bytes.toString('base64') });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}

function freeformPosition(position = {}) {
  return {
    ...position,
    x: finite(position.x, 'x', 0),
    y: finite(position.y, 'y', 0),
    w: finite(position.w, 'w', 4),
    h: finite(position.h, 'h', 3),
    zIndex: finite(position.zIndex, 'zIndex', 0),
    rotation: finite(position.rotation, 'rotation', 0),
  };
}

function actionElement(canvas, elementKind, position, config = {}, extras = {}) {
  if (canvas.elements.length >= MAX_ELEMENTS) fail('Element limit reached.');
  if (!elementKind.trim()) fail('elementKind is required.');
  const id = randomUUID();
  const nativeKind = elementKind.startsWith('native/') ? elementKind.slice(7) : undefined;
  const element = {
    id, canvasId: canvas.id, type: nativeKind || elementKind, elementKind,
    ...(nativeKind ? { nativeKind, native_kind: nativeKind } : {}),
    position: freeformPosition(position), config: config && typeof config === 'object' ? config : {},
    state: 'idle', dataVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), vizSpec: null,
    sourceCode: null, permissions: { agentCanRead: true, agentCanWrite: true, agentCanDelete: true },
    metadata: { label: elementKind, tags: [], createdBy: 'user' }, ...extras,
  };
  canvas.elements.push(element);
  return element;
}

function canvasHistoryState(canvas) {
  return JSON.parse(JSON.stringify({
    elements: canvas.elements, widgets: canvas.widgets || [], name: canvas.name,
    description: canvas.description, layoutConfig: canvas.layoutConfig || {},
    actionCursor: canvas.actionCursor || 0,
  }));
}

function restoreHistoryState(canvas, state) {
  if (Array.isArray(state)) { canvas.elements = state; return; }
  canvas.elements = state.elements || [];
  canvas.widgets = state.widgets || [];
  for (const key of ['name', 'description', 'layoutConfig', 'actionCursor']) {
    if (Object.hasOwn(state, key)) canvas[key] = state[key];
  }
}

function recordCanvasChange(canvas, before, action, value) {
  canvas.actions = canvas.actions || [];
  const actionId = Math.max(canvas.actionCursor || 0, ...canvas.actions.map((entry) => Number(entry.id) || 0)) + 1;
  canvas.undoStack = canvas.undoStack || [];
  canvas.undoStack.push({ ...before, appliedActionId: actionId });
  if (canvas.undoStack.length > 100) canvas.undoStack.shift();
  canvas.redoStack = [];
  canvas.actionCursor = actionId;
  canvas.actions.push({ id: actionId, canvasId: canvas.id, widgetId: action.widgetId || null,
    actor: action.actor || 'agent', actionType: action.action, payload: { ...action },
    resultPatch: value, mergedFrom: null, reversible: 1, ts: Date.now(), undoneAt: null });
  if (canvas.actions.length > 1000) canvas.actions.splice(0, canvas.actions.length - 1000);
}

function applyConductorAction(store, action) {
  if (!action || typeof action !== 'object' || typeof action.action !== 'string') fail('action must be a Conductor action object.');
  if (action.actor !== undefined && !['user', 'agent', 'system'].includes(action.actor)) fail('actor must be user, agent, or system.');
  const canvas = canvasById(store, action.canvasId);
  const before = canvasHistoryState(canvas);
  let value;
  const find = (id) => canvas.elements.find((element) => element.id === id);
  const requireElement = (id) => find(id) || fail(`Element not found: ${id}`);
  const positionPatch = (element, position) => { element.position = freeformPosition({ ...element.position, ...position }); element.updatedAt = Date.now(); };
  switch (action.action) {
    case 'canvas.describe_context': {
      const elements = canvas.elements.map((element) => ({ ...elementSummary(element),
        elementKind: element.elementKind, ...(action.includeConfig ? { config: element.config } : {}) }));
      const overlaps = [];
      const nodes = canvas.elements.filter((element) => element.nativeKind !== 'connector' && element.type !== 'connector');
      for (let index = 0; index < nodes.length; index++) for (let other = index + 1; other < nodes.length; other++) {
        const a = nodes[index].position; const b = nodes[other].position;
        if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) overlaps.push([nodes[index].id, nodes[other].id]);
      }
      return { success: true, result: { canvasId: canvas.id, count: elements.length, elements, overlaps,
        markdown: [`# Canvas context: ${canvas.name}`, canvas.description || '',
          'Coordinates: 40 × 30 grid units; origin top-left.', ...elements.map((element) => JSON.stringify(element))].join('\n') } };
    }
    case 'canvas.rename':
      canvas.name = String(action.name || '').trim().slice(0, 100) || fail('name is required.'); value = { canvas: summary(canvas) }; break;
    case 'widget.create': {
      const kind = action.kind || 'dynamic'; if (!['builtin', 'template', 'dynamic'].includes(kind)) fail('Invalid widget kind.');
      const widget = { id: action.widgetId || randomUUID(), canvasId: canvas.id, kind, type: String(action.type || 'dynamic'), position: freeformPosition(action.position), config: action.config || {}, data: action.data || {}, dataVersion: 1, sourceCode: action.sourceCode || null, state: 'idle', permissions: action.permissions || { agentCanRead: true, agentCanWrite: true, agentCanDelete: true }, createdAt: Date.now(), updatedAt: Date.now() };
      canvas.widgets = canvas.widgets || []; canvas.widgets.push(widget); value = { widget }; break;
    }
    case 'widget.move': case 'widget.resize': {
      const widget = (canvas.widgets || []).find((item) => item.id === action.widgetId); if (!widget) fail(`Widget not found: ${action.widgetId}`);
      widget.position = { ...widget.position, ...freeformPosition({ ...widget.position, ...action.position }) }; widget.updatedAt = Date.now(); value = { widget }; break;
    }
    case 'widget.update_config': case 'widget.update_data': {
      const widget = (canvas.widgets || []).find((item) => item.id === action.widgetId); if (!widget) fail(`Widget not found: ${action.widgetId}`);
      if (action.action === 'widget.update_config') widget.config = { ...(action.config || {}) };
      else widget.data = { ...widget.data, ...(action.data || {}) };
      if (action.action === 'widget.update_data') widget.dataVersion = (widget.dataVersion || 0) + 1;
      const pairedElement = canvas.elements.find((element) => element.id === widget.id);
      if (pairedElement) pairedElement.config = action.action === 'widget.update_config' ? { ...widget.config } : { ...pairedElement.config, ...widget.data };
      widget.updatedAt = Date.now(); value = { widget, ...(action.clientTs === undefined ? {} : { clientTs: action.clientTs }) }; break;
    }
    case 'widget.delete': case 'widget.restore': {
      canvas.widgets = canvas.widgets || [];
      if (action.action === 'widget.delete') {
        const widget = canvas.widgets.find((item) => item.id === action.widgetId); if (!widget) fail(`Widget not found: ${action.widgetId}`);
        canvas.widgets = canvas.widgets.filter((item) => item.id !== action.widgetId);
        canvas.elements = canvas.elements.filter((item) => item.id !== action.widgetId);
        value = { deleted: action.widgetId, widget };
      } else {
        const prior = [...(canvas.actions || [])].reverse().find((entry) => entry.actionType === 'widget.delete' && entry.payload?.widgetId === action.widgetId);
        const widget = action.widget && typeof action.widget === 'object' ? action.widget : prior?.resultPatch?.widget;
        if (!widget) fail(`No deleted widget data found for ${action.widgetId}.`);
        if (!canvas.widgets.some((item) => item.id === action.widgetId)) canvas.widgets.push({ ...widget, canvasId: canvas.id });
        if (!canvas.elements.some((item) => item.id === action.widgetId)) {
          canvas.elements.push({ id: widget.id, canvasId: canvas.id, type: `widget/${widget.type}`, elementKind: `widget/${widget.type}`, position: freeformPosition(widget.position), config: { ...(widget.data || {}), ...(widget.config || {}) }, sourceCode: widget.sourceCode || null, state: widget.state || 'idle', dataVersion: widget.dataVersion || 1, permissions: widget.permissions || {}, metadata: { label: `${widget.kind}:${widget.type}`, tags: [], createdBy: 'user' }, createdAt: widget.createdAt || Date.now(), updatedAt: Date.now() });
        }
        value = { widget };
      }
      break;
    }
    case 'element.create': {
      if (!String(action.elementKind || '').trim()) fail('elementKind is required.');
      const element = actionElement(canvas, String(action.elementKind), action.position, action.config || {}, { vizSpec: action.vizSpec || null, ...(action.permissions ? { permissions: action.permissions } : {}) }); value = { element }; break;
    }
    case 'element.batch_create': {
      const operations = action.operations;
      if (!Array.isArray(operations) || !operations.length || operations.length > 500) fail('operations must contain 1 to 500 create/connect operations.');
      const refs = new Map(); const elements = [];
      for (const op of operations) {
        if (!op || !['create', 'connect'].includes(op.op)) fail('Batch operations must be create or connect.');
        if (op.op === 'create' && op.ref !== undefined) {
          if (typeof op.ref !== 'string' || !op.ref || refs.has(op.ref)) fail('Batch refs must be unique non-empty strings.');
          refs.set(op.ref, randomUUID());
        }
      }
      for (const op of operations.filter((item) => item.op === 'create')) {
        if (typeof op.kind !== 'string' || !op.kind.trim()) fail('Batch create requires kind.');
        elements.push(actionElement(canvas, op.kind, op.position, op.config || {}, {
          ...(op.ref ? { id: refs.get(op.ref) } : {}), sourceCode: op.sourceCode || null, vizSpec: op.vizSpec || null,
        }));
      }
      const resolve = (id) => { const resolved = refs.get(id) || id; requireElement(resolved); return resolved; };
      for (const op of operations.filter((item) => item.op === 'connect')) {
        const sourceId = resolve(op.source); const targetId = resolve(op.target);
        elements.push(actionElement(canvas, 'native/connector', { x: 0, y: 0, w: 0, h: 0 }, {
          source: { nodeId: sourceId }, target: { nodeId: targetId }, sourceId, targetId,
          routingMode: op.routingMode === 'curve' ? 'curve' : 'elbow', curvature: op.curvature ?? 0.4,
          style: op.style || {}, label: op.label || '',
          ...Object.fromEntries(['strokeStyle', 'lineWidth', 'color', 'startMarker', 'endMarker'].filter((key) => op[key] !== undefined).map((key) => [key, op[key]])),
        }));
      }
      value = { elements, refs: Object.fromEntries(refs) }; break;
    }
    case 'element.create_native': {
      const type = String(action.nodeType || '').replace(/^native\//, '');
      const content = action.content && typeof action.content === 'object' ? action.content : {};
      const style = action.style && typeof action.style === 'object' ? action.style : {};
      const element = actionElement(canvas, `native/${type}`, action.position, { ...content, style }, { metadata: { label: content.label || type, tags: [], createdBy: action.actor || 'user', parentId: null, childIds: [] } }); value = { element }; break;
    }
    case 'element.move': case 'element.update': {
      const element = requireElement(action.elementId);
      if (action.position) positionPatch(element, action.position);
      if (action.config) element.config = { ...action.config };
      if (action.metadata) element.metadata = { ...element.metadata, ...action.metadata };
      if (action.vizSpec !== undefined) element.vizSpec = action.vizSpec;
      if (action.action === 'element.update') element.updatedAt = Date.now();
      value = { element }; break;
    }
    case 'element.update_content': {
      const element = requireElement(action.elementId); element.config = { ...element.config, ...(action.content || {}) }; element.updatedAt = Date.now(); value = { element }; break;
    }
    case 'element.delete': {
      const element = requireElement(action.elementId);
      const references = (endpoint) => typeof endpoint === 'string' ? endpoint === element.id : endpoint && endpoint.nodeId === element.id;
      canvas.elements = canvas.elements.filter((item) => {
        if (item.id === element.id) return false;
        const isConnector = item.nativeKind === 'connector' || item.native_kind === 'connector' || item.type === 'connector';
        return !isConnector || (!references(item.config?.source) && !references(item.config?.target) && item.config?.sourceId !== element.id && item.config?.targetId !== element.id);
      });
      value = { deleted: element.id }; break;
    }
    case 'element.reparent': {
      const element = requireElement(action.elementId); const previousParentId = element.metadata?.parentId || null; const parentId = action.parentId || null;
      if (parentId && !canvas.elements.some((item) => item.id === parentId)) fail(`Parent element not found: ${parentId}`);
      if (previousParentId && previousParentId !== parentId) { const oldParent = find(previousParentId); if (oldParent) oldParent.metadata = { ...oldParent.metadata, childIds: (oldParent.metadata?.childIds || []).filter((id) => id !== element.id) }; }
      if (parentId) { const parent = find(parentId); parent.metadata = { ...parent.metadata, childIds: [...new Set([...(parent.metadata?.childIds || []), element.id])] }; }
      element.metadata = { ...element.metadata, parentId }; element.updatedAt = Date.now(); value = { element }; break;
    }
    case 'element.arrange': {
      const layout = Array.isArray(action.layout) ? action.layout : [];
      layout.forEach((item) => { const element = requireElement(item.elementId); positionPatch(element, item.position || {}); }); value = { updated: layout.length }; break;
    }
    case 'element.align': {
      const element = requireElement(action.elementId); const margin = finite(action.margin, 'margin', 20) / 80;
      const { w, h } = element.position;
      const positions = { 'top-left': [margin, margin], 'top-right': [WIDTH - w - margin, margin],
        'bottom-left': [margin, HEIGHT - h - margin], 'bottom-right': [WIDTH - w - margin, HEIGHT - h - margin],
        center: [(WIDTH - w) / 2, (HEIGHT - h) / 2] };
      if (!Object.hasOwn(positions, action.alignment)) fail('Unknown element alignment.');
      const [x, y] = positions[action.alignment]; positionPatch(element, { x, y }); value = { element }; break;
    }
    case 'element.layout_grid': {
      if (!Array.isArray(action.elementIds) || !action.elementIds.length) fail('elementIds is required.');
      const columns = finite(action.columns, 'columns', 3);
      if (!Number.isSafeInteger(columns) || columns < 1) fail('columns must be a positive integer.');
      const gap = finite(action.gap, 'gap', 20); const w = finite(action.cellWidth, 'cellWidth', 250); const h = finite(action.cellHeight, 'cellHeight', 150);
      if (gap < 0 || w <= 0 || h <= 0) fail('Grid dimensions must be positive and gap non-negative.');
      const elements = action.elementIds.map(requireElement);
      elements.forEach((element, index) => positionPatch(element, { x: (index % columns) * (w + gap) + gap, y: Math.floor(index / columns) * (h + gap) + gap, w, h }));
      value = { layout: elements.map((element) => ({ elementId: element.id, position: element.position })) }; break;
    }
    case 'connector.create': {
      const sourceId = typeof action.source === 'string' ? action.source : action.source?.nodeId;
      const targetId = typeof action.target === 'string' ? action.target : action.target?.nodeId;
      for (const id of [sourceId, targetId]) if (id && !canvas.elements.some((element) => element.id === id)) fail(`Connector endpoint element not found: ${id}`);
      const connectorConfig = { source: action.source, target: action.target, curvature: action.curvature || 0.4, routingMode: action.routingMode === 'curve' ? 'curve' : 'elbow', style: action.style || {} };
      if (action.label !== undefined) connectorConfig.label = action.label;
      for (const key of ['strokeStyle', 'lineWidth', 'color', 'startMarker', 'endMarker']) if (action[key] !== undefined) connectorConfig[key] = action[key];
      if (sourceId && targetId) Object.assign(connectorConfig, { sourceId, targetId });
      const element = actionElement(canvas, 'native/connector', { x: 0, y: 0, w: 0, h: 0, zIndex: 0 }, connectorConfig, { metadata: { label: 'Connector', tags: [], createdBy: action.actor || 'user', parentId: null, childIds: [] } }); value = { element }; break;
    }
    case 'group.create': {
      const memberIds = Array.isArray(action.memberIds) ? [...new Set(action.memberIds)] : [];
      const members = memberIds.map(requireElement); if (!members.length) fail('Select at least one element to group.');
      const left = Math.min(...members.map((item) => item.position.x)); const top = Math.min(...members.map((item) => item.position.y));
      const right = Math.max(...members.map((item) => item.position.x + item.position.w)); const bottom = Math.max(...members.map((item) => item.position.y + item.position.h));
      const group = actionElement(canvas, 'native/group', { x: left, y: top, w: right - left, h: bottom - top, zIndex: -1 }, { memberIds, title: action.title || 'Group', ...(action.bgColor === undefined ? {} : { bgColor: action.bgColor }) }, { metadata: { label: action.title || 'Group', tags: [], createdBy: action.actor || 'user', parentId: null, childIds: memberIds } }); value = { group }; break;
    }
    case 'group.ungroup': case 'group.add_members': case 'group.remove_members': {
      const group = requireElement(action.groupId); const ids = new Set(group.config.memberIds || []);
      if (action.action === 'group.ungroup') { canvas.elements = canvas.elements.filter((item) => item.id !== group.id); value = { ungrouped: group.id }; break; }
      (action.memberIds || []).forEach((id) => action.action === 'group.add_members' ? ids.add(id) : ids.delete(id));
      group.config = { ...group.config, memberIds: [...ids] }; group.updatedAt = Date.now(); value = { group }; break;
    }
    default: fail(`Unsupported Conductor action: ${action.action}`);
  }
  recordCanvasChange(canvas, before, action, value);
  canvas.updatedAt = now();
  writeStore(store);
  return { success: true, result: value, snapshot: snapshot(canvas) };
}

async function callUnlocked(name, input) {
  const store = readStore();
  let result;
  if (name === 'canvas_asset_put') {
    const encoded = String(input.base64 || '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4 + 4) fail('Invalid or oversized asset data.');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES) fail('Asset must be between 1 byte and 5 MB.');
    const assetId = createHash('sha256').update(bytes).digest('hex');
    const mimeType = String(input.mimeType || 'application/octet-stream').slice(0, 120);
    if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(mimeType)) fail('Invalid MIME type.');
    const fileName = path.basename(String(input.name || 'asset')).slice(0, 180);
    fs.mkdirSync(assetDir, { recursive: true });
    if (!fs.existsSync(path.join(assetDir, assetId))) fs.writeFileSync(path.join(assetDir, assetId), bytes, { flag: 'wx', mode: 0o600 });
    if (!fs.existsSync(path.join(assetDir, `${assetId}.json`))) fs.writeFileSync(path.join(assetDir, `${assetId}.json`), JSON.stringify({ name: fileName, mimeType, size: bytes.length }), { flag: 'wx', mode: 0o600 });
    result = { assetId, name: fileName, mimeType, size: bytes.length };
  } else if (name === 'canvas_asset_get') {
    const assetId = String(input.assetId || '');
    if (!/^[a-f0-9]{64}$/.test(assetId)) fail('Invalid asset ID.');
    const metadata = JSON.parse(fs.readFileSync(path.join(assetDir, `${assetId}.json`), 'utf8'));
    const bytes = fs.readFileSync(path.join(assetDir, assetId));
    result = { assetId, name: metadata.name, mimeType: metadata.mimeType, size: bytes.length, base64: bytes.toString('base64') };
  } else if (name === 'canvas_manage') {
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
    const canvas = { id: randomUUID(), name: String(input.name || 'Untitled canvas').trim().slice(0, 100), description: String(input.description || ''), layoutConfig: {}, sortOrder: 0, projectPath: null, createdAt: now(), updatedAt: now(), isFavorite: false, tags: [], groupId: null, elements: [], widgets: [], actionCursor: 0, undoStack: [], redoStack: [] };
    store.canvases.unshift(canvas); store.currentCanvasId = canvas.id; writeStore(store); result = { canvas: summary(canvas), currentCanvasId: canvas.id };
  } else if (name === 'canvas_rename') {
    const canvas = canvasById(store, input.canvasId); canvas.name = String(input.name || '').trim().slice(0, 100) || fail('name is required.'); canvas.updatedAt = now(); writeStore(store); result = { canvas: summary(canvas) };
  } else if (name === 'canvas_update') {
    const canvas = canvasById(store, input.canvasId);
    if (input.name !== undefined) canvas.name = String(input.name).trim().slice(0, 100) || fail('name is required.');
    if (input.description !== undefined) canvas.description = input.description === null ? null : String(input.description);
    if (input.layoutConfig !== undefined) canvas.layoutConfig = input.layoutConfig && typeof input.layoutConfig === 'object' ? input.layoutConfig : {};
    if (input.sortOrder !== undefined) canvas.sortOrder = finite(input.sortOrder, 'sortOrder', 0);
    if (input.isFavorite !== undefined) canvas.isFavorite = input.isFavorite === true;
    if (input.tags !== undefined) canvas.tags = Array.isArray(input.tags) ? input.tags.map(String).slice(0, 40) : [];
    if (input.groupId !== undefined) { if (input.groupId && !store.groups.some((group) => group.id === input.groupId)) fail('Group not found.'); canvas.groupId = input.groupId || null; }
    canvas.updatedAt = now(); writeStore(store); result = { canvas: summary(canvas) };
  } else if (name === 'canvas_update_metadata') {
    const canvas = canvasById(store, input.canvasId);
    if (input.isFavorite !== undefined) canvas.isFavorite = input.isFavorite === true;
    if (input.tags !== undefined) canvas.tags = Array.isArray(input.tags) ? input.tags.map(String).map((tag) => tag.trim().slice(0, 40)).filter(Boolean).slice(0, 20) : [];
    if (input.groupId !== undefined) { if (input.groupId && !store.groups.some((group) => group.id === input.groupId)) fail('Group not found.'); canvas.groupId = input.groupId || null; }
    canvas.updatedAt = now(); writeStore(store); result = { canvas: summary(canvas) };
  } else if (name === 'canvas_delete') {
    const canvas = canvasById(store, input.canvasId); store.canvases = store.canvases.filter((item) => item.id !== canvas.id); if (store.currentCanvasId === canvas.id) store.currentCanvasId = store.canvases[0]?.id || null; writeStore(store); result = { deleted: canvas.id, currentCanvasId: store.currentCanvasId };
  } else if (name === 'canvas_execute_action') {
    result = applyConductorAction(store, input.action);
  } else if (name === 'canvas_project_database') {
    if (!input.request || typeof input.request !== 'object') fail('request must include projectPath and command.');
    result = await projectDatabase.invoke(input.request);
  } else if (name === 'canvas_settings_get') {
    result = { value: await settingsStore.get(input.key) };
  } else if (name === 'canvas_settings_set') {
    result = { success: await settingsStore.set(input.key, input.value) };
  } else if (name === 'canvas_provider_status') {
    result = await settingsStore.providerStatus();
  } else if (name === 'canvas_provider_list') {
    result = { providers: await settingsStore.listProviders() };
  } else if (name === 'canvas_provider_configure') {
    result = await settingsStore.configureProvider(input);
  } else if (name === 'canvas_refine_call') {
    result = await callRefine(input);
  } else if (name === 'canvas_get_knowledge') {
    result = { coordinateSystem: 'Canvas uses 40 × 30 grid units with origin at the top-left.', guidance: 'Leave breathing room between elements, place related notes close together, and connect only directly related items.' };
  } else if (name === 'canvas_import') {
    if (store.canvases.length >= MAX_CANVASES) fail('Canvas limit reached.');
    if (JSON.stringify(input.snapshot).length > 50_000_000) fail('Snapshot import, including assets, is limited to 50 MB.');
    const canvas = importedCanvas(input.snapshot, input.name);
    const assets = validateBundleAssets(input.snapshot.assets);
    const assetIds = storeBundleAssets(assets);
    canvas.elements = canvas.elements.map((element) => remapAssetReferences(element, assetIds));
    canvas.widgets = canvas.widgets.map((widget) => remapAssetReferences(widget, assetIds));
    store.canvases.unshift(canvas); store.currentCanvasId = canvas.id; writeStore(store); result = { canvas: summary(canvas), currentCanvasId: canvas.id, importedElements: canvas.elements.length };
  } else if (name === 'canvas_import_bundle') {
    const bundle = input.bundle;
    if (!bundle || bundle.format !== 'duya.conductor-legacy-bundle' || bundle.version !== 1 || !Array.isArray(bundle.canvases)) fail('Unsupported legacy Canvas bundle.');
    if (bundle.canvases.length > MAX_CANVASES - store.canvases.length) fail('Canvas limit reached.');
    if (JSON.stringify(bundle).length > 50_000_000) fail('Bundle import is limited to 50 MB.');
    const bundleAssets = validateBundleAssets(bundle.assets);
    const assetIds = storeBundleAssets(bundleAssets);
    const projectDatabases = Array.isArray(bundle.projectDatabases) ? bundle.projectDatabases : [];
    if (projectDatabases.length > 500) fail('A bundle may include at most 500 project databases.');
    const importedProjectDatabases = [];
    for (const projectDb of projectDatabases) {
      if (!projectDb || typeof projectDb.projectPath !== 'string') fail('Invalid legacy project database entry.');
      importedProjectDatabases.push(await projectDatabase.importLegacy(projectDb.projectPath, projectDb));
    }
    const groupIds = new Map();
    const groups = Array.isArray(bundle.groups) ? bundle.groups : [];
    for (const group of groups) {
      if (!group || typeof group.id !== 'string' || typeof group.name !== 'string') fail('Invalid Canvas group.');
      const newGroup = { id: randomUUID(), name: group.name.trim().slice(0, 80), sortOrder: Number(group.sortOrder) || 0, projectPath: null, createdAt: group.createdAt || now(), updatedAt: group.updatedAt || now(), legacy: group };
      store.groups.push(newGroup); groupIds.set(group.id, newGroup.id);
    }
    const canvases = bundle.canvases.map((item) => {
      const imported = importedCanvas(item, undefined, groupIds);
      imported.elements = imported.elements.map((element) => remapAssetReferences(element, assetIds));
      imported.widgets = imported.widgets.map((widget) => remapAssetReferences(widget, assetIds));
      return imported;
    });
    store.canvases.unshift(...canvases);
    if (canvases.length) store.currentCanvasId = canvases[0].id;
    writeStore(store);
    result = { importedCanvases: canvases.length, importedElements: canvases.reduce((sum, canvas) => sum + canvas.elements.length, 0), importedAssets: assetIds.size, importedProjectDatabases: importedProjectDatabases.length, currentCanvasId: store.currentCanvasId };
  } else {
    const canvas = canvasById(store, input.canvasId);
    const beforeElements = canvasHistoryState(canvas);
    switch (name) {
      case 'canvas_get_snapshot':
      case 'canvas_export': result = snapshotWithAssets(canvas); break;
      case 'canvas_list_elements': result = { canvasId: canvas.id, elements: canvas.elements.map(elementSummary), count: canvas.elements.length }; break;
      case 'canvas_create_element': {
        if (canvas.elements.length >= MAX_ELEMENTS) fail('Element limit reached.');
        const elementTypes = ['shape', 'sticky', 'text', 'document', 'table', 'link', 'image', 'file', 'pdf', 'database', 'section', 'frame', 'widget'];
        if (!elementTypes.includes(input.type)) fail('Unsupported canvas element type.');
        const nativeKinds = ['shape', 'sticky', 'text', 'document', 'table', 'link', 'image', 'file', 'pdf', 'database', 'section', 'frame'];
        const element = { id: randomUUID(), canvasId: canvas.id, type: input.type, elementKind: input.type.startsWith('native/') ? input.type : nativeKinds.includes(input.type) ? `native/${input.type}` : input.type === 'widget' ? 'widget/dynamic' : input.type, nativeKind: nativeKinds.includes(input.type) ? input.type : undefined, position: clampPosition(input.position || {}), config: input.config && typeof input.config === 'object' ? input.config : {}, createdAt: now(), updatedAt: now() };
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
        const previous = canvas.undoStack.pop();
        const actionId = previous.appliedActionId || canvas.actionCursor;
        canvas.redoStack = canvas.redoStack || [];
        canvas.redoStack.push({ ...canvasHistoryState(canvas), appliedActionId: actionId });
        restoreHistoryState(canvas, previous);
        const action = (canvas.actions || []).find((entry) => entry.id === actionId);
        if (action) action.undoneAt = Date.now();
        result = { undone: true, inverted: true, actionId, canUndo: canvas.undoStack.length > 0, canRedo: true }; break;
      }
      case 'canvas_redo': {
        if (!canvas.redoStack || !canvas.redoStack.length) fail('There is no canvas change to redo.');
        const next = canvas.redoStack.pop();
        const actionId = next.appliedActionId || next.actionCursor;
        canvas.undoStack = canvas.undoStack || [];
        canvas.undoStack.push({ ...canvasHistoryState(canvas), appliedActionId: actionId });
        restoreHistoryState(canvas, next);
        const action = (canvas.actions || []).find((entry) => entry.id === actionId);
        if (action) action.undoneAt = null;
        result = { redone: true, patch: true, actionId, canUndo: true, canRedo: canvas.redoStack.length > 0 }; break;
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
      recordCanvasChange(canvas, beforeElements, { ...input, action: name }, result);
    }
    if (mutatingTools.has(name) || name === 'canvas_undo' || name === 'canvas_redo') {
      canvas.updatedAt = now(); writeStore(store);
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
    if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'conductor_canvas', version: '0.4.0' } } };
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

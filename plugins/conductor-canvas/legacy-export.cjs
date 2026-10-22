#!/usr/bin/env node
'use strict';

// Explicit, read-only export of DUYA's former Conductor SQLite data. Run this
// separately from the plugin service and import the resulting JSON in the App.
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const databasePath = process.argv[2];
const outputPath = process.argv[3];
const assetRoot = process.argv[4];
if (!databasePath || !outputPath || process.argv.length > 5) {
  process.stderr.write('Usage: node legacy-export.cjs /path/to/duya-main.db /path/to/canvases.json [path/to/conductor-assets]\n');
  process.exit(2);
}
if (!fs.existsSync(databasePath)) throw new Error(`Database does not exist: ${databasePath}`);
if (fs.existsSync(outputPath)) throw new Error(`Output already exists: ${outputPath}`);

const database = new DatabaseSync(databasePath, { readOnly: true });
const parse = (value, fallback) => {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};
const mimeFor = (fileName) => ({
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp',
}[require('node:path').extname(fileName).toLowerCase()] || 'application/octet-stream');
const MAX_IMPORTED_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_BUNDLE_ASSET_BYTES = 35 * 1024 * 1024;
const path = require('node:path');
const hasTable = (name) => Boolean(database.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name));
const rows = (name, canvasId) => hasTable(name)
  ? database.prepare(`SELECT * FROM ${name} WHERE canvas_id = ?`).all(canvasId)
  : [];

try {
  database.exec('PRAGMA query_only = ON; BEGIN');
  if (!hasTable('conductor_canvases')) throw new Error('This database has no Conductor Canvas data.');
  const groups = hasTable('conductor_canvas_groups')
    ? database.prepare('SELECT * FROM conductor_canvas_groups').all().map((row) => ({
      id: row.id, name: row.name, sortOrder: row.sort_order, projectPath: row.project_path,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })) : [];
  let assetBytes = 0;
  const assets = [];
  const canvases = database.prepare('SELECT * FROM conductor_canvases ORDER BY sort_order, created_at').all().map((row) => {
    const widgets = rows('conductor_widgets', row.id).map((widget) => ({
      id: widget.id, canvasId: widget.canvas_id, kind: widget.kind, type: widget.type,
      position: parse(widget.position, {}), config: parse(widget.config, {}),
      data: parse(widget.data, {}), dataVersion: widget.data_version,
      sourceCode: widget.source_code, state: widget.state,
      permissions: parse(widget.permissions, {}), createdAt: widget.created_at, updatedAt: widget.updated_at,
    }));
    const elementRows = rows('conductor_elements', row.id);
    const elements = elementRows.map((element) => ({
      id: element.id, canvasId: element.canvas_id, elementKind: element.element_kind,
      nativeKind: element.native_kind, position: parse(element.position, {}),
      config: parse(element.config, {}), vizSpec: parse(element.viz_spec, null),
      sourceCode: element.source_code, state: element.state, dataVersion: element.data_version,
      permissions: parse(element.permissions, {}), metadata: parse(element.metadata, {}),
      createdAt: element.created_at, updatedAt: element.updated_at,
    }));
    const assetCandidates = [
      row.project_path ? path.join(row.project_path, '.duya', 'assets', row.id) : null,
      assetRoot ? path.join(assetRoot, row.id) : null,
    ].filter(Boolean);
    const canvasAssetDir = assetCandidates.find((candidate) => fs.existsSync(candidate));
    if (canvasAssetDir && fs.existsSync(canvasAssetDir)) {
      for (const entry of fs.readdirSync(canvasAssetDir, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.endsWith('.json')) continue;
        const match = entry.name.match(/^([a-f0-9-]{32,36})-(.+)$/i);
        if (!match) continue;
        const file = path.join(canvasAssetDir, entry.name);
        const bytes = fs.readFileSync(file);
        if (bytes.length > MAX_IMPORTED_ASSET_BYTES) throw new Error(`Asset ${entry.name} exceeds the plugin's 5 MB asset limit; reduce it before export.`);
        assetBytes += bytes.length;
        if (assetBytes > MAX_BUNDLE_ASSET_BYTES) throw new Error('Assets exceed the 35 MB legacy bundle limit; export fewer canvases at a time.');
        assets.push({ canvasId: row.id, assetId: match[1], name: match[2], mimeType: mimeFor(match[2]), base64: bytes.toString('base64') });
      }
    }
    // Older databases stored Canvas content only in conductor_widgets.
    if (!elements.length) for (const widget of widgets) elements.push({
      id: widget.id, canvasId: widget.canvasId, elementKind: `widget/${widget.type}`,
      position: widget.position, config: widget.config, sourceCode: widget.sourceCode,
      state: widget.state, dataVersion: widget.dataVersion, permissions: widget.permissions,
      createdAt: widget.createdAt, updatedAt: widget.updatedAt,
    });
    return {
      canvas: { id: row.id, name: row.name, description: row.description,
        layoutConfig: parse(row.layout_config, {}), sortOrder: row.sort_order,
        projectPath: row.project_path, isFavorite: row.is_favorite === 1,
        groupId: row.group_id, tags: parse(row.tags, []),
        createdAt: row.created_at, updatedAt: row.updated_at },
      elements, widgets,
      actions: rows('conductor_actions', row.id).map((action) => ({ ...action,
        canvasId: action.canvas_id, widgetId: action.widget_id, actionType: action.action_type,
        payload: parse(action.payload, null), resultPatch: parse(action.result_patch, null),
        mergedFrom: action.merged_from, undoneAt: action.undone_at })),
    };
  });
  database.exec('COMMIT');
  fs.writeFileSync(outputPath, JSON.stringify({ format: 'duya.conductor-legacy-bundle', version: 1, groups, canvases, assets }, null, 2), { flag: 'wx', mode: 0o600 });
  process.stderr.write(`Exported ${canvases.length} canvases and ${assets.length} assets to ${outputPath}\n`);
} catch (error) {
  try { database.exec('ROLLBACK'); } catch { /* no active transaction */ }
  throw error;
} finally {
  database.close();
}

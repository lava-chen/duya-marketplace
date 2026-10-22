'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

test('legacy exporter includes action data and falls back to the supplied asset root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'legacy.db');
  const outputPath = path.join(root, 'bundle.json');
  const assetRoot = path.join(root, 'assets');
  const canvasId = 'canvas-legacy';
  const assetId = '12345678-1234-1234-1234-123456789012';
  const assetDir = path.join(assetRoot, canvasId);
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(path.join(assetDir, `${assetId}-attachment.png`), Buffer.from('image bytes'));

  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE conductor_canvases (id TEXT, name TEXT, description TEXT, layout_config TEXT, sort_order INTEGER, project_path TEXT, is_favorite INTEGER, group_id TEXT, tags TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE conductor_elements (id TEXT, canvas_id TEXT, element_kind TEXT, native_kind TEXT, position TEXT, config TEXT, viz_spec TEXT, source_code TEXT, state TEXT, data_version INTEGER, permissions TEXT, metadata TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE conductor_widgets (id TEXT, canvas_id TEXT, kind TEXT, type TEXT, position TEXT, config TEXT, data TEXT, data_version INTEGER, source_code TEXT, state TEXT, permissions TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE conductor_actions (id INTEGER, canvas_id TEXT, widget_id TEXT, actor TEXT, action_type TEXT, payload TEXT, result_patch TEXT, merged_from TEXT, reversible INTEGER, ts INTEGER, undone_at INTEGER);
    INSERT INTO conductor_canvases VALUES ('canvas-legacy', 'Legacy', NULL, '{}', 3, '/missing/project', 0, NULL, '[]', 10, 20);
    INSERT INTO conductor_elements VALUES ('element-1', 'canvas-legacy', 'native/connector', 'connector', '{"x":0,"y":0,"w":0,"h":0,"zIndex":2,"rotation":0}', '{"source":{"kind":"bound","nodeId":"a","bindingPoint":{"u":0.5,"v":1}},"target":{"kind":"free","point":{"x":8,"y":9}}}', NULL, NULL, 'idle', 1, '{}', '{}', 11, 12);
    INSERT INTO conductor_actions VALUES (1, 'canvas-legacy', NULL, 'user', 'connector.create', '{"source":"a"}', '{"elementId":"element-1"}', NULL, 1, 12, NULL);
  `);
  database.close();

  const result = spawnSync(process.execPath, [path.join(__dirname, 'legacy-export.cjs'), databasePath, outputPath, assetRoot], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const bundle = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(bundle.canvases[0].elements[0].elementKind, 'native/connector');
  assert.deepEqual(bundle.canvases[0].elements[0].config.source, { kind: 'bound', nodeId: 'a', bindingPoint: { u: 0.5, v: 1 } });
  assert.equal(bundle.canvases[0].actions[0].action_type, 'connector.create');
  assert.equal(bundle.canvases[0].actions[0].actionType, 'connector.create');
  assert.equal(bundle.assets.length, 1);
  assert.equal(bundle.assets[0].assetId, assetId);
  assert.equal(Buffer.from(bundle.assets[0].base64, 'base64').toString(), 'image bytes');
});

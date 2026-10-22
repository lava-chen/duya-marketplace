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
  const projectPath = path.join(root, 'project');
  const canvasId = 'canvas-legacy';
  const assetId = '12345678-1234-1234-1234-123456789012';
  const assetDir = path.join(assetRoot, canvasId);
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(path.join(assetDir, `${assetId}-attachment.png`), Buffer.from('image bytes'));
  const projectDatabasePath = path.join(projectPath, '.duya', 'database.sqlite');
  fs.mkdirSync(path.dirname(projectDatabasePath), { recursive: true });
  const projectDatabase = new DatabaseSync(projectDatabasePath);
  projectDatabase.exec(`
    CREATE TABLE db_sources (id TEXT, name TEXT, description TEXT, icon_json TEXT, created_at INTEGER, updated_at INTEGER, archived_at INTEGER);
    CREATE TABLE db_properties (id TEXT, source_id TEXT, name TEXT, type TEXT, config_json TEXT, position TEXT, created_at INTEGER, updated_at INTEGER, archived_at INTEGER);
    CREATE TABLE db_property_options (id TEXT, property_id TEXT, name TEXT, color TEXT, group_id TEXT, position TEXT, archived_at INTEGER);
    CREATE TABLE db_records (id TEXT, source_id TEXT, title_plain TEXT, title_rich_json TEXT, body_path TEXT, body_hash TEXT, icon_json TEXT, cover_json TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER, archived_at INTEGER);
    CREATE TABLE db_values (record_id TEXT, property_id TEXT, value_type TEXT, text_value TEXT, number_value REAL, boolean_value INTEGER, date_start TEXT, date_end TEXT, date_timezone TEXT, reference_value TEXT, json_value TEXT, revision INTEGER, updated_at INTEGER);
    CREATE TABLE db_value_refs (record_id TEXT, property_id TEXT, target_kind TEXT, target_id TEXT, position TEXT);
    CREATE TABLE db_views (id TEXT, source_id TEXT, name TEXT, type TEXT, filter_json TEXT, sort_json TEXT, quick_filters_json TEXT, layout_json TEXT, created_at INTEGER, updated_at INTEGER, archived_at INTEGER);
    CREATE TABLE db_view_record_positions (view_id TEXT, record_id TEXT, group_key TEXT, rank TEXT);
    CREATE TABLE db_relation_edges (property_id TEXT, source_record_id TEXT, target_record_id TEXT, rank TEXT);
    CREATE TABLE db_events (id TEXT, source_id TEXT, record_id TEXT, actor_type TEXT, actor_id TEXT, operation TEXT, payload_json TEXT, inverse_json TEXT, created_at INTEGER);
    INSERT INTO db_sources VALUES ('source-1', 'Customers', NULL, NULL, 1, 2, NULL);
    INSERT INTO db_properties VALUES ('title-1', 'source-1', 'Name', 'title', '{"type":"title"}', '000000001024', 1, 1, NULL);
    INSERT INTO db_records VALUES ('record-1', 'source-1', 'Ada', NULL, NULL, NULL, NULL, NULL, 1, 2, 3, NULL);
    INSERT INTO db_views VALUES ('view-1', 'source-1', 'All customers', 'table', NULL, '[]', '[]', '{"visiblePropertyIds":["title-1"]}', 1, 2, NULL);
  `);
  projectDatabase.close();

  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE conductor_canvases (id TEXT, name TEXT, description TEXT, layout_config TEXT, sort_order INTEGER, project_path TEXT, is_favorite INTEGER, group_id TEXT, tags TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE conductor_elements (id TEXT, canvas_id TEXT, element_kind TEXT, native_kind TEXT, position TEXT, config TEXT, viz_spec TEXT, source_code TEXT, state TEXT, data_version INTEGER, permissions TEXT, metadata TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE conductor_widgets (id TEXT, canvas_id TEXT, kind TEXT, type TEXT, position TEXT, config TEXT, data TEXT, data_version INTEGER, source_code TEXT, state TEXT, permissions TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE conductor_actions (id INTEGER, canvas_id TEXT, widget_id TEXT, actor TEXT, action_type TEXT, payload TEXT, result_patch TEXT, merged_from TEXT, reversible INTEGER, ts INTEGER, undone_at INTEGER);
    INSERT INTO conductor_canvases VALUES ('canvas-legacy', 'Legacy', NULL, '{}', 3, '${projectPath.replaceAll("'", "''")}', 0, NULL, '[]', 10, 20);
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
  assert.equal(bundle.projectDatabases.length, 1);
  assert.equal(bundle.projectDatabases[0].projectPath, projectPath);
  assert.equal(bundle.projectDatabases[0].sources[0].id, 'source-1');
  assert.equal(bundle.projectDatabases[0].views[0].id, 'view-1');
});

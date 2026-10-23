'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectDatabase, ProjectDatabaseError } = require('./project-database.cjs');

function fixture(t) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-project-db-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  return { dataRoot, db: createProjectDatabase({ dataRoot }) };
}

test('source, property, record and view requests persist and query typed values', async (t) => {
  const { dataRoot, db } = fixture(t);
  const request = (command, projectPath = '/workspace/example') => db.invoke({ projectPath, command });
  const created = await request({ type: 'source.create', name: 'Tasks' });
  const sourceId = created.source.id;
  assert.equal(created.properties[0].type, 'title');
  assert.equal(created.views[0].type, 'table');

  const status = await request({ type: 'property.create', sourceId, name: 'Status', propertyType: 'select', options: [{ name: 'Open' }, { name: 'Done' }] });
  const doneId = status.options.find((option) => option.name === 'Done').id;
  const priority = await request({ type: 'property.create', sourceId, name: 'Priority', propertyType: 'number' });
  const record = await request({ type: 'record.create', sourceId, title: 'Ship plugin', values: { [status.id]: doneId, [priority.id]: 3 } });
  const view = await request({ type: 'view.create', sourceId, name: 'High priority', filter: { propertyId: priority.id, operator: 'greater_than', value: 2 }, sorts: [{ propertyId: priority.id, direction: 'desc' }] });
  const result = await request({ type: 'query', sourceId, viewId: view.id, limit: 10 });
  assert.deepEqual(result.records.map((item) => item.record.id), [record.record.id]);
  assert.equal(result.records[0].values[status.id], doneId);
  assert.deepEqual(result.properties.map((p) => p.id), created.properties.map((p) => p.id).concat([status.id, priority.id]));

  const reopened = createProjectDatabase({ dataRoot });
  const persisted = await reopened.invoke({ projectPath: '/workspace/example', command: { type: 'source.get', sourceId } });
  assert.equal(persisted.source.name, 'Tasks');
  assert.equal(persisted.properties.find((p) => p.id === status.id).options.length, 2);
  assert.equal((await reopened.invoke({ projectPath: '/workspace/other', command: { type: 'source.list' } })).length, 0);
});

test('record revisions reject stale writes and archive state can be restored', async (t) => {
  const { db } = fixture(t);
  const projectPath = '/workspace/cas';
  const source = await db.invoke({ projectPath, command: { type: 'source.create', name: 'CAS' } });
  const created = await db.invoke({ projectPath, command: { type: 'record.create', sourceId: source.source.id, title: 'Initial' } });
  const updated = await db.invoke({ projectPath, command: { type: 'record.update', sourceId: source.source.id, recordId: created.record.id, expectedRevision: 1, title: 'Edited' } });
  assert.equal(updated.record.revision, 2);
  await assert.rejects(
    db.invoke({ projectPath, command: { type: 'record.update', sourceId: source.source.id, recordId: created.record.id, expectedRevision: 1, title: 'Stale' } }),
    (error) => error instanceof ProjectDatabaseError && error.code === 'CONFLICT' && error.details.actualRevision === 2,
  );
  const archived = await db.invoke({ projectPath, command: { type: 'record.archive', sourceId: source.source.id, recordId: created.record.id, expectedRevision: 2 } });
  assert.ok(archived.record.archivedAt);
  const restored = await db.invoke({ projectPath, command: { type: 'record.archive', sourceId: source.source.id, recordId: created.record.id, expectedRevision: 3, archived: false } });
  assert.equal(restored.record.archivedAt, null);
});

test('separate plugin instances serialize writes without losing updates', async (t) => {
  const { dataRoot } = fixture(t);
  const first = createProjectDatabase({ dataRoot });
  const second = createProjectDatabase({ dataRoot });
  const projectPath = '/workspace/concurrent';
  const created = await first.invoke({ projectPath, command: { type: 'source.create', name: 'Shared' } });
  const [one, two] = await Promise.all([
    first.invoke({ projectPath, command: { type: 'record.create', sourceId: created.source.id, title: 'One' } }),
    second.invoke({ projectPath, command: { type: 'record.create', sourceId: created.source.id, title: 'Two' } }),
  ]);
  assert.notEqual(one.record.id, two.record.id);
  const result = await first.invoke({ projectPath, command: { type: 'query', sourceId: created.source.id } });
  assert.deepEqual(new Set(result.records.map((item) => item.record.title)), new Set(['One', 'Two']));
});

test('request validation rejects unknown fields, invalid values, and project path traversal', async (t) => {
  const { dataRoot, db } = fixture(t);
  await assert.rejects(db.invoke({ projectPath: '/workspace/x', command: { type: 'source.create', name: 'x', admin: true } }), ProjectDatabaseError);
  await assert.rejects(db.invoke({ projectPath: '/workspace/x', command: { type: 'property.create', sourceId: 'missing', name: 'bad', propertyType: 'text', options: [{ name: 'not allowed' }] } }), ProjectDatabaseError);
  const source = await db.invoke({ projectPath: '../outside', command: { type: 'source.create', name: 'Safe' } });
  assert.equal(source.source.name, 'Safe');
  assert.deepEqual(fs.readdirSync(dataRoot), ['project-databases']);
});

'use strict';

// Small plugin-owned implementation of Conductor's project database request
// contract. Project paths are opaque identifiers: they are hashed before being
// used on disk, so callers cannot escape the injected data root.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROPERTY_TYPES = new Set(['title', 'text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url']);
const FILTER_OPERATORS = new Set(['equals', 'not_equals', 'contains', 'is_empty', 'greater_than', 'less_than', 'before', 'after']);
const ACTORS = new Set(['user', 'agent', 'system']);

class ProjectDatabaseError extends Error {
  constructor(message, code = 'INVALID_REQUEST', details) {
    super(message);
    this.name = 'ProjectDatabaseError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(message, code, details) { throw new ProjectDatabaseError(message, code, details); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function assertObject(value, name) { if (!isObject(value)) fail(`${name} must be an object.`); }
function assertString(value, name, min = 1, max = Infinity) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) fail(`${name} must be a string of ${min} to ${max} characters.`);
}
function assertKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${name} contains unsupported field: ${key}`);
}
function validateValue(value, name = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return;
  if (isObject(value) && typeof value.start === 'string' && value.start.length > 0
      && (value.end === undefined || value.end === null || typeof value.end === 'string')
      && (value.timezone === undefined || value.timezone === null || typeof value.timezone === 'string')) {
    assertKeys(value, new Set(['start', 'end', 'timezone']), name); return;
  }
  fail(`${name} must be a string, finite number, boolean, string array, date range, or null.`);
}
function validateFilter(filter, depth = 0) {
  if (depth > 20) fail('Filter nesting exceeds 20 levels.', 'INVALID_QUERY');
  assertObject(filter, 'filter');
  if (Object.keys(filter).length === 1 && Array.isArray(filter.and)) {
    if (!filter.and.length) fail('filter.and must not be empty.', 'INVALID_QUERY');
    filter.and.forEach((node) => validateFilter(node, depth + 1)); return;
  }
  if (Object.keys(filter).length === 1 && Array.isArray(filter.or)) {
    if (!filter.or.length) fail('filter.or must not be empty.', 'INVALID_QUERY');
    filter.or.forEach((node) => validateFilter(node, depth + 1)); return;
  }
  assertKeys(filter, new Set(['propertyId', 'operator', 'value']), 'filter');
  assertString(filter.propertyId, 'filter.propertyId');
  if (!FILTER_OPERATORS.has(filter.operator)) fail('Invalid filter operator.', 'INVALID_QUERY');
  if (Object.hasOwn(filter, 'value')) validateValue(filter.value, 'filter.value');
}
function validateCommand(command) {
  assertObject(command, 'command');
  assertString(command.type, 'command.type');
  const fields = {
    initialize: [], 'source.list': ['includeArchived'], 'source.get': ['sourceId'],
    'source.create': ['name', 'description', 'actor'], 'source.archive': ['sourceId', 'archived', 'actor'],
    'property.create': ['sourceId', 'name', 'propertyType', 'config', 'options', 'actor'],
    'record.create': ['sourceId', 'title', 'values', 'actor'],
    'record.update': ['sourceId', 'recordId', 'expectedRevision', 'title', 'values', 'actor'],
    'record.archive': ['sourceId', 'recordId', 'expectedRevision', 'archived', 'actor'],
    'view.list': ['sourceId'], 'view.create': ['sourceId', 'name', 'viewType', 'filter', 'sorts', 'layout', 'actor'],
    'view.update': ['sourceId', 'viewId', 'name', 'filter', 'sorts', 'layout', 'actor'],
    query: ['sourceId', 'viewId', 'filter', 'sorts', 'projection', 'limit', 'cursor', 'includeArchived'],
  };
  if (!Object.hasOwn(fields, command.type)) fail(`Unsupported project database command: ${command.type}`);
  assertKeys(command, new Set(['type', ...fields[command.type]]), 'command');
  const need = (...keys) => keys.forEach((key) => assertString(command[key], `command.${key}`));
  const optionalString = (key, max = Infinity) => { if (command[key] !== undefined) assertString(command[key], `command.${key}`, 0, max); };
  const actor = () => { if (command.actor !== undefined && !ACTORS.has(command.actor)) fail('command.actor is invalid.'); };
  const values = () => {
    if (command.values === undefined) return;
    assertObject(command.values, 'command.values');
    for (const [key, value] of Object.entries(command.values)) { assertString(key, 'propertyId'); validateValue(value, `values.${key}`); }
  };
  const sorts = () => {
    if (command.sorts === undefined) return;
    if (!Array.isArray(command.sorts) || command.sorts.length > 20) fail('command.sorts must be an array of at most 20 rules.');
    command.sorts.forEach((rule) => { assertObject(rule, 'sort'); assertKeys(rule, new Set(['propertyId', 'direction']), 'sort'); assertString(rule.propertyId, 'sort.propertyId'); if (!['asc', 'desc'].includes(rule.direction)) fail('sort.direction must be asc or desc.'); });
  };
  const revision = () => { need('sourceId', 'recordId'); if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) fail('expectedRevision must be a positive integer.'); };
  switch (command.type) {
    case 'initialize': break;
    case 'source.list': if (command.includeArchived !== undefined && typeof command.includeArchived !== 'boolean') fail('includeArchived must be boolean.'); break;
    case 'source.get': case 'view.list': need('sourceId'); break;
    case 'source.create': need('name'); assertString(command.name, 'name', 1, 200); optionalString('description', 2000); actor(); break;
    case 'source.archive': need('sourceId'); if (command.archived !== undefined && typeof command.archived !== 'boolean') fail('archived must be boolean.'); actor(); break;
    case 'property.create':
      need('sourceId', 'name', 'propertyType'); assertString(command.name, 'name', 1, 120);
      if (!PROPERTY_TYPES.has(command.propertyType) || command.propertyType === 'title') fail('propertyType is invalid.');
      if (command.config !== undefined) assertObject(command.config, 'config');
      if (command.options !== undefined) {
        if (!Array.isArray(command.options) || command.options.length > 200) fail('options must contain at most 200 items.');
        command.options.forEach((option) => { assertObject(option, 'option'); assertKeys(option, new Set(['name', 'color', 'groupId']), 'option'); assertString(option.name, 'option.name', 1, 120); for (const k of ['color', 'groupId']) if (option[k] !== undefined && option[k] !== null) assertString(option[k], `option.${k}`, 0); });
        if (command.options.length && !['select', 'multi_select', 'status'].includes(command.propertyType)) fail(`${command.propertyType} properties cannot define options`, 'INVALID_VALUE');
      }
      actor(); break;
    case 'record.create': need('sourceId'); optionalString('title', 10000); values(); actor(); break;
    case 'record.update': revision(); optionalString('title', 10000); values(); actor(); break;
    case 'record.archive': revision(); if (command.archived !== undefined && typeof command.archived !== 'boolean') fail('archived must be boolean.'); actor(); break;
    case 'view.create': case 'view.update':
      need('sourceId'); if (command.type === 'view.update') need('viewId');
      if (command.name !== undefined) assertString(command.name, 'name', 1, 120);
      if (command.type === 'view.create') { need('name'); if (command.viewType !== undefined && command.viewType !== 'table') fail('Only table views are supported.'); }
      if (command.filter !== undefined && command.filter !== null) validateFilter(command.filter);
      sorts(); if (command.layout !== undefined) assertObject(command.layout, 'layout'); actor(); break;
    case 'query':
      need('sourceId'); if (command.viewId !== undefined) assertString(command.viewId, 'viewId');
      if (command.filter !== undefined && command.filter !== null) validateFilter(command.filter);
      sorts();
      if (command.projection !== undefined && (!Array.isArray(command.projection) || command.projection.length > 100 || !command.projection.every((x) => typeof x === 'string' && x.length))) fail('projection must be an array of at most 100 property IDs.');
      if (command.limit !== undefined && (!Number.isSafeInteger(command.limit) || command.limit < 1 || command.limit > 500)) fail('limit must be an integer from 1 to 500.');
      if (command.cursor !== undefined) assertString(command.cursor, 'cursor');
      if (command.includeArchived !== undefined && typeof command.includeArchived !== 'boolean') fail('includeArchived must be boolean.'); break;
  }
  return command;
}

function rank(index) { return String((index + 1) * 1024).padStart(12, '0'); }
function timestamp() { return Date.now(); }
function defaultStore() { return { version: 1, sources: [], properties: [], options: [], records: [], values: [], views: [], events: [] }; }
function byId(list, id) { return list.find((row) => row.id === id); }
function active(list) { return list.filter((row) => row.archivedAt === null); }
function sourceOrThrow(store, id, includeArchived = false) {
  const row = byId(store.sources, id);
  if (!row || (!includeArchived && row.archivedAt !== null)) fail(`Database source ${id} not found`, 'NOT_FOUND');
  return row;
}
function propertiesFor(store, sourceId) {
  return active(store.properties.filter((p) => p.sourceId === sourceId)).sort((a, b) => a.position.localeCompare(b.position) || a.createdAt - b.createdAt)
    .map((p) => ({ ...p, options: active(store.options.filter((o) => o.propertyId === p.id)).sort((a, b) => a.position.localeCompare(b.position)) }));
}
function viewsFor(store, sourceId) { return active(store.views.filter((v) => v.sourceId === sourceId)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)); }
function sourceSnapshot(store, sourceId) { return { source: { ...sourceOrThrow(store, sourceId) }, properties: propertiesFor(store, sourceId), views: viewsFor(store, sourceId) }; }
function recordById(store, sourceId, recordId) {
  const row = store.records.find((item) => item.id === recordId && item.sourceId === sourceId);
  if (!row) fail(`Record ${recordId} not found`, 'NOT_FOUND'); return row;
}
function recordSnapshot(store, row) {
  return { record: { ...row }, values: Object.fromEntries(store.values.filter((v) => v.recordId === row.id).map((v) => [v.propertyId, v.value])) };
}
function allRecordSnapshots(store, sourceId, includeArchived = false) {
  return store.records.filter((r) => r.sourceId === sourceId && (includeArchived || r.archivedAt === null))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map((r) => recordSnapshot(store, r));
}
function validatePropertyValue(property, value) {
  if (value === null) return;
  const invalid = (expected) => fail(`${property.name} expects ${expected}`, 'INVALID_VALUE');
  switch (property.type) {
    case 'title': invalid('the record title'); break;
    case 'text': case 'url': if (typeof value !== 'string') invalid('text'); break;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) invalid('a number'); break;
    case 'checkbox': if (typeof value !== 'boolean') invalid('a checkbox value'); break;
    case 'select': case 'status':
      if (typeof value !== 'string') invalid('an option ID');
      if (!property.options.some((o) => o.id === value)) fail(`Option ${value} does not belong to property ${property.id}`, 'INVALID_VALUE'); break;
    case 'multi_select':
      if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) invalid('option IDs');
      for (const id of value) if (!property.options.some((o) => o.id === id)) fail(`Option ${id} does not belong to property ${property.id}`, 'INVALID_VALUE'); break;
    case 'date': if (!isObject(value) || typeof value.start !== 'string') invalid('a date range'); break;
  }
}
function propertyMap(store, sourceId) { return new Map(propertiesFor(store, sourceId).map((p) => [p.id, p])); }
function setValues(store, record, values) {
  const props = propertyMap(store, record.sourceId);
  for (const [propertyId, value] of Object.entries(values || {})) {
    const property = props.get(propertyId);
    if (!property) fail(`Unknown property ${propertyId}`, 'INVALID_VALUE');
    validatePropertyValue(property, value);
    store.values = store.values.filter((item) => !(item.recordId === record.id && item.propertyId === propertyId));
    if (value !== null) store.values.push({ recordId: record.id, propertyId, value });
  }
}
function valueFor(record, property) { return property.type === 'title' ? record.record.title : record.values[property.id] ?? null; }
function assertFilter(filter, props) {
  if (filter.and) return filter.and.forEach((f) => assertFilter(f, props));
  if (filter.or) return filter.or.forEach((f) => assertFilter(f, props));
  const p = props.get(filter.propertyId);
  if (!p) fail(`Unknown filter property ${filter.propertyId}`, 'INVALID_QUERY');
  const allowed = new Set(['equals', 'not_equals', 'is_empty']);
  if (['text', 'url', 'title', 'multi_select'].includes(p.type)) allowed.add('contains');
  if (p.type === 'number') { allowed.add('greater_than'); allowed.add('less_than'); }
  if (p.type === 'date') { allowed.add('before'); allowed.add('after'); }
  if (!allowed.has(filter.operator)) fail(`${filter.operator} is not valid for ${p.type}`, 'INVALID_QUERY');
}
function comparable(value) { if (value == null || Array.isArray(value)) return null; return isObject(value) ? value.start : value; }
function filterMatches(record, filter, props) {
  if (filter.and) return filter.and.every((f) => filterMatches(record, f, props));
  if (filter.or) return filter.or.some((f) => filterMatches(record, f, props));
  const actual = valueFor(record, props.get(filter.propertyId)); const expected = filter.value ?? null;
  switch (filter.operator) {
    case 'is_empty': return actual === null || actual === '' || (Array.isArray(actual) && actual.length === 0);
    case 'equals': return JSON.stringify(actual) === JSON.stringify(expected);
    case 'not_equals': return JSON.stringify(actual) !== JSON.stringify(expected);
    case 'contains': return Array.isArray(actual) ? typeof expected === 'string' && actual.includes(expected) : String(actual ?? '').toLocaleLowerCase().includes(String(expected ?? '').toLocaleLowerCase());
    case 'greater_than': return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'less_than': return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'before': return typeof comparable(actual) === 'string' && typeof comparable(expected) === 'string' && comparable(actual) < comparable(expected);
    case 'after': return typeof comparable(actual) === 'string' && typeof comparable(expected) === 'string' && comparable(actual) > comparable(expected);
  }
}
function compare(left, right) {
  const a = comparable(left); const b = comparable(right);
  if (a === b) return 0; if (a === null) return 1; if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}
function query(store, command) {
  const snapshot = sourceSnapshot(store, command.sourceId);
  const props = new Map(snapshot.properties.map((p) => [p.id, p]));
  const view = command.viewId ? snapshot.views.find((v) => v.id === command.viewId) || null : snapshot.views[0] || null;
  if (command.viewId && !view) fail(`View ${command.viewId} not found`, 'NOT_FOUND');
  const filter = command.filter !== undefined ? command.filter : view?.filter ?? null;
  const sorts = command.sorts !== undefined ? command.sorts : view?.sorts ?? [];
  if (filter) assertFilter(filter, props);
  for (const rule of sorts) if (!props.has(rule.propertyId)) fail(`Unknown sort property ${rule.propertyId}`, 'INVALID_QUERY');
  let records = allRecordSnapshots(store, command.sourceId, command.includeArchived ?? false);
  if (filter) records = records.filter((item) => filterMatches(item, filter, props));
  records.sort((a, b) => {
    for (const rule of sorts) { const c = compare(valueFor(a, props.get(rule.propertyId)), valueFor(b, props.get(rule.propertyId))); if (c) return rule.direction === 'asc' ? c : -c; }
    return a.record.id.localeCompare(b.record.id);
  });
  if (command.cursor) { const index = records.findIndex((item) => item.record.id === command.cursor); if (index >= 0) records = records.slice(index + 1); }
  const limit = command.limit ?? 100; const more = records.length > limit; records = records.slice(0, limit);
  if (command.projection) { const projection = new Set(command.projection); records = records.map((item) => ({ record: item.record, values: Object.fromEntries(Object.entries(item.values).filter(([id]) => projection.has(id))) })); }
  return { ...snapshot, view, records, nextCursor: more ? records.at(-1)?.record.id ?? null : null };
}

function apply(store, command) {
  const now = timestamp();
  switch (command.type) {
    case 'initialize': return { schemaVersion: 1 };
    case 'source.list': return store.sources.filter((s) => command.includeArchived || s.archivedAt === null).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).map((s) => ({ ...s }));
    case 'source.get': return sourceSnapshot(store, command.sourceId);
    case 'source.create': {
      const sourceId = crypto.randomUUID(); const titleId = crypto.randomUUID(); const viewId = crypto.randomUUID();
      store.sources.push({ id: sourceId, name: command.name.trim(), description: command.description ?? null, icon: null, createdAt: now, updatedAt: now, archivedAt: null });
      store.properties.push({ id: titleId, sourceId, name: 'Name', type: 'title', config: { type: 'title' }, position: rank(0), createdAt: now, updatedAt: now, archivedAt: null });
      store.views.push({ id: viewId, sourceId, name: 'Table', type: 'table', filter: null, sorts: [], layout: { visiblePropertyIds: [titleId], columnWidths: {} }, createdAt: now, updatedAt: now, archivedAt: null });
      return sourceSnapshot(store, sourceId);
    }
    case 'source.archive': {
      const source = sourceOrThrow(store, command.sourceId, true); source.archivedAt = command.archived === false ? null : now; source.updatedAt = now;
      return { source: { ...source }, properties: propertiesFor(store, source.id), views: viewsFor(store, source.id) };
    }
    case 'property.create': {
      sourceOrThrow(store, command.sourceId); const id = crypto.randomUUID(); const props = propertiesFor(store, command.sourceId);
      const options = (command.options || []).map((o, i) => ({ id: crypto.randomUUID(), propertyId: id, name: o.name.trim(), color: o.color ?? null, groupId: o.groupId ?? null, position: rank(i), archivedAt: null }));
      store.properties.push({ id, sourceId: command.sourceId, name: command.name.trim(), type: command.propertyType, config: command.config ?? { type: command.propertyType }, position: rank(props.length), createdAt: now, updatedAt: now, archivedAt: null });
      store.options.push(...options);
      for (const view of viewsFor(store, command.sourceId)) { const visible = Array.isArray(view.layout.visiblePropertyIds) ? view.layout.visiblePropertyIds.filter((x) => typeof x === 'string') : []; view.layout = { ...view.layout, visiblePropertyIds: [...visible, id] }; view.updatedAt = now; }
      return propertiesFor(store, command.sourceId).find((p) => p.id === id);
    }
    case 'record.create': {
      sourceOrThrow(store, command.sourceId); const record = { id: crypto.randomUUID(), sourceId: command.sourceId, title: command.title ?? '', bodyPath: null, revision: 1, createdAt: now, updatedAt: now, archivedAt: null };
      setValues(store, record, command.values); store.records.push(record); return recordSnapshot(store, record);
    }
    case 'record.update': {
      sourceOrThrow(store, command.sourceId); const record = recordById(store, command.sourceId, command.recordId);
      if (record.revision !== command.expectedRevision) fail(`Record ${record.id} changed since it was loaded`, 'CONFLICT', { expectedRevision: command.expectedRevision, actualRevision: record.revision });
      setValues(store, record, command.values); if (command.title !== undefined) record.title = command.title;
      record.revision += 1; record.updatedAt = now; return recordSnapshot(store, record);
    }
    case 'record.archive': {
      sourceOrThrow(store, command.sourceId); const record = recordById(store, command.sourceId, command.recordId);
      if (record.revision !== command.expectedRevision) fail(`Record ${record.id} changed since it was loaded`, 'CONFLICT', { expectedRevision: command.expectedRevision, actualRevision: record.revision });
      record.archivedAt = command.archived === false ? null : now; record.revision += 1; record.updatedAt = now; return recordSnapshot(store, record);
    }
    case 'view.list': sourceOrThrow(store, command.sourceId); return viewsFor(store, command.sourceId);
    case 'view.create': {
      const snapshot = sourceSnapshot(store, command.sourceId); const props = new Map(snapshot.properties.map((p) => [p.id, p]));
      if (command.filter) assertFilter(command.filter, props); for (const sort of command.sorts || []) if (!props.has(sort.propertyId)) fail(`Unknown sort property ${sort.propertyId}`, 'INVALID_QUERY');
      const view = { id: crypto.randomUUID(), sourceId: command.sourceId, name: command.name.trim(), type: 'table', filter: command.filter ?? null, sorts: command.sorts ?? [], layout: { visiblePropertyIds: snapshot.properties.map((p) => p.id), columnWidths: {}, ...(command.layout || {}) }, createdAt: now, updatedAt: now, archivedAt: null };
      store.views.push(view); return { ...view };
    }
    case 'view.update': {
      const snapshot = sourceSnapshot(store, command.sourceId); const view = snapshot.views.find((v) => v.id === command.viewId); if (!view) fail(`View ${command.viewId} not found`, 'NOT_FOUND');
      const props = new Map(snapshot.properties.map((p) => [p.id, p])); const filter = command.filter !== undefined ? command.filter : view.filter;
      if (filter) assertFilter(filter, props); const sorts = command.sorts ?? view.sorts; for (const sort of sorts) if (!props.has(sort.propertyId)) fail(`Unknown sort property ${sort.propertyId}`, 'INVALID_QUERY');
      const stored = byId(store.views, command.viewId); if (command.name !== undefined) stored.name = command.name.trim(); stored.filter = filter; stored.sorts = sorts; if (command.layout !== undefined) stored.layout = command.layout; stored.updatedAt = now; return { ...stored };
    }
    case 'query': return query(store, command);
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function acquireLock(lockPath, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { const fd = fs.openSync(lockPath, 'wx', 0o600); fs.writeSync(fd, String(process.pid)); return fd; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 60000) {
          const pid = Number(fs.readFileSync(lockPath, 'utf8')); let alive = Number.isSafeInteger(pid) && pid > 0;
          if (alive) { try { process.kill(pid, 0); } catch (probe) { alive = probe.code !== 'ESRCH'; } }
          if (!alive) { fs.unlinkSync(lockPath); continue; }
        }
      } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      if (Date.now() >= deadline) fail('Project database is busy. Retry the operation.', 'TIMEOUT');
      await sleep(20);
    }
  }
}

function createProjectDatabase(options = {}) {
  if (!isObject(options) || typeof options.dataRoot !== 'string' || !options.dataRoot.trim()) throw new TypeError('createProjectDatabase requires an explicit dataRoot.');
  const root = path.resolve(options.dataRoot);
  function fileFor(projectPath) {
    const key = crypto.createHash('sha256').update(projectPath).digest('hex');
    return path.join(root, 'project-databases', `${key}.json`);
  }
  async function invoke(rawRequest) {
    assertObject(rawRequest, 'request'); assertKeys(rawRequest, new Set(['projectPath', 'command']), 'request');
    assertString(rawRequest.projectPath, 'projectPath'); validateCommand(rawRequest.command);
    const file = fileFor(rawRequest.projectPath); const lock = `${file}.lock`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = await acquireLock(lock);
    try {
      let store;
      try { store = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') store = defaultStore(); else throw error; }
      if (!isObject(store) || !Array.isArray(store.sources) || !Array.isArray(store.properties) || !Array.isArray(store.records) || !Array.isArray(store.views)) fail('Project database file is malformed.', 'STORAGE_ERROR');
      const result = apply(store, rawRequest.command);
      if (rawRequest.command.type !== 'query' && rawRequest.command.type !== 'source.get' && rawRequest.command.type !== 'source.list' && rawRequest.command.type !== 'view.list' && rawRequest.command.type !== 'initialize') {
        const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(store), { mode: 0o600 });
        fs.renameSync(temp, file);
      } else if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(store), { flag: 'wx', mode: 0o600 });
      }
      return result;
    } finally { try { fs.closeSync(fd); } finally { try { fs.unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; } } }
  }
  return { invoke };
}

module.exports = { createProjectDatabase, ProjectDatabaseError, validateCommand };

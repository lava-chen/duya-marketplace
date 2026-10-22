'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { test } = require('node:test');

const templateRoot = path.join(__dirname, '..');

function startServer(storePath) {
  const child = spawn(process.execPath, [path.join(templateRoot, 'server.cjs')], {
    env: { PATH: process.env.PATH ?? '', NOTES_STORE: storePath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on('line', (line) => {
    const response = JSON.parse(line);
    const resolve = pending.get(response.id);
    if (resolve) {
      pending.delete(response.id);
      resolve(response);
    }
  });
  let nextId = 0;
  return {
    child,
    request(method, params = {}) {
      const id = `test-${++nextId}`;
      const response = new Promise((resolve) => pending.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return response;
    },
    async close() {
      child.stdin.end();
      if (child.exitCode === null) await once(child, 'exit');
      lines.close();
    },
  };
}

test('template manifest and tool scope agree with the MCP server', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(templateRoot, '.duya-plugin', 'plugin.json'), 'utf8'));
  const servers = JSON.parse(fs.readFileSync(path.join(templateRoot, 'mcp', 'servers.json'), 'utf8'));
  const app = manifest.extensions['com.duya.client'].apps[0];
  const mapping = app.capabilityTools.find((entry) => entry.capability === app.requiredCapabilities[0]);
  const source = fs.readFileSync(path.join(templateRoot, 'server.cjs'), 'utf8');
  const html = fs.readFileSync(path.join(templateRoot, 'apps', 'notes', 'index.html'), 'utf8');

  assert.equal(app.runtime, 'standalone');
  assert.equal(servers.servers.length, 1);
  assert.equal(servers.servers[0].name, mapping.tools[0].serverName);
  for (const { toolName } of mapping.tools) {
    assert.match(source, new RegExp(`name: '${toolName}'`));
    assert.ok(html.includes(`'${toolName}'`), `${toolName} is invoked by the App UI`);
  }
  assert.ok(servers.servers[0].args.includes('${DUYA_PLUGIN_ROOT}/server.cjs'));
  assert.equal(servers.servers[0].env.NOTES_STORE, '${DUYA_PLUGIN_DATA}/notes.json');
});

test('notes are shared across MCP process restarts and invalid writes are rejected', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-app-builder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, 'notes.json');
  const first = startServer(storePath);
  t.after(() => first.close());

  const initialized = await first.request('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.result.serverInfo.name, 'notes');
  const listed = await first.request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['notes_list', 'notes_add']);
  const added = await first.request('tools/call', { name: 'notes_add', arguments: { text: 'Shared note' } });
  assert.equal(added.result.structuredContent.note.text, 'Shared note');
  const invalid = await first.request('tools/call', { name: 'notes_add', arguments: { text: '   ' } });
  assert.equal(invalid.result.isError, true);

  await first.close();
  const second = startServer(storePath);
  t.after(() => second.close());
  const persisted = await second.request('tools/call', { name: 'notes_list', arguments: {} });
  assert.deepEqual(persisted.result.structuredContent.notes.map((note) => note.text), ['Shared note']);
});

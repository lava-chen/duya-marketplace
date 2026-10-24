'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { controlTools, readTools, writeTools } = require('../policy.cjs');

const pluginRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.duya-plugin', 'plugin.json'), 'utf8'));
const servers = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'mcp', 'servers.json'), 'utf8'));
const permissions = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'permissions', 'policy.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));

test('the manifest and the package agree on the plugin version', () => {
  assert.equal(manifest.version, pkg.version);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('the declared permission tiers cover every tool the plugin exposes', () => {
  const read = new Set(permissions.tiers.read);
  const write = new Set(permissions.tiers.write);
  for (const tool of readTools) assert.ok(read.has(tool), `${tool} is missing from the read tier`);
  for (const tool of writeTools) assert.ok(write.has(tool), `${tool} is missing from the write tier`);
  for (const tool of controlTools) assert.ok(write.has(tool), `${tool} is missing from the write tier`);
  for (const tool of read) assert.ok(!write.has(tool), `${tool} is declared as read and write`);
});

test('the manifest declares the environment the server reads', () => {
  const env = servers.servers[0].env;
  const sources = fs.readdirSync(pluginRoot)
    .filter((name) => name.endsWith('.cjs'))
    .map((name) => fs.readFileSync(path.join(pluginRoot, name), 'utf8'))
    .join('\n');
  for (const name of [
    'CUA_DRIVER_PATH', 'CUA_DRIVER_ARGS', 'COMPUTER_USE_ACCESS_POLICY',
    'COMPUTER_USE_AUDIT_PATH', 'COMPUTER_USE_MIN_DRIVER_VERSION', 'DUYA_PLUGIN_DATA',
  ]) {
    assert.ok(Object.hasOwn(env, name), `${name} is not declared in mcp/servers.json`);
    assert.ok(sources.includes(name), `${name} is declared but no plugin module reads it`);
  }
});

test('the manifest does not declare capabilities the host drops', () => {
  // The capability loader keeps command, args, env and the timeouts only.
  assert.equal(Object.hasOwn(servers.servers[0], 'envPassthrough'), false);
});

test('the setup fields cover every configurable plugin input', () => {
  const ids = new Set(manifest.setup.map((field) => field.id));
  for (const id of ['driverPath', 'driverArgs', 'minDriverVersion', 'accessPolicyJson', 'auditPath']) {
    assert.ok(ids.has(id), `${id} is missing from the setup fields`);
  }
});

test('the plugin ships no bundled or simulated driver copy', () => {
  const entries = fs.readdirSync(pluginRoot, { withFileTypes: true, recursive: true });
  const binaries = entries.filter((entry) => /\.(exe|dll|cmd|bat|ps1|node)$/i.test(entry.name));
  assert.deepEqual(binaries.map((entry) => entry.name), []);
  assert.equal(entries.some((entry) => entry.name === 'dist'), false);
});

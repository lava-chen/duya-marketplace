'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettingsStore } = require('./settings-store.cjs');

function fixture(t) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-settings-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  return { dataRoot, store: createSettingsStore(dataRoot, {}) };
}

test('settings persist across MCP instances and serialize concurrent updates', async (t) => {
  const { dataRoot, store } = fixture(t);
  const other = createSettingsStore(dataRoot, {});
  await Promise.all([
    store.set('conductor.model', '[Local] model-a'),
    other.set('conductor.permissionMode', 'auto'),
  ]);
  const reopened = createSettingsStore(dataRoot, {});
  assert.equal(await reopened.get('conductor.model'), '[Local] model-a');
  assert.equal(await reopened.get('conductor.permissionMode'), 'auto');
  await assert.rejects(reopened.set('provider.secretAPIkey', 'must-not-be-a-setting'), /provider configuration tool/);
  assert.equal(fs.statSync(path.join(dataRoot, 'settings.json')).mode & 0o777, 0o600);
});

test('provider status and model listing never disclose the API key', async (t) => {
  const { store } = fixture(t);
  await store.configureProvider({ baseURL: 'https://example.test/v1/', model: 'vision-model', secretAPIkey: 'private-key' });
  const status = await store.providerStatus();
  assert.equal(status.configured, true);
  assert.equal(status.hasApiKey, true);
  assert.equal(status.baseURL, 'https://example.test/v1');
  assert.equal(Object.hasOwn(status, 'secretAPIkey'), false);
  const [provider] = await store.listProviders();
  assert.equal(provider.hasApiKey, true);
  assert.deepEqual(JSON.parse(provider.options), { enabled_models: ['vision-model'] });
  assert.equal(JSON.stringify(provider).includes('private-key'), false);
});

test('provider environment mapping overrides stored values without changing them', async (t) => {
  const { store } = fixture(t);
  await store.configureProvider({ baseURL: 'https://stored.test/v1', model: 'stored-model', secretAPIkey: 'stored-key' });
  const envPath = path.join(os.tmpdir(), `canvas-env-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(envPath, { recursive: true, force: true }));
  const mapped = createSettingsStore(envPath, { CANVAS_OPENAI_BASE_URL: 'https://env.test/v1', CANVAS_OPENAI_MODEL: 'env-model', CANVAS_OPENAI_API_KEY: 'env-key' });
  await mapped.configureProvider({ baseURL: 'https://stored.test/v1', model: 'stored-model', secretAPIkey: 'stored-key' });
  assert.deepEqual(await mapped.getProviderConfig(), { baseURL: 'https://env.test/v1', model: 'env-model', secretAPIkey: 'env-key' });
  assert.deepEqual(await store.getProviderConfig(), { baseURL: 'https://stored.test/v1', model: 'stored-model', secretAPIkey: 'stored-key' });
});

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SECRET_SETTING_KEY = /(?:api.?key|secret|token|password)/i;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_SECRET_LENGTH = 4096;

function fail(message) { throw new Error(message); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function validateProviderInput(input, current = {}) {
  if (!isObject(input)) fail('Provider configuration must be an object.');
  const baseURL = input.baseURL === undefined ? current.baseURL || 'https://api.openai.com/v1' : String(input.baseURL).trim();
  const model = input.model === undefined ? current.model || '' : String(input.model).trim();
  let parsedURL;
  try { parsedURL = new URL(baseURL); } catch { fail('baseURL must be a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(parsedURL.protocol) || parsedURL.username || parsedURL.password) fail('baseURL must use HTTP or HTTPS and must not contain credentials.');
  if (!model || model.length > 200) fail('model is required and must be at most 200 characters.');
  let secretAPIkey = current.secretAPIkey || '';
  if (Object.hasOwn(input, 'secretAPIkey')) {
    if (input.secretAPIkey !== null && typeof input.secretAPIkey !== 'string') fail('secretAPIkey must be a string or null.');
    secretAPIkey = input.secretAPIkey === null ? '' : input.secretAPIkey.trim();
    if (secretAPIkey.length > MAX_SECRET_LENGTH) fail('secretAPIkey is too long.');
  }
  return { baseURL: baseURL.replace(/\/+$/, ''), model, secretAPIkey };
}

function createSettingsStore(dataRoot, env = process.env) {
  if (typeof dataRoot !== 'string' || !dataRoot.trim()) throw new TypeError('createSettingsStore requires dataRoot.');
  const root = path.resolve(dataRoot);
  const settingsPath = path.join(root, 'settings.json');
  const lockPath = `${settingsPath}.lock`;

  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!isObject(data) || !isObject(data.values) || !isObject(data.provider)) return { version: 1, values: {}, provider: {} };
      return { version: 1, values: data.values, provider: data.provider };
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, values: {}, provider: {} };
      throw error;
    }
  }

  function write(data) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized) > MAX_SETTINGS_BYTES) fail('Canvas settings are limited to 1 MB.');
    const temp = `${settingsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, serialized, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, settingsPath);
  }

  async function withLock(operation) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 15_000;
    let fd;
    while (fd === undefined) {
      try { fd = fs.openSync(lockPath, 'wx', 0o600); fs.writeSync(fd, String(process.pid)); }
      catch (error) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch {} fd = undefined; }
        if (error.code !== 'EEXIST') throw error;
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 60_000) {
            const pid = Number(fs.readFileSync(lockPath, 'utf8'));
            let alive = Number.isSafeInteger(pid) && pid > 0;
            if (alive) { try { process.kill(pid, 0); } catch (probe) { alive = probe.code !== 'ESRCH'; } }
            if (!alive) { fs.unlinkSync(lockPath); continue; }
          }
        } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
        if (Date.now() >= deadline) fail('Canvas settings are busy. Retry the operation.');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    try { return await operation(); }
    finally { try { fs.closeSync(fd); } finally { try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; } } }
  }

  function providerConfig(data) {
    const stored = data.provider || {};
    return {
      baseURL: String(env.CANVAS_OPENAI_BASE_URL || stored.baseURL || '').trim(),
      model: String(env.CANVAS_OPENAI_MODEL || stored.model || '').trim(),
      secretAPIkey: String(env.CANVAS_OPENAI_API_KEY || stored.secretAPIkey || '').trim(),
    };
  }

  async function get(key) {
    validateKey(key);
    if (SECRET_SETTING_KEY.test(key)) fail('Secrets must be managed through the provider configuration tool.');
    return read().values[key] ?? null;
  }

  async function set(key, value) {
    validateKey(key);
    if (SECRET_SETTING_KEY.test(key)) fail('Secrets must be managed through the provider configuration tool.');
    let encoded;
    try { encoded = JSON.stringify(value); } catch { fail('Setting value must be JSON serializable.'); }
    if (encoded === undefined || Buffer.byteLength(encoded) > MAX_SETTINGS_BYTES) fail('Setting value must be JSON serializable and at most 1 MB.');
    return withLock(async () => {
      const data = read(); data.values[key] = JSON.parse(encoded); write(data); return true;
    });
  }

  async function configureProvider(input) {
    return withLock(async () => {
      const data = read();
      data.provider = validateProviderInput(input, data.provider);
      write(data); return { success: true };
    });
  }

  async function getProviderConfig() { return providerConfig(read()); }

  async function providerStatus() {
    const config = await getProviderConfig();
    return {
      configured: Boolean(config.baseURL && config.model),
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(config.model ? { model: config.model } : {}),
      providerType: 'openai-compatible',
      hasApiKey: Boolean(config.secretAPIkey),
    };
  }

  async function listProviders() {
    const status = await providerStatus();
    if (!status.configured) return [];
    return [{
      id: 'conductor-canvas-openai-compatible',
      name: 'Canvas OpenAI-compatible provider',
      providerType: 'openai-compatible',
      hasApiKey: status.hasApiKey,
      options: JSON.stringify({ enabled_models: [status.model] }),
      isDefault: true,
    }];
  }

  return { get, set, configureProvider, getProviderConfig, providerStatus, listProviders };
}

function validateKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(key)) fail('Setting key must contain 1 to 120 letters, digits, dots, underscores, or hyphens.');
}

module.exports = { createSettingsStore, validateProviderInput };

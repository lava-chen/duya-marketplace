'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MODES = new Set(['desktop-head', 'desktop-full', 'mobile-head', 'mobile-full']);
const MAX_CAPTURE_HEIGHT = 12_000;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;

function writeOnce(filePath, data) {
  try { fs.writeFileSync(filePath, data, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

function normalizeUrl(input) {
  let url;
  try { url = new URL(String(input || '')); }
  catch { throw new Error('Enter a valid http or https URL to capture.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Link snapshots support only http and https URLs.');
  if (url.username || url.password) throw new Error('Remove the username and password from this URL before capturing it.');
  url.hash = '';
  return url.href;
}

function assertBrowserAvailable(browser) {
  if (!browser || typeof browser.send !== 'function') {
    throw new Error('Link snapshots need the Canvas plugin’s managed Chromium module. Reinstall or update the Conductor Canvas plugin.');
  }
  const status = browser.health();
  if (!status.ok) {
    throw new Error('Link snapshots need Chrome or Chromium. Set CHROME_BIN or DUYA_BROWSER_EXECUTABLE in the Canvas plugin runtime, then retry.');
  }
}

function dimensionsFor(mode, pageSize) {
  const mobile = mode.startsWith('mobile-');
  const width = mobile ? 390 : 1280;
  const viewportHeight = mobile ? 844 : 800;
  const fullPage = mode.endsWith('-full');
  return {
    width,
    height: fullPage ? Math.min(MAX_CAPTURE_HEIGHT, Math.max(viewportHeight, pageSize.height || viewportHeight)) : viewportHeight,
  };
}

function createLinkSnapshotTool({ browser, assetDir }) {
  if (!browser || typeof browser.send !== 'function') throw new TypeError('A managed Chromium browser is required.');
  if (typeof assetDir !== 'string' || !path.isAbsolute(assetDir)) throw new TypeError('assetDir must be an absolute path.');

  return async function captureLinkSnapshot(input = {}) {
    const url = normalizeUrl(input.url);
    const mode = String(input.mode || '');
    if (!MODES.has(mode)) throw new Error(`Unsupported snapshot mode: ${mode || '(empty)'}.`);
    assertBrowserAvailable(browser);

    const mobile = mode.startsWith('mobile-');
    const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
    const tabId = `canvas-link-${randomUUID()}`;
    try {
      await browser.send('Page.enable', {}, tabId);
      if (mobile) {
        await browser.send('Emulation.setDeviceMetricsOverride', {
          width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: true,
        }, tabId);
        await browser.send('Emulation.setUserAgentOverride', {
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          platform: 'iPhone',
        }, tabId);
      }
      await browser.send('Page.navigate', { url }, tabId);
      await browser.waitForLoad(tabId, 20_000);

      const evaluated = await browser.send('Runtime.evaluate', {
        expression: '({height: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0, window.innerHeight), width: Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0, window.innerWidth)})',
        returnByValue: true,
        awaitPromise: true,
      }, tabId);
      const pageSize = evaluated?.result?.value || {};
      const clip = dimensionsFor(mode, { height: Number(pageSize.height) });
      const captured = await browser.send('Page.captureScreenshot', {
        format: 'jpeg', quality: 82, fromSurface: true, captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: clip.width, height: clip.height, scale: 1 },
      }, tabId);
      if (typeof captured?.data !== 'string' || !captured.data) throw new Error('Chrome returned an empty screenshot.');

      const bytes = Buffer.from(captured.data, 'base64');
      if (!bytes.length || bytes.length > MAX_ASSET_BYTES) {
        throw new Error('This snapshot is larger than the 5 MB Canvas asset limit. Choose a head-only snapshot or shorten the page.');
      }
      const assetId = createHash('sha256').update(bytes).digest('hex');
      fs.mkdirSync(assetDir, { recursive: true });
      writeOnce(path.join(assetDir, assetId), bytes);
      writeOnce(path.join(assetDir, `${assetId}.json`), JSON.stringify({ name: `link-snapshot-${mode}.jpg`, mimeType: 'image/jpeg', size: bytes.length }));
      return { assetId, mimeType: 'image/jpeg', width: clip.width, height: clip.height, base64: bytes.toString('base64') };
    } finally {
      await browser.closeTab(tabId).catch(() => {});
    }
  };
}

module.exports = { createLinkSnapshotTool, normalizeUrl, dimensionsFor };

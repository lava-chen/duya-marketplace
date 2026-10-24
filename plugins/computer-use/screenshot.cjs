'use strict';

// Screenshot capture for the Computer Use plugin.
//
// The plugin does not implement its own screen capture: the Cua Driver returns
// the image with the observation. This service adds the parts the driver does
// not provide — an explicit crop, an explicit format, an explicit freshness
// contract and a cache, so that repeated observations do not capture the whole
// screen again.

const { cropPng, decodePng, isPng } = require('./png.cjs');

const DEFAULT_TTL_MS = 5000;
const MAX_CACHE_ENTRIES = 8;

function extractImage(result) {
  const blocks = [];
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const block of content) {
    if (block?.type === 'image' && typeof block.data === 'string' && block.data) {
      blocks.push({ data: block.data, mimeType: block.mimeType || 'image/png' });
    }
  }
  const structured = result?.structuredContent;
  if (structured && typeof structured === 'object') {
    for (const key of ['image', 'screenshot', 'image_base64', 'png_base64']) {
      const value = structured[key];
      if (typeof value === 'string' && value) {
        blocks.push({ data: value, mimeType: structured.mimeType || 'image/png' });
      }
    }
  }
  return blocks[0] || null;
}

function normalizeRegion(region) {
  if (!region || typeof region !== 'object') return null;
  const x = Number(region.x);
  const y = Number(region.y);
  const width = Number(region.width);
  const height = Number(region.height);
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  if (width <= 0 || height <= 0) throw new Error('A screenshot region needs a positive width and height.');
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function clampRegion(region, width, height) {
  const x = Math.max(0, Math.min(Math.round(region.x), width));
  const y = Math.max(0, Math.min(Math.round(region.y), height));
  const clampedWidth = Math.max(0, Math.min(Math.round(region.width), width - x));
  const clampedHeight = Math.max(0, Math.min(Math.round(region.height), height - y));
  if (clampedWidth <= 0 || clampedHeight <= 0) throw new Error('The requested screenshot region lies outside the captured image.');
  return { x, y, width: clampedWidth, height: clampedHeight };
}

function resolveFormat(requested, sourceMimeType) {
  const source = String(sourceMimeType || 'image/png').toLowerCase();
  if (!requested) return source;
  const want = String(requested).toLowerCase();
  const wantMime = want === 'jpeg' || want === 'jpg' ? 'image/jpeg' : 'image/png';
  if (source === wantMime) return source;
  throw new Error(`Cannot convert a ${source} capture to ${want}; the plugin only re-encodes PNG captures.`);
}

function createScreenshotService({ clock = null, ttlMs = DEFAULT_TTL_MS } = {}) {
  const now = () => (clock?.now ? clock.now() : Date.now());
  const cache = new Map();

  function cacheKey(key, region, format) {
    const regionKey = region ? `${region.x},${region.y},${region.width},${region.height}` : 'full';
    return `${key || 'desktop'}|${format || 'png'}|${regionKey}`;
  }

  function remember(key, payload) {
    cache.delete(key);
    cache.set(key, payload);
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }

  // A fresh capture for this target and region, without touching the driver.
  function peek(key, maxAgeMs = ttlMs, region = null, format = null) {
    const entry = cache.get(cacheKey(key, region, format));
    if (!entry) return null;
    const age = now() - entry.capturedAt;
    if (age > maxAgeMs) return null;
    return { ...entry, cached: true, ageMs: age };
  }

  // `result` is the raw driver response of an observation tool.
  async function capture({ result, key = 'desktop', region = null, format = null, maxAgeMs = ttlMs, refresh = false } = {}) {
    const wantedRegion = normalizeRegion(region);
    const key_ = cacheKey(key, wantedRegion, format);
    const cached = cache.get(key_);
    const timestamp = now();
    if (!refresh && cached && timestamp - cached.capturedAt <= maxAgeMs) {
      return { ...cached, cached: true, ageMs: timestamp - cached.capturedAt };
    }
    const image = extractImage(result);
    if (!image) throw new Error('The driver did not return an image for this capture.');
    const buffer = Buffer.from(image.data, 'base64');
    const mimeType = resolveFormat(format, image.mimeType);
    let output = buffer;
    let width = null;
    let height = null;
    let cropped = false;
    if (isPng(buffer)) {
      const decoded = decodePng(buffer);
      width = decoded.width;
      height = decoded.height;
      if (wantedRegion) {
        const clamped = clampRegion(wantedRegion, width, height);
        output = cropPng(buffer, clamped);
        cropped = true;
        width = clamped.width;
        height = clamped.height;
      }
    } else if (wantedRegion) {
      throw new Error(`Cropping is only supported for PNG captures; the driver returned ${image.mimeType}.`);
    }
    const payload = {
      data: output.toString('base64'),
      mimeType,
      width,
      height,
      cropped,
      capturedAt: timestamp,
      source: 'driver',
    };
    remember(key_, payload);
    return { ...payload, cached: false, ageMs: 0 };
  }

  return {
    capture,
    peek,
    extractImage,
    cached: () => cache.size,
    clear: () => cache.clear(),
  };
}

// The capture a driver response carries, with the original image dimensions.
// The dimensions matter: an agent reads a possibly resized picture, and the
// coordinates it picks have to be scaled back to the original pixels.
function inspectImage(result, id = null) {
  const image = extractImage(result);
  if (!image) return null;
  const buffer = Buffer.from(image.data, 'base64');
  let width = null;
  let height = null;
  if (isPng(buffer)) {
    try {
      const decoded = decodePng(buffer);
      width = decoded.width;
      height = decoded.height;
    } catch { /* an unreadable capture still has a mime type */ }
  }
  return { id, width, height, mimeType: image.mimeType };
}

module.exports = { createScreenshotService, extractImage, inspectImage, normalizeRegion };

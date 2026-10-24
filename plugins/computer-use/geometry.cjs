'use strict';

// Coordinate helpers for desktop observations.
//
// The plugin never guesses a coordinate space. The driver owns the mapping
// between agent coordinates and physical pixels, so this module only converts
// when an observation explicitly declares both a scale factor and a logical
// coordinate space. Everything else is passed through untouched and reported
// as `driver-native`.

const SCALE_KEYS = ['scale', 'scale_factor', 'scaleFactor', 'device_pixel_ratio', 'devicePixelRatio', 'zoom_factor', 'zoomFactor'];
const DPI_KEYS = ['dpi', 'dpi_scale', 'pixel_dpi'];
const LOGICAL_KEYS = ['logical_width', 'logicalWidth', 'logical_size', 'logicalSize'];
const PHYSICAL_KEYS = ['pixel_width', 'pixelWidth', 'physical_width', 'physicalWidth'];
const ORIGIN_KEYS = ['origin', 'offset', 'position'];
const SIZE_KEYS = ['size', 'bounds', 'rect', 'dimensions'];

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function numberFrom(source, keys) {
  if (!isObject(source)) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function pointFrom(source, keys) {
  if (!isObject(source)) return null;
  for (const key of keys) {
    const value = source[key];
    if (isObject(value)) {
      const x = numberFrom(value, ['x', 'left', 'x0']);
      const y = numberFrom(value, ['y', 'top', 'y0']);
      if (x !== null && y !== null) return { x, y };
    }
  }
  return null;
}

function sizeFrom(source, keys) {
  if (!isObject(source)) return null;
  for (const key of keys) {
    const value = source[key];
    if (isObject(value)) {
      const width = numberFrom(value, ['width', 'w']);
      const height = numberFrom(value, ['height', 'h']);
      if (width !== null && height !== null) return { width, height };
    }
    const width = numberFrom(source, ['width']);
    const height = numberFrom(source, ['height']);
    if (width !== null && height !== null) return { width, height };
  }
  return null;
}

function parseText(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const candidates = [value];
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidates.push(fenced[1]);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

// Walk the observation payload and collect every object that looks like a
// display or a monitor. The driver output shape is not guaranteed, so the
// search is structural rather than schema-driven.
function collectCandidates(root, depth = 0, found = []) {
  if (depth > 6 || !root || typeof root !== 'object') return found;
  if (Array.isArray(root)) {
    for (const item of root) collectCandidates(item, depth + 1, found);
    return found;
  }
  found.push(root);
  for (const [key, value] of Object.entries(root)) {
    if (key === 'content' && Array.isArray(value)) {
      for (const block of value) {
        if (block?.type !== 'text') continue;
        const parsed = parseText(block.text);
        if (parsed) collectCandidates(parsed, depth + 1, found);
      }
      continue;
    }
    if (value && typeof value === 'object') collectCandidates(value, depth + 1, found);
  }
  return found;
}

function scaleOf(source) {
  const direct = numberFrom(source, SCALE_KEYS);
  if (direct !== null && direct > 0) return direct;
  const dpi = numberFrom(source, DPI_KEYS);
  if (dpi !== null && dpi > 0) return dpi / 96;
  return null;
}

function parseMonitor(entry) {
  if (!isObject(entry)) return null;
  const flatX = numberFrom(entry, ['x', 'left']);
  const flatY = numberFrom(entry, ['y', 'top']);
  const origin = pointFrom(entry, ORIGIN_KEYS)
    || (flatX !== null && flatY !== null ? { x: flatX, y: flatY } : { x: 0, y: 0 });
  const size = sizeFrom(entry, SIZE_KEYS);
  const scale = scaleOf(entry);
  if (!size && scale === null) return null;
  return {
    id: typeof entry.id === 'string' ? entry.id : (typeof entry.name === 'string' ? entry.name : null),
    origin,
    size,
    scale,
    primary: entry.primary === true || entry.is_primary === true || entry.isPrimary === true,
  };
}

function parseDisplayMetrics(payload) {
  const candidates = collectCandidates(payload);
  const monitors = [];
  let scale = null;
  let dpi = null;
  let coordinateSpace = 'unknown';
  let size = null;
  let logicalDeclared = false;
  let physicalDeclared = false;

  for (const candidate of candidates) {
    if (monitorArray(candidate)) {
      for (const entry of candidate[monitorArray(candidate)]) {
        const monitor = parseMonitor(entry);
        if (monitor) monitors.push(monitor);
      }
    }
    const entryScale = scaleOf(candidate);
    if (entryScale !== null && scale === null) scale = entryScale;
    const entryDpi = numberFrom(candidate, DPI_KEYS);
    if (entryDpi !== null && dpi === null) dpi = entryDpi;
    if (numberFrom(candidate, LOGICAL_KEYS) !== null) logicalDeclared = true;
    if (numberFrom(candidate, PHYSICAL_KEYS) !== null) physicalDeclared = true;
    const declaredSpace = typeof candidate.coordinate_space === 'string'
      ? candidate.coordinate_space
      : (typeof candidate.coordinateSpace === 'string' ? candidate.coordinateSpace : null);
    if (declaredSpace === 'logical' || declaredSpace === 'physical') coordinateSpace = declaredSpace;
    const candidateSize = sizeFrom(candidate, SIZE_KEYS);
    if (candidateSize && !size) size = candidateSize;
  }

  if (coordinateSpace === 'unknown') {
    if (logicalDeclared && !physicalDeclared) coordinateSpace = 'logical';
    else if (physicalDeclared && !logicalDeclared) coordinateSpace = 'physical';
  }

  const primary = monitors.find((monitor) => monitor.primary) || monitors[0] || null;
  if (scale === null && primary?.scale) scale = primary.scale;
  if (scale === null && dpi !== null) scale = dpi / 96;

  return {
    scale: scale && scale > 0 ? scale : null,
    dpi: dpi && dpi > 0 ? dpi : null,
    coordinateSpace,
    size,
    origin: primary?.origin || { x: 0, y: 0 },
    monitors,
    primary,
  };
}

function monitorArray(candidate) {
  for (const key of ['monitors', 'displays', 'screens']) {
    if (Array.isArray(candidate?.[key])) return key;
  }
  return null;
}

function monitorFor(metrics, point) {
  if (!metrics?.monitors?.length) return null;
  const containing = metrics.monitors.find((monitor) => {
    if (!monitor.size) return false;
    return point.x >= monitor.origin.x && point.x < monitor.origin.x + monitor.size.width
      && point.y >= monitor.origin.y && point.y < monitor.origin.y + monitor.size.height;
  });
  return containing || metrics.primary || null;
}

// Convert an agent supplied point into the space the driver expects.
// Returns null when the point is not a usable coordinate pair.
function toDriverCoordinates(point, metrics, { monitor = null } = {}) {
  if (!isObject(point)) return null;
  const x = numberFrom(point, ['x']);
  const y = numberFrom(point, ['y']);
  if (x === null || y === null) return null;
  const space = metrics?.coordinateSpace || 'unknown';
  const target = monitor || monitorFor(metrics, { x, y });
  const scale = target?.scale ?? metrics?.scale ?? null;
  if (space !== 'logical' || !scale || scale === 1) {
    return { x, y, converted: false, space: space === 'physical' ? 'physical' : 'driver-native' };
  }
  // The driver reports monitor origins in its own global space, so the origin
  // is kept and only the offset inside the monitor is scaled.
  const origin = target?.origin || { x: 0, y: 0 };
  const physicalOrigin = {
    x: numberFrom(target || {}, ['physical_x', 'physicalX']) ?? origin.x,
    y: numberFrom(target || {}, ['physical_y', 'physicalY']) ?? origin.y,
  };
  return {
    x: physicalOrigin.x + Math.round((x - origin.x) * scale),
    y: physicalOrigin.y + Math.round((y - origin.y) * scale),
    converted: true,
    space: 'physical',
    scale,
    monitor: target?.id || null,
  };
}

module.exports = { parseDisplayMetrics, toDriverCoordinates, monitorFor };

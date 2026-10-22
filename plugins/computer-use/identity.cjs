'use strict';

const ID_KEYS = ['window_id', 'windowId', 'hwnd', 'handle', 'id'];
const TITLE_KEYS = ['title', 'window_title', 'windowTitle'];
const APP_KEYS = ['app', 'app_name', 'appName', 'process_name', 'processName', 'exe', 'process'];
const ACTIVE_KEYS = ['active', 'is_active', 'isActive', 'foreground', 'is_foreground', 'isForeground', 'focused', 'is_focused', 'isFocused'];
const ACTIVE_OBJECT_KEYS = ['activeWindow', 'active_window', 'foregroundWindow', 'foreground_window', 'focusedWindow', 'focused_window', 'foreground', 'active', 'focused'];

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
function unwrapObservation(value, depth = 0) {
  if (depth > 5 || !value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => unwrapObservation(item, depth + 1));
  if (typeof value !== 'object') return [];
  const results = [value];
  if (value.structuredContent && typeof value.structuredContent === 'object') results.push(...unwrapObservation(value.structuredContent, depth + 1));
  if (Array.isArray(value.content)) {
    for (const block of value.content) if (block?.type === 'text') {
      const parsed = parseText(block.text);
      if (parsed) results.push(...unwrapObservation(parsed, depth + 1));
    }
  }
  return results;
}
function firstString(object, keys) {
  for (const key of keys) if (typeof object?.[key] === 'string' && object[key].trim()) return object[key].trim();
  return null;
}
function firstId(object) {
  for (const key of ID_KEYS) {
    const value = object?.[key];
    if ((typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value))) return String(value);
  }
  return null;
}
function normalizeWindow(object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  const title = firstString(object, TITLE_KEYS);
  const app = firstString(object, APP_KEYS);
  const id = firstId(object);
  if (!title && !(id && app)) return null;
  const pid = typeof object.pid === 'number' || (typeof object.pid === 'string' && /^\d+$/.test(object.pid)) ? Number(object.pid) : null;
  return { id, pid, title, app, processName: firstString(object, ['process_name', 'processName', 'exe', 'process', 'app_name', 'appName']) };
}
function keyIsActive(key) { return ACTIVE_OBJECT_KEYS.some((k) => k.toLowerCase() === key.toLowerCase()); }
function valueIsActive(object) { return ACTIVE_KEYS.some((key) => object?.[key] === true); }
function windowKey(window) { return `${window.pid ?? ''}\u0000${window.id || ''}\u0000${window.title || ''}\u0000${window.app || ''}`; }
function collect(root) {
  const windows = [];
  let active = null;
  const seen = new Set();
  const add = (object, activeHint = false) => {
    const window = normalizeWindow(object);
    if (!window) return;
    const key = windowKey(window);
    if (!seen.has(key)) { windows.push(window); seen.add(key); }
    if (activeHint || valueIsActive(object)) active = window;
  };
  const visit = (node, depth = 0, activeHint = false) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1, activeHint); return; }
    add(node, activeHint);
    for (const [key, value] of Object.entries(node)) {
      if (keyIsActive(key) && value && typeof value === 'object') {
        add(value, true);
        visit(value, depth + 1, true);
      } else if (Array.isArray(value) || (value && typeof value === 'object')) {
        visit(value, depth + 1, false);
      }
    }
  };
  visit(root);
  for (const source of unwrapObservation(root)) {
    if (!Array.isArray(source?.content)) continue;
    for (const block of source.content) {
      if (block?.type !== 'text') continue;
      const text = String(block.text || '');
      const patterns = [
        /(?:^|\n)\s*-?\s*pid=(\d+)\s+window_id=(\d+)\s+"([^"]*)"/g,
        /(?:^|\n)\s*-?\s*window_id=(\d+)\s+pid=(\d+)\s+"([^"]*)"/g,
      ];
      for (let i = 0; i < patterns.length; i++) {
        for (const match of text.matchAll(patterns[i])) {
          const window = i === 0
            ? { id: match[2], pid: Number(match[1]), title: match[3], app: null, processName: null }
            : { id: match[1], pid: Number(match[2]), title: match[3], app: null, processName: null };
          const key = windowKey(window);
          if (!seen.has(key)) { windows.push(window); seen.add(key); }
        }
      }
    }
  }
  const roots = Array.isArray(root) ? root : [root];
  let activeId = null;
  for (const value of roots) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const key of ['activeWindowId', 'active_window_id', 'foregroundWindowId', 'foreground_window_id', 'focusedWindowId', 'focused_window_id']) {
      if ((typeof value[key] === 'string' && value[key].trim()) || (typeof value[key] === 'number' && Number.isFinite(value[key]))) activeId = String(value[key]);
    }
  }
  if (!active && activeId) active = windows.find((window) => window.id === activeId) || null;
  return { windows, active };
}
function parseDriverObservation(result) {
  const { windows, active } = collect(unwrapObservation(result));
  return { windows, active };
}
function selectTargetWindow(observation, args = {}, toolName = '') {
  const target = args.target && typeof args.target === 'object' ? args.target : {};
  if (target.kind === 'desktop') return null;
  const topId = [args.window_id, args.windowId, args.hwnd, args.target_window_id, args.targetWindowId]
    .find((value) => (typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value)));
  const targetId = [target.window_id, target.windowId].find((value) => (typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value)));
  const topPid = typeof args.pid === 'number' && Number.isFinite(args.pid) ? args.pid : undefined;
  const targetPid = typeof target.pid === 'number' && Number.isFinite(target.pid) ? target.pid : undefined;
  if (target.kind === 'window' && topId !== undefined && targetId !== undefined && String(topId) !== String(targetId)) return null;
  if (target.kind === 'window' && topPid !== undefined && targetPid !== undefined && topPid !== targetPid) return null;
  const requestedId = target.kind === 'window' ? (targetId ?? topId) : (topId ?? targetId);
  if (requestedId !== undefined) {
    const id = String(requestedId);
    const requestedPid = target.kind === 'window' ? (targetPid ?? topPid) : (topPid ?? targetPid);
    const candidates = observation.windows.filter((window) => window.id === id && (requestedPid === undefined || window.pid === requestedPid));
    return candidates.length === 1 ? candidates[0] : null;
  }
  // A title can select only a title that the driver actually observed; it
  // never becomes the policy identity by itself. Physical input stays scoped
  // to the observed foreground window even if args include a forged title.
  const requestedTitle = typeof args.window_title === 'string' ? args.window_title.trim() : '';
  if (requestedTitle && ['set_value', 'bring_to_front'].includes(toolName)) {
    return observation.windows.find((window) => window.title?.toLowerCase() === requestedTitle.toLowerCase()) || null;
  }
  return observation.active;
}
module.exports = { parseDriverObservation, selectTargetWindow };

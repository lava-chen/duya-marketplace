/**
 * workbench-runtime.ts — Runtime injected into dynamic widget iframes so they
 * can consume live canvas data and dispatch actions (plan 570).
 *
 * The agent HTML is sanitized exactly as before; the runtime adds:
 *   - `window.duya.data`  — latest snapshots, keyed by data-source id;
 *   - `window.duya.onData(cb)` — subscription, called immediately with the
 *     current data and again on every `workbench:data` push;
 *   - `window.duya.action('refresh', sourceId)` — ask the host to refresh a
 *     data source now (host forwards to the main process over IPC).
 *
 * Agent-authored inline `<script>` strategy code is re-enabled AFTER the
 * runtime (see extractInlineScripts), so strategy buttons can bind their own
 * logic to `window.duya`. Simple buttons need no JS at all:
 *   <button data-duya-refresh="src-id">刷新</button>
 *
 * The iframe keeps `sandbox="allow-scripts"` and `connect-src 'none'`: all
 * networking stays in the Electron main process; this bridge only shuttles
 * already-fetched snapshots and action intents.
 */

import { sanitizeForIframe } from './widget-sanitizer';

export const WORKBENCH_DATA_MESSAGE = 'workbench:data';
export const WORKBENCH_ACTION_MESSAGE = 'workbench:action';
export const WORKBENCH_READY_MESSAGE = 'workbench:ready';

export interface WorkbenchDataPayload {
  /** Snapshot per source id / handler name; values are JSON data or null. */
  snapshots: Record<string, unknown>;
  refreshedAt?: number;
}

export interface WorkbenchActionPayload {
  kind: 'refresh';
  sourceId?: string;
}

const RUNTIME_SCRIPT = /* js */ `(function () {
  'use strict';
  var subscribers = [];
  var pendingActions = {};

  function sendToHost(message) {
    try {
      window.parent.postMessage(message, '*');
    } catch (err) { /* host gone — nothing to do */ }
  }

  var duya = {
    version: 1,
    data: {},
    theme: null,
    onData: function (cb) {
      if (typeof cb !== 'function') return function () {};
      subscribers.push(cb);
      try { cb(duya.data); } catch (err) { /* listener errors are the widget's own */ }
      return function () {
        var index = subscribers.indexOf(cb);
        if (index >= 0) subscribers.splice(index, 1);
      };
    },
    action: function (kind, name) {
      if (kind === 'refresh') {
        sendToHost({ type: '${WORKBENCH_ACTION_MESSAGE}', action: { kind: 'refresh', sourceId: String(name || '') } });
      }
    }
  };
  window.duya = duya;

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === '${WORKBENCH_DATA_MESSAGE}' && data.snapshots && typeof data.snapshots === 'object') {
      duya.data = data.snapshots;
      for (var i = 0; i < subscribers.length; i++) {
        try { subscribers[i](duya.data); } catch (err) { /* isolated per listener */ }
      }
    } else if (data.type === 'widget:theme') {
      duya.theme = data.theme || null;
      document.documentElement.style.colorScheme = data.theme === 'dark' ? 'dark' : 'light';
      document.documentElement.dataset.theme = data.theme === 'dark' ? 'dark' : 'light';
    }
  });

  // Attribute-driven actions — keeps simple strategy buttons JS-free.
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var refreshEl = target.closest('[data-duya-refresh]');
    if (refreshEl) {
      event.preventDefault();
      duya.action('refresh', refreshEl.getAttribute('data-duya-refresh'));
      return;
    }
    var actionEl = target.closest('[data-duya-action]');
    if (actionEl) {
      event.preventDefault();
      var raw = actionEl.getAttribute('data-duya-action');
      var parsed;
      try { parsed = JSON.parse(raw); } catch (err) { parsed = null; }
      if (parsed && parsed.kind === 'refresh' && parsed.sourceId) {
        duya.action('refresh', parsed.sourceId);
      }
    }
  });

  // Height reporting — the host grows the widget to fit content.
  function reportHeight() {
    var h = Math.max(
      document.documentElement.scrollHeight || 0,
      document.documentElement.offsetHeight || 0,
      document.body ? document.body.scrollHeight || 0 : 0,
      document.body ? document.body.offsetHeight || 0 : 0
    );
    if (h > 0) {
      sendToHost({ type: 'widget:resize', height: Math.ceil(h) });
    }
  }
  var reportTimer = null;
  function scheduleHeightReport() {
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = setTimeout(reportHeight, 50);
  }

  function setup() {
    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(function () { scheduleHeightReport(); });
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    }
    var mo = new MutationObserver(function () { scheduleHeightReport(); });
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    window.addEventListener('load', reportHeight);
    reportHeight();
    setTimeout(reportHeight, 300);
    sendToHost({ type: '${WORKBENCH_READY_MESSAGE}' });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();
`;

/** Sandbox-local renderer: the host receives only a PNG and never reads the
 * opaque-origin frame's document. This script is also added to static widget
 * srcdocs so all plugin-owned widgets can answer the capture handshake. */
const WIDGET_CAPTURE_SCRIPT = /* js */ `(function () {
  'use strict';
  window.addEventListener('message', function (event) {
    var request = event.data;
    if (event.source !== window.parent || !request || request.type !== 'duya:canvas-capture-request' || typeof request.requestId !== 'string') return;
    capture(request.requestId);
  });

  function capture(requestId) {
    try {
      var sources = [document.documentElement].concat(Array.prototype.slice.call(document.querySelectorAll('*')));
      var clone = document.documentElement.cloneNode(true);
      var copies = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*')));
      var warnings = [];
      var jobs = [];
      for (var i = 0; i < sources.length; i++) {
        var source = sources[i];
        var copy = copies[i];
        var computed = window.getComputedStyle(source);
        for (var j = 0; j < computed.length; j++) {
          var property = computed[j];
          var value = computed.getPropertyValue(property);
          if (/url\((?![\"']?(?:data:|#))/i.test(value)) {
            value = value.replace(/url\((?:\"[^\"]*\"|'[^']*'|[^)]*)\)/gi, 'none');
            warnings.push('Some widget background images could not be embedded.');
          }
          copy.style.setProperty(property, value, 'important');
        }
        if (source instanceof HTMLCanvasElement) {
          try {
            var image = document.createElement('img');
            image.src = source.toDataURL('image/png');
            image.setAttribute('style', copy.getAttribute('style') || '');
            copy.replaceWith(image);
          } catch (error) { warnings.push('A widget drawing could not be exported.'); }
        } else if (source instanceof HTMLImageElement && (source.currentSrc || source.src)) {
          (function (originalImage, clonedImage) {
            jobs.push(fetch(originalImage.currentSrc || originalImage.src, { mode: 'cors', credentials: 'same-origin' })
              .then(function (response) { if (!response.ok) throw new Error('image request failed'); return response.blob(); })
              .then(function (blob) { return new Promise(function (resolve, reject) {
                var reader = new FileReader(); reader.onload = function () { resolve(String(reader.result)); };
                reader.onerror = reject; reader.readAsDataURL(blob);
              }); })
              .then(function (dataUrl) { clonedImage.src = dataUrl; clonedImage.removeAttribute('srcset'); })
              .catch(function () { clonedImage.removeAttribute('src'); warnings.push('A widget image could not be embedded.'); }));
          })(source, copy);
        }
      }
      Promise.all(jobs).then(function () {
        clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
        clone.style.setProperty('width', window.innerWidth + 'px', 'important');
        clone.style.setProperty('height', window.innerHeight + 'px', 'important');
        clone.style.setProperty('overflow', 'hidden', 'important');
        var html = new XMLSerializer().serializeToString(clone);
        var width = Math.max(1, window.innerWidth);
        var height = Math.max(1, window.innerHeight);
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '"><foreignObject x="0" y="0" width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">' + html + '</div></foreignObject></svg>';
        var rendered = new Image();
        rendered.onload = function () {
          var canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
          var context = canvas.getContext('2d'); if (!context) throw new Error('Canvas context unavailable');
          context.drawImage(rendered, 0, 0, width, height);
          if (warnings.length) {
            context.fillStyle = 'rgba(35,35,35,.88)'; context.fillRect(0, 0, width, 22);
            context.fillStyle = '#fff'; context.font = '11px sans-serif';
            context.fillText(('Widget capture note: ' + warnings.join(' ')).slice(0, 180), 6, 15, Math.max(1, width - 12));
          }
          var dataUrl = canvas.toDataURL('image/png');
          if (dataUrl.length > 8 * 1024 * 1024) throw new Error('Widget screenshot exceeds the 6 MiB limit.');
          window.parent.postMessage({ type: 'duya:canvas-capture-response', requestId: requestId, dataUrl: dataUrl }, '*');
        };
        rendered.onerror = function () { replyError(requestId, 'Widget DOM could not be rendered.'); };
        rendered.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      }).catch(function () { replyError(requestId, 'Widget resources could not be rendered.'); });
    } catch (error) { replyError(requestId, String(error && error.message || error)); }
  }

  function replyError(requestId, message) {
    window.parent.postMessage({ type: 'duya:canvas-capture-response', requestId: requestId, error: message }, '*');
  }
})();`;

export function injectWidgetCaptureRuntime(srcdoc: string): string {
  if (srcdoc.includes('data-duya-capture-runtime="v1"')) return srcdoc;
  const script = `<script data-duya-capture-runtime="v1">${WIDGET_CAPTURE_SCRIPT}</script>`;
  if (/<\/body\s*>/i.test(srcdoc)) return srcdoc.replace(/<\/body\s*>/i, `${script}</body>`);
  if (/<\/html\s*>/i.test(srcdoc)) return srcdoc.replace(/<\/html\s*>/i, `${script}</html>`);
  return `${srcdoc}${script}`;
}

/**
 * Inline `<script>` extraction mirrors the chat widget path
 * (`buildReceiverSrcdoc`): agent-authored strategy scripts are stripped by the
 * static sanitizer and re-injected into the workbench srcdoc AFTER the runtime,
 * so they execute inside the same `sandbox="allow-scripts"` iframe with
 * `window.duya` already defined. Externally-sourced script tags (`src=`) are
 * dropped entirely — widgets have no network, matching `connect-src 'none'`.
 */
const SCRIPT_TAG_RE = /<script[\s\S]*?<\/script>/gi;
const SCRIPT_SRC_ATTR_RE = /\ssrc\s*=\s*["'][^"']*["']/i;

function extractInlineScripts(source: string): { withoutScripts: string; scripts: string[] } {
  const scripts: string[] = [];
  const withoutScripts = source.replace(SCRIPT_TAG_RE, (tag) => {
    if (SCRIPT_SRC_ATTR_RE.test(tag)) return '';
    const inner = tag.replace(/<\/?script[^>]*>/gi, '').trim();
    if (inner) scripts.push(inner);
    return '';
  });
  return { withoutScripts, scripts };
}

/**
 * Build the srcdoc for a workbench widget: sanitized agent HTML + runtime +
 * re-enabled agent strategy scripts (executed after the runtime so
 * `window.duya` is defined).
 */
export function buildWorkbenchSrcdoc(
  sourceCode: string,
  initialData?: WorkbenchDataPayload,
): string {
  const { withoutScripts, scripts } = extractInlineScripts(sourceCode);
  const sanitized = sanitizeForIframe(withoutScripts);
  const seedScript = initialData
    ? `<script>window.addEventListener('DOMContentLoaded',function(){` +
      `if(window.duya){window.duya.data=${JSON.stringify(initialData.snapshots ?? {}).replace(/</g, '\\u003c')};}` +
      `});</script>`
    : '';
  const agentScriptsHtml = scripts.map((code) => `<script>${code}</script>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob: https:; connect-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none';">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html { width: 100%; margin: 0; padding: 0; background: transparent; }
  body {
    width: 100%; margin: 0; padding: 12px; background: transparent;
    color: var(--text, #e5e5e5); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px; line-height: 1.5; overflow: hidden;
  }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 6px 8px; border: 1px solid rgba(128,128,128,0.25); text-align: left; }
  button {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 6px 12px; border-radius: 6px; border: 1px solid rgba(128,128,128,0.35);
    background: transparent; color: inherit; font-size: 0.8125rem; cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  button:hover { background: rgba(128,128,128,0.12); border-color: rgba(128,128,128,0.55); }
  button:active { background: rgba(128,128,128,0.22); }
</style>
${seedScript}
</head>
<body>${sanitized}
<script>${RUNTIME_SCRIPT}</script>
<script data-duya-capture-runtime="v1">${WIDGET_CAPTURE_SCRIPT}</script>
${agentScriptsHtml}
</body>
</html>`;
}

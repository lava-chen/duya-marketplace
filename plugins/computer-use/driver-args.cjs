'use strict';

// Translation between the plugin's agent-facing arguments and the driver's
// native arguments.
//
// The plugin gives the agent one handle (`state_id`) that names the
// observation an action was derived from. The driver knows none of that: it
// rejects unknown arguments, requires the target identity for window scope,
// and requires an explicit scope for screen-absolute coordinates.
//
// So the plugin never forwards its own vocabulary, and it fills in what the
// driver needs from the observation the action was bound to.

const PLUGIN_ONLY_ARGUMENTS = ['state_id'];

function propertiesOf(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.properties && typeof schema.properties === 'object') return schema.properties;
  if (schema.inputSchema && typeof schema.inputSchema === 'object' && schema.inputSchema.properties) return schema.inputSchema.properties;
  return null;
}

// Build the arguments the driver receives.
//
//   scope: 'desktop'  the observation was a full-screen capture, so the
//                      coordinates are screen pixels and the driver needs
//                      scope "desktop" without a window identity.
//   scope: 'window'   the observation was a window capture, so the
//                      coordinates are window-local pixels and the driver
//                      needs the target pid (and the window id when known).
function toDriverArguments({ args = {}, state = null, schema = null } = {}) {
  const forwarded = { ...args };
  for (const key of PLUGIN_ONLY_ARGUMENTS) delete forwarded[key];

  const properties = propertiesOf(schema);
  const accepts = (key) => !properties || Object.hasOwn(properties, key);
  const target = state?.window || null;

  // An action that names its own target stays window scoped: the driver
  // delivers into that window, and the plugin verified it against the
  // observation before it got here.
  const namesTarget = forwarded.pid !== undefined || forwarded.window_id !== undefined;

  if (!namesTarget && state?.scope === 'desktop') {
    if (accepts('scope')) forwarded.scope = 'desktop';
    if (accepts('pid')) delete forwarded.pid;
    if (accepts('window_id')) delete forwarded.window_id;
    return forwarded;
  }

  if (target) {
    if (accepts('pid') && forwarded.pid === undefined && Number.isInteger(target.pid)) forwarded.pid = target.pid;
    if (accepts('window_id') && forwarded.window_id === undefined && target.id !== null && target.id !== undefined) {
      const numeric = Number(target.id);
      if (Number.isFinite(numeric)) forwarded.window_id = numeric;
    }
  }
  return forwarded;
}

// The observation tools need the target identity too: the real driver
// requires pid and window_id for a window read and refuses to guess.
function resolveWindowTarget({ args = {}, windows = [] } = {}) {
  const forwarded = { ...args };
  const requestedPid = typeof forwarded.pid === 'number' ? forwarded.pid : null;
  const requestedId = forwarded.window_id ?? forwarded.windowId;
  if (requestedId !== undefined && requestedId !== null) {
    if (forwarded.window_id === undefined) forwarded.window_id = Number(requestedId);
    delete forwarded.windowId;
    return forwarded;
  }
  if (requestedPid === null) return forwarded;
  const candidates = windows.filter((window) => window.pid === requestedPid);
  if (candidates.length === 1) forwarded.window_id = Number(candidates[0].id);
  return forwarded;
}

module.exports = { PLUGIN_ONLY_ARGUMENTS, resolveWindowTarget, toDriverArguments };

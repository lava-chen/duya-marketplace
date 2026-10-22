# DUYA Browser

DUYA Browser exposes the browser control plane as the `cua_repl` MCP server.
Its JavaScript context persists for the lifetime of the MCP connection.

## Tools

- `js({ code, timeout_ms?, title? })` runs JavaScript in the persistent CUA
  context. After startup or reset, one call must contain only
  `await cua.getApiDocs()`; the next call must contain only
  `await cua.getState()`. Read state in a separate call after switching
  targets or active tabs. The server rejects browser actions in the same call
  that reads state.
- `js_add_node_module_dir({ path })` adds an absolute `node_modules` directory
  to the REPL's module search path.
- `js_reset()` clears the JavaScript context and repeats the initialization
  requirement. It leaves browser tabs and their state open.

The CUA bridge supports DUYA's agent webview and the connected Chrome or Edge
extension. DUYA webview tabs opened by the plugin are isolated agent tabs.
System-browser tabs can be selected by ID or exact URL and attached to this
plugin session; closing the CUA session detaches from attached tabs without
closing them.

The CUA API also supports listing, opening, switching, and closing tabs.
Closing an attached system-browser tab releases the attachment; it does not
close the user's tab.

The plugin calls DUYA's local browser daemon. Keep the DUYA desktop app running
and connect the DUYA Browser Bridge extension when controlling system browsers.
MCP tool approval is governed by DUYA's plugin MCP approval flow.

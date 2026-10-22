# DUYA Browser

DUYA Browser exposes a persistent JavaScript CUA session through the
`cua_repl` MCP server. This plugin owns a managed Chromium process, the
Browser Bridge extension, and the local HTTP/WebSocket relay used for Chrome
and Edge. Browser control does not depend on a DUYA browser daemon.

## Tools

- `js({ code, timeout_ms?, title? })` runs JavaScript in the persistent CUA
  context. After startup or reset, one call must contain only
  `await cua.getApiDocs()`; the next call must contain only
  `await cua.getState()`. Read state in a separate call after switching
  targets or active tabs.
- `js_add_node_module_dir({ path })` adds an absolute `node_modules` directory
  to the REPL's module search path.
- `js_reset()` clears JavaScript bindings and repeats the initialization
  requirement. It leaves browser tabs open.

## Managed Chromium

The default `Managed Chromium` target launches a private Chromium process for
this plugin and stores its profile under the plugin data directory. Set
`CHROME_BIN` or `DUYA_BROWSER_EXECUTABLE` when Chrome or Chromium is not on the
system `PATH`. The MCP server explicitly forwards these browser executable
variables plus `DISPLAY`, `XAUTHORITY`, and `WAYLAND_DISPLAY` when configured,
while keeping the rest of the process environment allowlisted. Existing
clients can still use `DUYA` as an alias for this target; it does not select
the DUYA desktop browser panel.

## Chrome and Edge

The plugin process starts its own HTTP and WebSocket relay on
`127.0.0.1:19826`. The extension connects to that service, which forwards
commands and results without a DUYA browser daemon. If a local policy requires
pinning the extension, set `DUYA_BROWSER_EXTENSION_ID` to the ID shown in the
browser's extension details.
The service validates that the claimed extension ID matches the browser's
`chrome-extension://` origin and, when configured, the pinned ID.

To install the extension, open `chrome://extensions` or `edge://extensions`,
enable Developer mode, choose **Load unpacked**, and select this plugin's
`extension/` directory. The service must be running when the extension
connects; the extension retries after service-worker wakeups.

MCP tool approval continues through DUYA's plugin approval flow.

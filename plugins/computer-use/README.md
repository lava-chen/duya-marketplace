# Computer Use

Computer Use is an official DUYA marketplace plugin that connects to the
open-source Cua Driver through its native MCP stdio server. It does not use
DUYA's Computer Use Host capability, `computer_cua` executor, or legacy UIA
bridge. The driver runs locally as a child process of this plugin.

Plugin version: 0.4.0. Minimum supported driver: 0.38.0.

## Install the driver

The Cua Driver is a separate runtime dependency. The plugin does not download
or bundle native executables and ships no simulated copy of the driver. Install
the official MIT-licensed Cua Driver from [the upstream releases](https://github.com/trycua/cua/releases)
or follow the [official installation guide](https://cua.ai/docs/cua-driver).
Use the `cua-driver-rs-v0.38.0` release or later; the plugin speaks the MCP
legacy initialize flow supported by the driver. The upstream release page
supplies macOS, Windows, and Linux builds, along with checksums and Sigstore
attestations. Verify the selected artifact against the published checksum
before installing.

After installation, confirm that `cua-driver --version` works in a terminal.
In DUYA plugin setup, enter the full path to the executable in **Cua Driver
executable path**. On Windows, select `cua-driver.exe`. You can leave the field
empty when `cua-driver` (or `cua-driver.exe` on Windows) is available on the
plugin process `PATH`. Restart the plugin after changing the executable or
installing/updating the driver.

**Extra driver arguments** is an optional JSON array that replaces the default
`mcp` argument, for wrapper scripts that cannot be started directly.
**Minimum Cua Driver version** overrides the compatibility floor; the plugin
refuses to start against an older driver and names both versions in the error.

The host platform and driver build must match. Current upstream release assets
cover macOS Apple Silicon and Intel, Windows x64 and ARM64, and Linux x64 and
ARM64. Desktop capture, accessibility, and input support vary by operating
system and Linux compositor. This plugin has not been validated against every
OS, display server, or driver release. Use the upstream platform guide for
required accessibility, screen capture, and input permissions. Do not install
the optional `cua-perception` extension for this plugin; it is not required and
its OmniParser component is AGPL-3.0-only.

## Driver lifecycle

The plugin starts the driver lazily and supervises it:

- The driver is launched on the first MCP call, not while the plugin loads.
- The handshake verifies the reported driver version against the configured
  minimum before any tool is exposed.
- A crashed driver is reported, respawned with a backoff and never reused;
  the next call starts a fresh child.
- A failed start is recoverable: fixing the executable path and calling again
  retries instead of latching a permanent failure.
- The child receives only the environment needed to resolve the executable and
  reach the desktop, and it is terminated when the plugin stops.

## Tools

The plugin exposes a reviewed allowlist of driver tools — `get_guide`,
`check_permissions`, `get_desktop_state`, `get_window_state`, `list_windows`,
`list_apps`, `get_accessibility_tree`, `get_screen_size`, `verify_state` — plus
the input tools `click`, `double_click`, `right_click`, `drag`, `scroll`,
`type_text`, `press_key`, `hotkey`, `set_value` and `bring_to_front`. Tool
names and input schemas come from the installed driver's live catalog.

Three local tools belong to the plugin:

- `computer_use_status` reports whether input access is currently revoked.
- `computer_use_revoke` revokes input access for a shared timeout.
- `computer_use_screenshot` captures the desktop or one observed window.

## Observations, targets and coordinates

Every desktop observation gets a generation number and is reused for a short
lifetime, so a burst of writes does not capture the screen again. A write is
always authorized against the identity of the current generation: an element
reference from an earlier window observation may only *select* a window, and
the window must still be present in the current observation. A reference to an
unknown, expired or vanished window is refused instead of being guessed.

Coordinates are only converted when the observation itself declares a logical
coordinate space and a scale factor; the plugin then applies the dpi scale and
the monitor origin of the display that owns the point. Otherwise the point is
passed through unchanged and the audit records the driver-native space.

## Screenshots

`computer_use_screenshot` takes an optional `window_id`/`pid`, an optional
`region` (`x`, `y`, `width`, `height`), an optional `format` and an optional
`max_age_ms`. The plugin does not capture the screen itself: the driver returns
the image with the observation. The plugin adds the crop, the format and the
freshness contract, and caches a capture per target and region so a repeated
screenshot does not hit the driver again. Cropping is supported for PNG
captures only, and the plugin never re-encodes a capture into another format:
it reports the mismatch instead of returning a mislabelled image.

## Permissions and policy

`permissions/policy.json` declares observation tools as `read` and input tools
as `write`, with DUYA MCP approval required for write calls. The plugin also
enforces its own rules on top of that:

- **Default deny.** Without a configured app policy every desktop input is
  refused. Configure **App access policy JSON** to allow input, for example
  `{"default_access":"allow"}` to keep the legacy first-run behaviour or
  `{"default_access":"deny","allowed_apps":["chrome.exe"],"denied_apps":["incognito"]}`
  to allow only named applications. Patterns are case-insensitive substrings,
  or full-string globs using `*` and `?`.
- **Observed identity.** The policy check is bound to the observed `pid` /
  `window_id`, the observed active window or an element reference from a
  window observation. A title supplied by the caller cannot substitute for an
  observed identity, and a call without an observed identity is refused.
- **One decision funnel.** Revocation, the app policy and the blocked
  key/text patterns are evaluated in one place, and every denial names the
  rule that produced it.
- **Revocation scope.** Revocation blocks write tools only; read tools,
  `computer_use_status` and `computer_use_screenshot` stay available. The
  timer lives in the shared `DUYA_PLUGIN_DATA/computer-use-control.json`
  ledger, so it blocks input across plugin MCP processes until it expires.
- **Blocked input.** Selected destructive key combinations and shell-like text
  are refused before they reach the driver.

The Cua Driver provides the platform implementation for accessibility-tree
inspection and semantic `set_value`; Windows UIA and the OS's own accessibility
and input permissions are handled by that independent driver. There is no
DUYA Host UIA probe, capture store, overlay, or executor dependency in this
plugin. To revoke OS grants, use the operating system's privacy settings.

## Audit trail

Every call is recorded as one JSON line with the call identifier, tool, tier,
observation generation, target identity, result, policy conclusion, duration
and the (redacted) arguments. Typed text and values are redacted. The log
rotates at 5 MB and keeps three generations. When the log cannot be written the
plugin degrades to an in-memory trail and reports the failure on stderr; the
tool call it describes still completes. **Computer Use audit log path** sets
the location, otherwise it is stored under the user's state directory.

## Data directory, upgrades and uninstall

The plugin keeps no state inside the plugin directory. The revoke ledger lives
in the host provided `DUYA_PLUGIN_DATA` directory, and the audit log lives in
the user's state directory (`%APPDATA%\computer-use\audit.jsonl` on Windows,
`$XDG_STATE_HOME/computer-use/audit.jsonl` elsewhere) unless an audit path is
configured. Upgrading the plugin replaces the plugin directory only and keeps
both files. Uninstalling the plugin removes the plugin directory; delete the
revoke ledger and the audit log separately if the local trail should not be
kept.

## Use

Start with `get_guide`, `check_permissions`, and `get_desktop_state` or
`list_windows`. Select a target window and inspect its latest state before an
input action. Re-observe after changes. The current Cua Driver visible-window
output does not consistently identify which window owns desktop-coordinate
input; strict app restrictions therefore require an explicit observed window
target for those calls. If the driver is missing, incompatible, or denied by
the OS, report the concrete error and ask the user to install/configure it; do
not silently switch to DUYA's legacy Computer Use implementation.

## Tests

```bash
npm test
```

The suite runs on Windows, Linux and macOS: it starts the plugin against a
fake driver, so no Cua Driver installation is required.

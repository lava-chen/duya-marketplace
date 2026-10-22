# Computer Use

Computer Use is an official DUYA marketplace plugin that connects to the
open-source Cua Driver through its native MCP stdio server. It does not use
DUYA's Computer Use Host capability, `computer_cua` executor, or legacy UIA
bridge. The driver runs locally as a child process of this plugin.

## Install the driver

The Cua Driver is a separate runtime dependency. The plugin does not download
or bundle native executables. Install the official MIT-licensed Cua Driver
from [the upstream releases](https://github.com/trycua/cua/releases) or follow
the [official installation guide](https://cua.ai/docs/cua-driver). Use the
`cua-driver-rs-v0.38.0` release or later; the plugin speaks the MCP legacy
initialize flow supported by the driver. The upstream release page supplies
macOS, Windows, and Linux builds, along with checksums and Sigstore attestations.
Verify the selected artifact against the published checksum before installing.

After installation, confirm that `cua-driver --version` works in a terminal.
In DUYA plugin setup, enter the full path to the executable in **Cua Driver
executable path**. On Windows, select `cua-driver.exe`. You can leave the field
empty when `cua-driver` (or `cua-driver.exe` on Windows) is available on the
plugin process `PATH`. Restart the plugin after changing the executable or
installing/updating the driver.

The host platform and driver build must match. Current upstream release assets
cover macOS Apple Silicon and Intel, Windows x64 and ARM64, and Linux x64 and
ARM64. Desktop capture, accessibility, and input support vary by operating
system and Linux compositor. This plugin has not been validated against every
OS, display server, or driver release. Use the upstream platform guide for
required accessibility, screen capture, and input permissions. Do not install
the optional `cua-perception` extension for this plugin; it is not required and
its OmniParser component is AGPL-3.0-only.

## Permissions and lifecycle

The adapter launches `cua-driver mcp` with `shell` disabled and passes only the
OS environment needed to resolve the executable and access the desktop. It
exposes a fixed allowlist of observation and input tools from the driver's live
MCP catalog. Process launch, stdout, stderr, and shutdown are scoped to this
plugin's MCP lifecycle; closing the MCP input or stopping the plugin terminates
the driver child.

`permissions/policy.json` declares observation tools as `read` and input tools
as `write`, with DUYA MCP approval required for write calls. The plugin also
independently blocks selected destructive key combinations and shell-like
text, evaluates app allow/deny patterns, writes a local JSONL audit, and
provides `computer_use_revoke` / `computer_use_status` tools. Its revoke timer
blocks input calls until the timer expires or this MCP server stops. By default,
app access is allowed unless a deny pattern matches, preserving the legacy
first-run behavior; setting an explicit policy makes the default deny unless
`default_access` is set. Configure it in plugin setup under **App access policy JSON** as
`COMPUTER_USE_ACCESS_POLICY='{"default_access":"deny","allowed_apps":["chrome.exe"],"denied_apps":["incognito"]}'`. Patterns are case-insensitive substrings, or full-string globs using `*` and `?`. App identity is taken from the latest desktop/window observation, or a `window_title` / `title` field on the write call. The optional **Computer Use audit log path** setup field sets the JSONL location; otherwise it is stored under the user's state directory. Typed text and values are redacted in the audit.

The Cua Driver provides the platform implementation for accessibility-tree
inspection and semantic `set_value`; Windows UIA and the OS's own accessibility
and input permissions are handled by that independent driver. There is no
DUYA Host UIA probe, capture store, overlay, or executor dependency in this
plugin. To revoke OS grants, use the operating system's privacy settings.

## Use

Start with `get_guide`, `check_permissions`, and `get_desktop_state` or
`list_windows`. Select a target window and inspect its latest state before an
input action. Re-observe after changes. Tool names and input schemas come from
the installed driver's live catalog, restricted to the plugin's reviewed
allowlist. If the driver is missing, incompatible, or denied by the OS, report
the concrete error and ask the user to install/configure it; do not silently
switch to DUYA's legacy Computer Use implementation.

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
as `write`, with DUYA MCP approval required for write calls. The driver runs in
its `standard` mode, which does not display its own consent prompt. DUYA's MCP
approval flow is therefore the approval boundary for each write tool call; the
policy declaration alone does not create a prompt. This adapter does not
provide the legacy Host's per-app UIA guard, separate read-back gate, or audit
and revoke controls. To stop access, disable/uninstall this plugin or stop its
MCP server, and revoke any OS accessibility, screen-capture, or input grants in
the OS privacy settings.

## Use

Start with `get_guide`, `check_permissions`, and `get_desktop_state` or
`list_windows`. Select a target window and inspect its latest state before an
input action. Re-observe after changes. Tool names and input schemas come from
the installed driver's live catalog, restricted to the plugin's reviewed
allowlist. If the driver is missing, incompatible, or denied by the OS, report
the concrete error and ask the user to install/configure it; do not silently
switch to DUYA's legacy Computer Use implementation.

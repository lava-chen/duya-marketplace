# Computer Use

The official DUYA marketplace plugin now discovers a native CUA MCP driver
directly. It does not request DUYA's `computer-use` Host capability or route
its tools through the built-in `computer_cua` executor. DUYA only installs the
plugin, starts its scoped MCP process, and applies its standard tool
approval and lifecycle rules.

## Runtime setup

Install the open-source [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver)
for your desktop platform. In DUYA's plugin settings, set **Cua Driver
executable path** to the installed `cua-driver` binary. The plugin runs
`cua-driver mcp` over stdio through its own MCP adapter and asks the driver to
use `standard` permission mode. The adapter exposes only a reviewed subset of
desktop observation and input tools, excluding process termination, arbitrary
scripts, browser control, and driver reconfiguration. Agent tools come from
the live MCP tool catalog, so their names and schemas match the installed
driver version. Read the driver's guide with
`get_guide` and check the OS permissions with `check_permissions` before
calling desktop actions. Observe current windows or desktop state before
acting on a coordinate or UI element.

The driver is a runtime dependency, not yet bundled with this plugin. A
missing or incompatible binary leaves the MCP server unavailable. The former
DUYA Computer Use implementation remains in the host during the migration;
this package does not invoke it.

## Migration status

This is an independent MCP path, not yet a feature-complete replacement for
DUYA's built-in Windows UIA, read-back, per-app guard, audit, and revoke
flows. The installed desktop build and driver permission behavior still need
platform-by-platform review before the old implementation can be removed.

---
name: computer-use
description: Inspect and operate the local desktop through the Computer Use plugin's native CUA MCP driver. Use when a user explicitly asks for desktop computer interaction.
---

# Computer Use MCP

This plugin starts the configured official `cua-driver mcp` executable as its
own tool server. If no path is configured, it resolves `cua-driver` from `PATH`
(`cua-driver.exe` on Windows). Begin with
`get_guide`, `check_permissions`, and `get_desktop_state` or `list_windows`.
Choose an explicit target window and inspect its latest state before an input
action. Use the driver's own element references or capture-bound coordinates;
re-observe after changes. The installed driver's live MCP schemas are the
authority for arguments and available platform tools.

Every input action is a write action and requires DUYA's MCP tool approval.
The driver's `standard` permission mode is promptless; its policy metadata does
not display a consent prompt by itself. The legacy Computer Use Host's per-app
guard, read-back check, audit, and revoke flow does not cover these calls.

The driver may require operating system accessibility, screen capture, or
input permissions. If its MCP connection or permission checks fail, report the
concrete failure and stop using this plugin until the user configures the
driver. Never substitute DUYA's legacy Computer Use path as if it were this
plugin's implementation.

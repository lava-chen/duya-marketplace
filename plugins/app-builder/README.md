# Mini App Builder

This official development plugin gives DUYA agents a self-contained template
and a skill for creating desktop App plugins. The template is in
`templates/standalone-mini-app/` inside the installed plugin package. It has
a browser-based UI, its own MCP server, a shared data store, an App capability
declaration, and a permissions policy. Copy and customize it in a separate
project, then install it with `duya plugin install --from-path <project-dir>
--yes`.

After installation, the App launcher appears on the plugin's row in Settings
→ Capabilities → Plugins. DUYA discovers the MCP server from
`mcp/servers.json`; an agent can use its tools after the normal tool approval.
From the copied project directory, run `node --test test/template.test.cjs` to
check that its manifest, App tool scope, and persistent MCP server agree.
The template demonstrates a generic App contract. It does not change DUYA's
Canvas, Browser, or Computer Use implementations.

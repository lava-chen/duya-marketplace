# Mini App Builder

This official development plugin gives DUYA agents a self-contained template
and a skill for creating desktop App plugins. The template is in
`templates/standalone-mini-app/` inside the installed plugin package. It has
a browser-based UI, its own MCP server, a shared data store, an App capability
declaration, and a permissions policy. Copy and customize it in a separate
project, then install that project locally through DUYA's Plugins settings.

The template demonstrates a generic App contract. It does not change DUYA's
Canvas, Browser, or Computer Use implementations.

# Computer Use

This plugin requests DUYA's Host-owned `computer-use` capability. It contributes
the plugin identity and usage instructions; DUYA supplies the MCP implementation.
The Host routes calls through the existing `computer_cua` executor and its
session-bound IPC path.

Each call is still attributed to this plugin and passes the regular plugin MCP
approval gate. The CUA executor then applies DUYA's platform, system access,
approval, audit, and revoke checks. This package does not ship an OS automation
runtime and cannot inject arbitrary input directly.

Computer Use is available only when the Host advertises the capability on the
current platform and the user grants the applicable DUYA permissions. The
currently exported structured `computer_cua` implementation is Windows-only;
other platform backends are not part of this migration slice yet.

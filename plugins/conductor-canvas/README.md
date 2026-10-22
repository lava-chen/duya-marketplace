# Conductor Canvas

Conductor Canvas is an external Plugin App backed by the Host-owned
`conductor.canvas` capability. The App does not receive a session ID or a
canvas ID. It binds to the active chat run, then asks the Host to execute a
named Conductor tool using that run's current `ToolUseContext`.

The first slice provides a Host invocation path for the existing Canvas tool
executors and a small App that reads the current canvas. The Host validates
the App binding, the capability grant, the active Conductor mode, and the
existing tool schema before dispatch. Canvas actions continue through the
existing `conductor:executor:rpc` IPC channel.

The rest of the Conductor panel and its editing workflows are still provided
by DUYA's built-in implementation. This package is the independently
installable Mini App starting point; it does not yet replace the existing
panel or remove the built-in Canvas tools.

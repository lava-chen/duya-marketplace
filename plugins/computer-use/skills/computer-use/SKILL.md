---
name: computer-use
description: Drive native desktop applications and the operating system through the Computer Use plugin's Cua Driver MCP server. Use when a task needs real interaction with desktop apps or OS dialogs; for web pages use the browser plugin instead.
---

# Computer Use

`computer-use` exposes the local desktop to an agent through an MCP stdio
server. It starts the official Cua Driver (`cua-driver mcp`) as a child
process and proxies a reviewed allowlist of the driver's MCP tools. The plugin
owns the access policy, the audit trail and the observation bookkeeping; the
driver owns the platform implementation: accessibility tree, screen capture,
synthetic input.

Use it for native desktop applications and OS-level interaction: file dialogs,
native editors, installers, system settings. For web pages use the browser
plugin instead.

The driver is a separate installation and the plugin never installs it. The
plugin itself ships with DUYA, so the user only has to install the driver
once (upstream installer or release archive) and point the plugin settings at
the executable. If the driver is missing, too old, or refused by the operating
system, report the concrete error and stop. Do not substitute another
automation path.

## Vocabulary

The tools below are driver-backed. The DUYA host also exposes its own
`computer_cua` tool under different names. The two surfaces are different
paths: use one of them per task, never both.

This plugin keeps the driver's own tool names on purpose: it is a proxy in
front of the driver, and a second vocabulary would only add a layer that can
drift from the driver it fronts. The table below is the mapping, not a rename.

| This plugin | DUYA host `computer_cua` |
| --- | --- |
| `click` | `left_click` |
| `double_click` | `left_click` with a double click |
| `right_click` | `left_click` with the right mouse button |
| `drag` | `left_click_drag` |
| `type_text` | `type` |
| `press_key`, `hotkey` | `key` |
| `set_value` | `set_value` |
| `scroll` | `scroll` |
| `get_desktop_state`, `get_window_state` | `get_app_state` |
| `list_windows` | `list_windows` |
| `list_apps` | `list_apps` |
| `verify_state` | `verify_state` |
| `bring_to_front` | `activate_window` |

`get_guide`, `check_permissions`, `get_accessibility_tree`, `get_screen_size`
and the local tools (`computer_use_status`, `computer_use_revoke`,
`computer_use_screenshot`, `computer_use_stop`) have no counterpart there.

## The loop

1. Observe: `get_desktop_state` for the whole desktop, `get_window_state` for
   one window. Read the returned `state_id`.
2. Act: send one bounded action and pass that `state_id`.
3. Verify: `verify_state` or a fresh observation. Confirm the application
   changed, not merely that the tool returned.

## Observation replies

Observation tools: `get_desktop_state`, `get_window_state`, `list_windows`,
`get_accessibility_tree`, `get_screen_size`.

The driver's own content blocks are returned unchanged. `structuredContent`
adds:

| Field | Meaning |
| --- | --- |
| `state_id` | Opaque handle for this observation, format `st_xxxxxxxx`. |
| `generation` | Monotonically increasing counter of the observation series. |
| `observed_at` | ISO timestamp of the observation. |
| `target` | `{ window_id, pid, title, app }` of the observed window, or `null`. |
| `screenshot` | `{ id, width, height, mime_type }` of the capture, or `null`. `width` and `height` are the original image dimensions. |
| `display` | `{ scale, coordinate_space, monitors }` when the driver reports display information, otherwise `null`. `coordinate_space` is `logical`, `physical` or `unknown`. |

## The driver contract

The plugin translates; the driver validates. The driver rejects any argument
it does not know, so `state_id` is plugin-local and never reaches it. What
the driver receives is its own shape:

- A desktop observation becomes a screen-absolute action: the plugin sends
  `scope: "desktop"` and no window identity.
- A window observation becomes a window action: the plugin sends the observed
  `pid` and `window_id`.
- Every other argument is passed through untouched, so the driver's own
  options stay available (`delivery_mode`, `count`, `modifier`, `capture_id`,
  `expect`, …).

The driver refuses a call inside its result rather than as a protocol error.
The plugin turns that into the same `<CODE>: … (retry: …)` shape as any other
failure, and a refusal is reported as `outcome: "not_delivered"`: the action
never reached the platform.

The driver delivers in the background by default, so an action does not steal
the focus. Leave `delivery_mode` alone: the driver decides when background
delivery is impossible and says so.

## Action receipts

Action tools: `click`, `double_click`, `right_click`, `drag`, `scroll`,
`type_text`, `press_key`, `hotkey`, `set_value`, `bring_to_front`.

The driver's content blocks are returned unchanged. `structuredContent` adds:

| Field | Meaning |
| --- | --- |
| `state_id` | The observation the action was bound to, or `null`. |
| `outcome` | `delivered`, `not_delivered` or `unknown`. |
| `action_sent` | `true`, `false` or `null`; `null` means the driver did not say. |
| `dispatch_status` | The driver's own dispatch status string when it reports one, else `null`. |
| `code` | `null` on success. |
| `retry` | `null` on success. |
| `duration_ms` | The call duration. |

## Rules

1. **Observe, act, verify.** Observe once, perform one bounded action, then
   observe again to confirm the outcome. Tool success is not proof that the
   application changed.
2. **An action belongs to one observation.** Element references and
   coordinates are valid only for the observation that produced them. Pass that
   observation's `state_id` in the action call. The plugin refuses a coordinate
   action or an element reference without a current `state_id`
   (`STALE_STATE`), and it refuses a `state_id` that is unknown, superseded or
   expired.
3. **One observation, many actions.** A valid `state_id` may be reused for
   several actions; the plugin does not re-observe for it, so an action costs
   one driver round trip.
4. **Coordinates are the pixels of the screenshot you looked at.** The plugin
   never rescales coordinates. If the image was displayed smaller than its
   original size, convert back with `screenshot.width` and
   `screenshot.height` from the observation. Coordinates outside those
   dimensions are refused (`STALE_STATE`). A desktop capture holds screen
   pixels and a window capture holds window-local pixels; the plugin sends
   the matching scope, so the same numbers mean different things in the two.
5. **Accessibility first.** Prefer an element reference over a coordinate;
   prefer `set_value` over typing. An empty element tree is not a failure —
   fall back to a screenshot and a coordinate.
6. **Unknown outcome is not failure.** If `outcome` is `unknown` or
   `action_sent` is `true`, the action may already have landed. Observe
   first; never replay a non-idempotent action blindly.
7. **Verification is a first-class step.** Use `verify_state` or a fresh
   observation to confirm the requested outcome, not merely that the tool
   returned.
8. **Revocation and the stop switch.** `computer_use_revoke` blocks write
   tools only; read tools stay available. `computer_use_stop` ends the
   session. A `CONTROL_BUSY` error means another session owns the desktop:
   report it, do not fight it.
9. **Only one controller.** The plugin leases the desktop for the process that
   owns it.
10. **Blocked input.** Selected destructive key combinations and shell-like
    text are refused by the plugin before they reach the driver. The refusal
    names the reason.
11. **The driver is a separate installation.** If the driver is missing or too
    old, report the concrete error; do not substitute another automation path.
    A `DRIVER_UNAVAILABLE` error usually means the driver was never installed:
    the fix is the upstream installer plus the executable path in the plugin
    settings, not another tool.

## Errors

A failed call answers with an MCP error whose message is exactly
`<CODE>: <human message> (retry: <reobserve|retry|never>)`.

| Code | Meaning | What to do |
| --- | --- | --- |
| `STALE_STATE` | The observation behind the action is gone, superseded or out of date. | Re-observe. |
| `ELEMENT_UNAVAILABLE` | The referenced element no longer exists. | Re-observe. |
| `PERMISSION_DENIED` | The operating system refused the action. | Stop and tell the user. |
| `NOT_AUTHORIZED` | The plugin is not authorized to drive the desktop right now. | Stop. |
| `ACTION_UNAVAILABLE` | The action cannot be performed on that target. | Use another method. |
| `INVALID_REQUEST` | The arguments are wrong. | Fix the call, do not retry it unchanged. |
| `POLICY_DENIED` | The plugin's own access policy refused the action. | The message names the rule. |
| `CONTROL_STOPPED` | The session was stopped. | Re-observe after a new start. |
| `CONTROL_BUSY` | Another plugin process already owns the desktop. | The message names the owner pid. |
| `VERSION_MISMATCH` | The installed driver is older than the supported minimum. | Report it; the plugin names both versions. |
| `DRIVER_UNAVAILABLE` | The driver could not be started or died. | Report it. |
| `DRIVER_TIMEOUT` | The driver did not answer in time. | Report it. |
| `INTERNAL` | Anything else. | Report it. |

| Retry value | Meaning |
| --- | --- |
| `reobserve` | Observe again before deciding. |
| `retry` | The same call may be repeated. |
| `never` | Do not retry; report it. |

The `retry` value in the error message is authoritative.

## Worked example

```
# 1. Observe
get_desktop_state
  -> structuredContent.state_id = "st_4f2ab19c"
     structuredContent.screenshot = { width: 1920, height: 1080, ... }

# 2. Act, bound to that observation
click { state_id: "st_4f2ab19c", x: 412, y: 268 }
  -> structuredContent.outcome = "delivered"

# 3. Verify with a fresh observation
get_desktop_state
  -> structuredContent.state_id = "st_7c05de41"
     confirm the expected change in the new observation
```

## Do not

- Do not replay an action whose `outcome` is `unknown` or whose `action_sent`
  is `true`; observe first.
- Do not reuse a `state_id` from an earlier, superseded or expired
  observation.
- Do not copy coordinates from an accessibility frame; use the pixels of the
  screenshot you looked at, converted with `screenshot.width` and
  `screenshot.height`.
- Do not treat an empty element tree as a failure; fall back to a screenshot
  and a coordinate.
- Do not mix this plugin's tools with the host's `computer_cua` tool in one
  task.

## Local tools

| Tool | Purpose |
| --- | --- |
| `computer_use_status` | Whether input access is currently revoked. |
| `computer_use_revoke` | Revoke input access for a shared timeout (default 120 s, max 3600 s). |
| `computer_use_screenshot` | Capture the desktop or one observed window; optional `region` (`x`, `y`, `width`, `height`), optional `format`, optional `max_age_ms`, optional `refresh`. |
| `computer_use_stop` | End this session: release the desktop lease and refuse every later write with `CONTROL_STOPPED`. |

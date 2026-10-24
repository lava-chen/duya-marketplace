# Computer Use

Computer Use is a DUYA marketplace plugin that exposes the local desktop to an agent through an MCP
stdio server (`node server.cjs`). It launches the official MIT-licensed Cua Driver as a child
process (`cua-driver mcp`) and proxies a reviewed allowlist of the driver's MCP tools. The plugin
owns the access policy, the audit trail and the observation bookkeeping; the driver owns the
platform implementation: accessibility tree, screen capture, synthetic input.

The plugin does not use DUYA's Computer Use Host capability, the `computer_cua` executor or the
legacy UIA bridge, and it bundles no native binary. Plugin version: 0.5.0. Minimum supported
driver: 0.38.0. The agent-facing contract lives in `skills/computer-use/SKILL.md`.

## Install the driver

The Cua Driver is a separate runtime dependency. The plugin does not download or bundle native
executables and ships no simulated copy of the driver. Install the official MIT-licensed Cua
Driver from [the upstream releases](https://github.com/trycua/cua/releases), or follow the
[official installation guide](https://cua.ai/docs/cua-driver). Use the `cua-driver-rs-v0.38.0` release or
later; the plugin speaks the MCP legacy initialize flow supported by the driver.

The upstream release page supplies macOS, Windows, and Linux builds, along with checksums and
Sigstore attestations. Verify the selected artifact against the published checksum before
installing. Current upstream release assets cover macOS Apple Silicon and Intel, Windows x64 and
ARM64, and Linux x64 and ARM64; the host platform and driver build must match. Desktop capture,
accessibility, and input support vary by operating system and Linux compositor, and this plugin
has not been validated against every OS, display server, or driver release.

After installation, confirm that `cua-driver --version` works in a terminal. In DUYA plugin setup,
enter the full path to the executable in **Cua Driver executable path**. On Windows, select
`cua-driver.exe`. You can leave the field empty when `cua-driver` (or `cua-driver.exe` on
Windows) is available on the plugin process `PATH`. Restart the plugin after changing the
executable or installing/updating the driver.

**Extra driver arguments** is an optional JSON array that replaces the default `mcp` argument, for
wrapper scripts that cannot be started directly. **Minimum Cua Driver version** overrides the
compatibility floor; the plugin refuses to start against an older driver and names both versions
in the error. The supported floor is 0.38.0 and can be raised in plugin setup.

Use the upstream platform guide for required accessibility, screen capture, and input permissions.
Do not install the optional `cua-perception` extension for this plugin; it is not required and
its OmniParser component is AGPL-3.0-only.

## Driver lifecycle

The plugin starts the driver lazily and supervises it:

- The driver is launched on the first MCP call, not while the plugin loads.
- The handshake verifies the reported driver version against the configured minimum before any tool is exposed.
- A health check detects a dead driver and reports it.
- A crashed driver is respawned with a backoff and never reused; the next call starts a fresh child.
- A failed start is recoverable: fixing the executable path and calling again retries instead of latching a permanent failure.
- The child receives only the environment needed to resolve the executable and reach the desktop, and it is terminated when the plugin stops.

## Tool surface

Observation tools are `get_desktop_state`, `get_window_state`, `list_windows`,
`get_accessibility_tree` and `get_screen_size`. Action tools are `click`, `double_click`,
`right_click`, `drag`, `scroll`, `type_text`, `press_key`, `hotkey`, `set_value` and
`bring_to_front`. The remaining driver tools are `get_guide`, `check_permissions`, `list_apps`
and `verify_state`.

Four local tools belong to the plugin:

| Tool | Purpose |
| --- | --- |
| `computer_use_status` | Whether input access is currently revoked. |
| `computer_use_revoke` | Revoke input access for a shared timeout (default 120 s, max 3600 s). |
| `computer_use_screenshot` | Capture the desktop or one observed window; optional `region` (`x`, `y`, `width`, `height`), optional `format`, optional `max_age_ms`, optional `refresh`. |
| `computer_use_stop` | End this session: release the desktop lease and refuse every later write with `CONTROL_STOPPED`. |

## The state handle

Every observation is addressed by an opaque `state_id` with the format `st_xxxxxxxx`, paired with a
monotonically increasing `generation`. An observation reply returns the driver's own content
blocks unchanged plus a `structuredContent` object:

| Field | Meaning |
| --- | --- |
| `state_id` | Opaque handle for this observation. |
| `generation` | Monotonically increasing counter of the observation series. |
| `observed_at` | ISO timestamp of the observation. |
| `target` | `{ window_id, pid, title, app }` of the observed window, or `null`. |
| `screenshot` | `{ id, width, height, mime_type }` of the capture, or `null`. `width` and `height` are the original image dimensions. |
| `display` | `{ scale, coordinate_space, monitors }` when the driver reports display information, otherwise `null`. `coordinate_space` is `logical`, `physical` or `unknown`. |

An action is bound to the observation it was derived from. The plugin refuses a coordinate action
or an element reference without a current `state_id`, and it refuses a `state_id` that is unknown,
superseded or expired. A valid `state_id` may be reused for several actions, so an action costs
one driver round trip.

## The action receipt

An action reply returns the driver's own content blocks unchanged plus a `structuredContent`
receipt:

| Field | Meaning |
| --- | --- |
| `state_id` | The observation the action was bound to, or `null`. |
| `outcome` | `delivered`, `not_delivered` or `unknown`. |
| `action_sent` | `true`, `false` or `null`; `null` means the driver did not say. |
| `dispatch_status` | The driver's own dispatch status string when it reports one, else `null`. |
| `code` | `null` on success. |
| `retry` | `null` on success. |
| `duration_ms` | The call duration. |

`outcome` of `unknown`, or `action_sent` of `true`, means the action may already have landed:
observe before deciding, and never replay a non-idempotent action blindly.

## Error codes and retry

A failed call answers with an MCP error whose message is exactly `<CODE>: <human message>
(retry: <reobserve|retry|never>)`.

| Code | Meaning | Retry |
| --- | --- | --- |
| `STALE_STATE` | The observation behind the action is gone, superseded or out of date. Re-observe. | `reobserve` |
| `ELEMENT_UNAVAILABLE` | The referenced element no longer exists. Re-observe. | `reobserve` |
| `PERMISSION_DENIED` | The operating system refused the action. Stop and tell the user. | `never` |
| `NOT_AUTHORIZED` | The plugin is not authorized to drive the desktop right now. Stop. | `never` |
| `ACTION_UNAVAILABLE` | The action cannot be performed on that target. Use another method. | `never` |
| `INVALID_REQUEST` | The arguments are wrong. Fix the call, do not retry it unchanged. | `never` |
| `POLICY_DENIED` | The plugin's own access policy refused the action. The message names the rule. | `never` |
| `CONTROL_STOPPED` | The session was stopped. A new session is needed. | `never` |
| `CONTROL_BUSY` | Another plugin process already owns the desktop. The message names the owner pid. | `never` |
| `VERSION_MISMATCH` | The installed driver is older than the supported minimum. | `never` |
| `DRIVER_UNAVAILABLE` | The driver could not be started or died. | `retry` |
| `DRIVER_TIMEOUT` | The driver did not answer in time. | `retry` |
| `INTERNAL` | Anything else. | `retry` |

| Retry value | Meaning |
| --- | --- |
| `reobserve` | Observe again before deciding. |
| `retry` | The same call may be repeated. |
| `never` | Do not retry; report it. |

The `retry` value in the error message is authoritative.

## Screenshots

`computer_use_screenshot` captures the desktop or one observed window. The plugin does not capture
the screen itself: the driver returns the image with the observation. The plugin adds the crop,
the format and the freshness contract, and caches a capture per target and region so a repeated
screenshot does not hit the driver again. Cropping is supported for PNG captures only, and the
plugin never re-encodes a capture into another format: it reports the mismatch instead of
returning a mislabelled image. The `max_age_ms` freshness window decides whether the cached
capture is still usable; `refresh` bypasses it.

## Policy, revocation and concurrency

`permissions/policy.json` declares observation tools as `read` and input tools as `write`, with
DUYA MCP approval required for write calls. Every denial names the rule that produced it:

- **Default deny.** Without a configured app policy every desktop input is refused. Configure **App
  access policy JSON** to allow input, for example `{"default_access":"allow"}` to allow all input or
  `{"default_access":"deny","allowed_apps":["chrome.exe"],"denied_apps":["incognito"]}` to allow
  only named applications. Patterns are case-insensitive substrings, or full-string globs using `*`
  and `?`.
- **Observed identity.** The policy check is bound to the observed `pid` / `window_id`, the observed
  active window, or the window of the `state_id` the action carries. A title supplied by the caller
  cannot substitute for an observed identity, and a call without an observed identity is refused.
- **Revocation scope.** Revocation blocks write tools only; read tools, `computer_use_status` and
  `computer_use_screenshot` stay available. The timer lives in the shared `DUYA_PLUGIN_DATA` revoke
  ledger, so it blocks input across plugin MCP processes until it expires.
- **Blocked input.** Selected destructive key combinations and shell-like text are refused before
  they reach the driver. The refusal names the reason.
- **One controller.** The plugin leases the desktop for the process that owns it. A `CONTROL_BUSY`
  error means another plugin process owns the desktop and the message names the owner pid.

The driver needs the platform's own accessibility, screen capture and input permissions; the plugin
never elevates, installs a service or changes security settings. To revoke OS grants, use the
operating system's privacy settings.

## Audit trail

Every call is recorded as one JSON line with the call identifier, tool, tier, `state_id`,
generation, target identity, result, outcome, `action_sent`, dispatch status, error code, retry
hint, policy conclusion, duration and the redacted arguments. Typed text and values are redacted.
A refusal is recorded the same way: it carries the rule that produced it, the error code and
`outcome: "not_delivered"`, because the action never reached the driver.
The log rotates at 5 MB and keeps three generations.
When the log cannot be written the plugin degrades to an in-memory trail and reports the failure on
stderr; the tool call it describes still completes. **Computer Use audit log path** sets the
location, otherwise it is stored under the user's state directory.

## Data directory, upgrades and uninstall

The plugin keeps no state inside the plugin directory. The revoke ledger and the control lease live
in the host provided `DUYA_PLUGIN_DATA` directory, and the audit log lives in the user's state
directory
(`%APPDATA%\computer-use\audit.jsonl` on Windows, `$XDG_STATE_HOME/computer-use/audit.jsonl`
elsewhere) unless an audit path is configured. Upgrading the plugin replaces the plugin directory
only and keeps both files. Uninstalling the plugin removes the plugin directory; delete the revoke
ledger, the control lease and the audit log separately if the local trail should not be kept.

## Tests

```bash
npm test
```

The suite runs on Windows, Linux and macOS: it starts the plugin against a fake driver, so no Cua
Driver installation is required.

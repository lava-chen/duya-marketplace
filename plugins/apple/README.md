# Apple Suite Plugin

End-to-end Apple ecosystem integration on macOS: Notes, Reminders, Find My, and iMessage — bundled under one plugin, each accessible as a standalone skill.

## What this plugin adds

Four macOS-only skills:

- **`apple-notes`** — Create, view, search, and edit Apple Notes via the `memo` CLI. Notes sync across all Apple devices via iCloud.
- **`apple-reminders`** — Manage Apple Reminders via `remindctl`. Tasks and lists sync to iPhone/iPad/Mac via iCloud.
- **`findmy`** — Track Apple devices and AirTags via FindMy.app. Uses AppleScript + screen capture + `peekaboo` for UI automation.
- **`imessage`** — Send and receive iMessage/SMS via the `imsg` CLI. Works with any phone number or Apple ID.

## Platform requirement

**macOS only.** All four skills require macOS with the respective Apple apps signed into iCloud. No Windows or Linux support.

## Prerequisites

Each skill requires its own CLI tool installed via Homebrew:

| Skill | CLI tool | Install command |
|---|---|---|
| `apple-notes` | `memo` | `brew tap antoniorodr/memo && brew install antoniorodr/memo/memo` |
| `apple-reminders` | `remindctl` | `brew install steipete/tap/remindctl` |
| `findmy` | *(optional)* `peekaboo` | `brew install steipete/tap/peekaboo` |
| `imessage` | `imsg` | `brew install steipete/tap/imsg` |

Grant the necessary system permissions (Automation, Full Disk Access, Screen Recording) when prompted.

## Migration from individual plugins

This plugin supersedes the four standalone plugins that previously appeared separately in the marketplace:

- `apple-notes` → now `apple` / `apple-notes` skill
- `apple-reminders` → now `apple` / `apple-reminders` skill
- `findmy` → now `apple` / `findmy` skill
- `imessage` → now `apple` / `imessage` skill

Existing installations of the old plugins are automatically redirected. Uninstall the old plugins after upgrading to avoid confusion.

## When to suggest this plugin

Suggest when the user mentions any Apple first-party app (Notes, Reminders, Find My, Messages) on macOS. Do not suggest for cross-platform scenarios or when the user is on iOS-only without a Mac.

## Safety posture

- `apple-notes`: read operations are automatic; writes (create/edit/delete) require user confirmation.
- `apple-reminders`: create/complete/delete require user confirmation.
- `findmy`: read-only location queries; no write operations.
- `imessage`: send operations always require explicit user confirmation with recipient and message content shown before delivery.

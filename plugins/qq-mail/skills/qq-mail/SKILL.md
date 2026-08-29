---
name: qq-mail
description: Operate QQ Mail (QQ 邮箱, mail.qq.com) via the official IMAP / SMTP / Exchange endpoints. Read, search, send, move, and label messages across @qq.com / @foxmail.com / @vip.qq.com mailboxes. Uses the 'qq-mail' app connection registered in duya's AppConnectorRegistry — provide your email + authorization code (授权码) at install time.
version: 0.1.0
author: DUYA Agent
license: MIT
metadata:
  hermes:
    tags: [Tencent, 腾讯, QQ, QQMail, 邮箱, Email, Foxmail, IMAP, SMTP, Exchange, AuthorizationCode, Productivity]
    related_skills: [tencent-docs, google, slack]
---

# QQ Mail (QQ 邮箱) via IMAP / SMTP / Exchange

Operate mailboxes hosted on `mail.qq.com` (covers `@qq.com`, `@foxmail.com`,
`@vip.qq.com`) through the official mail protocols published at
`https://service.mail.qq.com/`. QQ Mail does **not** expose a public
REST OpenAPI like Tencent Docs; the supported integration path is the
standard IMAP / SMTP / Exchange stack authenticated with an **authorization
code (授权码)**, not the user's QQ password.

> Reference: QQ 邮箱帮助中心
> (`https://service.mail.qq.com/`) — sections: 登录和退出 / 邮箱设置
> (POP/IMAP 和 Exchange 服务的设置方法) / 反垃圾邮件.

## When to Use

Use this skill when the user wants to:
- List folders (inbox, sent, drafts, custom folders)
- Search / read / open a specific message
- Compose and send a new email (plain text or HTML, with attachments)
- Reply to or forward an existing thread
- Move messages between folders, mark read / unread, star, or delete

## Required Setup

Before any call, the `qq-mail` app connection must be **installed and the
authorization code generated**:

1. Sign in to the user's QQ mailbox at `https://wx.mail.qq.com/`.
2. Open **设置 → 账户** (`https://wx.mail.qq.com/settings/account`).
3. Locate **POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV服务** and turn on:
   - **IMAP/SMTP服务** → 保存 (generates a 16-char 授权码)
   - **Exchange服务** (optional, for push to mobile)
4. Copy the generated 授权码 (it is shown once — store it in the duya
   connector setup).
5. In duya, install the `qq-mail` plugin and provide:
   - `email`: full address (e.g. `123456789@qq.com` or `alice@foxmail.com`)
   - `auth_code`: the 16-char authorization code from step 4
   - `imap_host` / `imap_port` (default `imap.qq.com` / `993` SSL)
   - `smtp_host` / `smtp_port` (default `smtp.qq.com` / `465` SSL,
     or `587` STARTTLS)
6. The connector opens an IMAP IDLE connection on port 993 for push and
   a lazy SMTP connection on port 465 for outbound. Credentials are
   never sent in plain — IMAP LOGIN uses `AUTHENTICATE PLAIN` over TLS,
   SMTP uses `AUTH LOGIN` over TLS.

The skill itself only orchestrates calls — credential storage, IMAP IDLE,
SMTP submission, retry on transient failure are handled by the connector.

## Server Endpoints (canonical)

| Protocol | Host | Port | TLS | Auth |
| --- | --- | --- | --- | --- |
| IMAP (read) | `imap.qq.com` | `993` | implicit SSL | `AUTHENTICATE PLAIN` (email + auth_code) |
| SMTP (send) | `smtp.qq.com` | `465` | implicit SSL | `AUTH LOGIN` (email + auth_code) |
| SMTP (send, alt) | `smtp.qq.com` | `587` | STARTTLS | `AUTH LOGIN` (email + auth_code) |
| POP3 (legacy read) | `pop.qq.com` | `995` | implicit SSL | `USER` + `PASS` (email + auth_code) |
| Exchange (push) | `ex.qq.com` | `443` | HTTPS | OAuth-style token (configured in app) |
| CardDAV (contacts) | `carddav.qq.com` | `443` | HTTPS | Basic auth (email + auth_code) |
| CalDAV (calendar) | `caldav.qq.com` | `443` | HTTPS | Basic auth (email + auth_code) |

> Foxmail accounts use the same servers. `vip.qq.com` uses
> `imap.vip.qq.com` / `smtp.vip.qq.com` on the same ports.

## IMAP Folder Names

Use the canonical English ids when passing folder arguments:

| Folder id | Localized name | Purpose |
| --- | --- | --- |
| `INBOX` | 收件箱 | Received messages |
| `Sent Messages` | 已发送 | Messages you have sent |
| `Drafts` | 草稿箱 | Unsent drafts |
| `Deleted Messages` | 已删除 | Trash (per-account configurable) |
| `Junk` | 垃圾邮件 | Spam |
| `Notes` | 记事本 | QQ Mail notes |
| `&g0l6P3ux-` | 我的文件夹 / 自定义 | Custom user folder (the literal name) |

## API Surface (excerpt)

The connector exposes a stable subset of IMAP4rev1 + SMTP + CardDAV.
Tool names below mirror the `qq-mail.<tool>` MCP namespace once the
connector is registered.

| Tool | Underlying | Purpose |
| --- | --- | --- |
| `qq-mail.list_folders` | IMAP `LIST "" "*"` | List all folders visible to the user |
| `qq-mail.select_folder` | IMAP `SELECT` | Open a folder for subsequent ops |
| `qq-mail.list_messages` | IMAP `UID SEARCH` + `FETCH` | List messages in a folder with cursor pagination |
| `qq-mail.search_messages` | IMAP `UID SEARCH` with text criteria | Search by subject, sender, date, flags |
| `qq-mail.get_message` | IMAP `UID FETCH` (RFC822 + BODY[]) | Fetch a single message with full body + headers |
| `qq-mail.send_message` | SMTP `MAIL FROM` + `RCPT TO` + `DATA` | Send a new email |
| `qq-mail.reply_message` | SMTP (with `In-Reply-To` / `References`) | Reply in-thread |
| `qq-mail.modify_message` | IMAP `STORE` + `MOVE` / `COPY` | Mark read / unread, star, flag, move, label |
| `qq-mail.delete_message` | IMAP `UID STORE \Deleted` + `EXPUNGE` | Move to trash or hard-delete |
| `qq-mail.upload_attachment` | SMTP `BDAT` / chunked | Upload attachment to message draft |
| `qq-mail.idle_subscribe` | IMAP `IDLE` | Push notification when new mail arrives |

## Quick Start

### List unread inbox messages

```json
{
  "operation": "connector_call",
  "connection": "qq-mail",
  "tool": "qq-mail.list_messages",
  "args": { "folder": "INBOX", "unseen": true, "limit": 20 }
}
```

### Send a plain-text email

```json
{
  "operation": "connector_call",
  "connection": "qq-mail",
  "tool": "qq-mail.send_message",
  "args": {
    "from": "123456789@qq.com",
    "to": ["alice@qq.com"],
    "subject": "Q3 planning — draft",
    "body": { "format": "text", "content": "Hi Alice, attached is the draft..." }
  }
}
```

### Search for a message by sender

```json
{
  "operation": "connector_call",
  "connection": "qq-mail",
  "tool": "qq-mail.search_messages",
  "args": { "folder": "INBOX", "from": "boss@qq.com", "subject_contains": "weekly", "limit": 5 }
}
```

## Complete Workflows

### Workflow: Summarize today's inbox

```
User: "Summarize today's inbox"

Agent:
1. connector_call qq-mail.select_folder { name: "INBOX" }
2. connector_call qq-mail.list_messages { unseen: true, since: "today" }
3. For each uid: connector_call qq-mail.get_message { uid }
4. Summarize sender / subject / key ask for the user
```

### Workflow: Reply to a specific email

```
User: "Reply to the latest email from boss@qq.com saying I'll send it by Friday"

Agent:
1. connector_call qq-mail.search_messages { from: "boss@qq.com", limit: 1 }
2. connector_call qq-mail.get_message { uid }                      # capture Message-ID
3. connector_call qq-mail.reply_message
     { uid, in_reply_to: <Message-ID>, body: { format: text, content: "Will send by Friday." } }
4. Confirm with the user and return the Sent Message-ID
```

### Workflow: Triage newsletters

```
User: "Move all newsletters to the Promo folder"

Agent:
1. connector_call qq-mail.list_folders                              # resolve Promo folder id
2. connector_call qq-mail.search_messages { subject_contains: "newsletter" }
3. For each uid: connector_call qq-mail.modify_message
     { uid, move_to: <Promo folder> }
4. Return the count of moved messages
```

### Workflow: Subscribe to IMAP push

```
User: "Tell me when new mail arrives"

Agent:
1. connector_call qq-mail.idle_subscribe { folder: "INBOX" }
2. (the connector emits a `new_message` event for each incoming uid)
3. Agent reacts per event: fetch headers, summarize, etc.
```

## Error Handling

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `AUTHENTICATE failed` | Wrong authorization code or IMAP/SMTP service not enabled | Re-enable IMAP/SMTP in 设置→账户 and paste the new 16-char 授权码 |
| `LOGIN Login fail` (POP) | Same as above; POP3 is the legacy path — prefer IMAP | Switch to IMAP port 993 |
| `534 Error: authentication is disabled` | App is using QQ password instead of 授权码 | Regenerate 授权码 and re-paste; the connector never accepts the QQ password |
| `Too many login failures` | QQ rate-limits failed auth attempts | Wait 30 min and retry |
| `Mailbox quota exceeded` | Mailbox full (free tier 2 GB / VIP 16 GB+) | Tell the user; cannot send or receive until cleaned |
| `550 Mailbox not found` | Wrong recipient address | Verify the address with the user |

## Tips

1. **Folder names** are localized. Prefer the canonical English id
   (`INBOX`, `Sent Messages`, `Drafts`, `Deleted Messages`, `Junk`,
   `Notes`) when passing `folder` arguments. Custom folders keep their
   localized name.
2. **Message UIDs** are 32-bit integers; pass them as numbers, not
   strings.
3. **Attachments** ≤ 50 MB per file (普通附件); ≤ 2 GB via 中转站 /
   超大附件. The connector picks the right path automatically.
4. **HTML bodies** should declare `Content-Type: text/html`. Inline
   images need CID references and a matching MIME `image/*` part.
5. **Push** is available via IMAP `IDLE` on port 993, or via Exchange
   ActiveSync against `ex.qq.com` (preferred for mobile-style push).
6. **Quotas** differ by tier — see
   `https://service.mail.qq.com/detail/0/75/350/2` for current limits.

## Common Issues

| Issue | Solution |
| --- | --- |
| `connector_call` returns `connection_not_found` | Install the `qq-mail` plugin and finish the 授权码 setup first |
| `connector_call` returns `auth_failed` | The 授权码 was rotated or the user changed their QQ password — regenerate and re-install |
| Search returns 0 hits but the message exists in web UI | The IMAP search index lags ~30s; wait and retry once |
| Send returns `554` from remote server | Recipient blocked / domain rejected — surface the error verbatim |
| IMAP idle disconnects after 29 minutes | RFC 2177 limit; the connector auto-reconnects and re-subscribes |

## Related

- **tencent-docs**: Tencent Docs connector — share docs as mail attachments
- **google**: Google Workspace connector — parallel mailbox / drive connector
- **slack**: Slack connector — sometimes used to notify when a mail arrives

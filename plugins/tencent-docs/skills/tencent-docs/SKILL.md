---
name: tencent-docs
description: Operate Tencent Docs (腾讯文档, doc.qq.com) via the official OpenAPI. List, search, read, create, edit, and export online documents, spreadsheets, smartsheets, and forms. Uses the 'tencent-docs' app connection registered in duya's AppConnectorRegistry — provide ClientId + ClientSecret + redirect_uri at install time and complete the OAuth2 authorization code grant once.
version: 0.1.0
author: DUYA Agent
license: MIT
metadata:
  hermes:
    tags: [Tencent, 腾讯, 腾讯文档, TencentDocs, doc.qq.com, Document, Spreadsheet, Smartsheet, OnlineForm, OpenAPI, Productivity]
    related_skills: [google, spreadsheets, documents, presentations, qq-mail]
---

# Tencent Docs (腾讯文档) via OpenAPI

Operate documents hosted on `doc.qq.com` through the official Tencent Docs
OpenAPI documented at `https://docs.qq.com/open/document/app/`. All network
calls go through the `tencent-docs` app connection registered in duya's
AppConnectorRegistry.

> Reference: Tencent Docs Open Platform developer docs
> (`https://docs.qq.com/open/document/app/`) — sections: 开放接口概述 /
> 用户授权 / 文件管理 / 在线表格 / 在线智能表 / 在线文档 / 在线收集表.

## When to Use

Use this skill when the user wants to:
- List / search files across doc / sheet / smartsheet / form
- Read the contents of a doc, sheet, smartsheet, or form
- Create a new doc / sheet / smartsheet / form from a Markdown draft or CSV
- Edit existing document content programmatically
- Export a Tencent Docs file to Markdown / xlsx / pdf

## Required Setup

Before any call, the `tencent-docs` app connection must be **installed,
authenticated, and authorized**:

1. Open the Tencent Docs Open Platform console
   (`https://docs.qq.com/open`) and create a **Server** application.
2. Copy the `ClientId` and `ClientSecret` it issues.
3. In duya, install the `tencent-docs` plugin and paste both into the
   setup prompts, plus your OAuth2 `redirect_uri`.
4. The connector walks the user through the standard OAuth2 authorization
   code grant on first use:
   - redirects the user to the Tencent Docs authorize URL with
     `client_id`, `redirect_uri`, `scope`, `state`
   - Tencent Docs redirects back with `?code=...`
   - the connector POSTs to the token endpoint with `code`,
     `client_id`, `client_secret`, `grant_type=authorization_code`
   - stores the returned `access_token` (and refreshes via refresh_token)
5. Every subsequent API call sends:

   ```
   Authorization: Bearer {access_token}        # if bearer scheme is supported
   Access-Token: {access_token}                # v2/v3 path-style header
   Client-Id:   {client_id}
   Open-Id:     {authorized_open_id}
   Content-Type: application/x-www-form-urlencoded  # for GET/POST form bodies
   Content-Type: application/json                   # for JSON bodies
   ```

The skill itself only orchestrates calls — credential storage, token
exchange, and refresh are handled by the connector.

## API Surface (excerpt)

The connector exposes a stable subset of the Tencent Docs OpenAPI. Tool
names below mirror the `tencent-docs.<tool>` MCP namespace once the
connector is registered. Endpoints follow the official
`https://docs.qq.com/openapi/...` paths.

### File management (`/openapi/drive/v2/files`)

| Tool | HTTP | Path | Purpose |
| --- | --- | --- | --- |
| `tencent-docs.list_files` | GET | `/openapi/drive/v2/files` | List files in a folder (cursor pagination) |
| `tencent-docs.search_files` | GET | `/openapi/drive/v2/files/search` | Full-text search over accessible files |
| `tencent-docs.get_file` | GET | `/openapi/drive/v2/files/{file_id}` | Metadata for one file (name, type, url, owner) |
| `tencent-docs.create_file` | POST | `/openapi/drive/v2/files` | Create new file in a folder, optional initial content |
| `tencent-docs.upload_file` | POST | `/openapi/drive/v2/files/upload` | Upload xlsx / docx / pptx as a new file |
| `tencent-docs.update_file` | PATCH | `/openapi/drive/v2/files/{file_id}` | Rename or move a file |
| `tencent-docs.delete_file` | DELETE | `/openapi/drive/v2/files/{file_id}` | Move to trash |
| `tencent-docs.set_permission` | POST | `/openapi/drive/v2/files/{file_id}/permission` | Set sharing scope (`private`, `publicRead`, `publicWrite`, `members`) |
| `tencent-docs.create_folder` | POST | `/openapi/drive/v2/folders` | Create a folder by name |
| `tencent-docs.list_folders` | GET | `/openapi/drive/v2/folders` | List folders |

### Online documents (`/openapi/doc/v3/{file_id}`)

| Tool | HTTP | Path | Purpose |
| --- | --- | --- | --- |
| `tencent-docs.doc_get` | GET | `/openapi/doc/v3/{file_id}` | Read doc content (returns editable ranges) |
| `tencent-docs.doc_update` | POST | `/openapi/doc/v3/{file_id}` | Batch update content (insert / replace / delete ranges) |

### Online spreadsheets (`/openapi/sheet/v3/{file_id}`)

| Tool | HTTP | Path | Purpose |
| --- | --- | --- | --- |
| `tencent-docs.sheet_get` | GET | `/openapi/sheet/v3/{file_id}` | Read sheet metadata + sheet list |
| `tencent-docs.sheet_read_range` | GET | `/openapi/sheet/v3/{file_id}/sheets/{sheet_id}` | Read cell values in a range |
| `tencent-docs.sheet_write_range` | POST | `/openapi/sheet/v3/{file_id}/sheets/{sheet_id}` | Write cell values in a range |
| `tencent-docs.sheet_append_rows` | POST | `/openapi/sheet/v3/{file_id}/sheets/{sheet_id}:append` | Append rows |

### Online smartsheet (`/openapi/smartsheet/v2/{file_id}`)

| Tool | HTTP | Path | Purpose |
| --- | --- | --- | --- |
| `tencent-docs.smartsheet_list_records` | GET | `/openapi/smartsheet/v2/{file_id}/records` | List records |
| `tencent-docs.smartsheet_create_record` | POST | `/openapi/smartsheet/v2/{file_id}/records` | Create one record |
| `tencent-docs.smartsheet_update_record` | PATCH | `/openapi/smartsheet/v2/{file_id}/records/{record_id}` | Update fields |

### Online form (`/openapi/form/v2/{file_id}`)

| Tool | HTTP | Path | Purpose |
| --- | --- | --- | --- |
| `tencent-docs.form_list_responses` | GET | `/openapi/form/v2/{file_id}/responses` | List submitted responses |
| `tencent-docs.form_get_response` | GET | `/openapi/form/v2/{file_id}/responses/{response_id}` | Read a single response |

> The exact path and parameter names follow the public docs at
> `https://docs.qq.com/open/document/app/`. When the connector is wired,
> the tool list above is what the agent calls.

## Quick Start

### List recent files

```json
{
  "operation": "connector_call",
  "connection": "tencent-docs",
  "tool": "tencent-docs.list_files",
  "args": { "limit": 20, "order_by": "modified_time desc" }
}
```

### Create a new doc from Markdown

```json
{
  "operation": "connector_call",
  "connection": "tencent-docs",
  "tool": "tencent-docs.create_file",
  "args": {
    "type": "doc",
    "title": "Q3 planning — draft",
    "source": { "format": "markdown", "content": "# Q3 planning\n\n..." },
    "parent_folder_id": "<folder_id>"
  }
}
```

### Read a doc's content

```json
{
  "operation": "connector_call",
  "connection": "tencent-docs",
  "tool": "tencent-docs.doc_get",
  "args": { "file_id": "Dxxxxxxxx" }
}
```

### Append rows to a sheet

```json
{
  "operation": "connector_call",
  "connection": "tencent-docs",
  "tool": "tencent-docs.sheet_append_rows",
  "args": {
    "file_id": "Sxxxxxxxx",
    "sheet_id": "<sheet_id>",
    "values": [["2026-08-29", "Alice", 1280]]
  }
}
```

## Complete Workflows

### Workflow: Find a doc and summarize it

```
User: "Find the Q3 planning doc and give me a summary"

Agent:
1. connector_call tencent-docs.search_files { query: "Q3 planning", type: "doc" }
2. Take the first matching file_id
3. connector_call tencent-docs.doc_get { file_id }
4. Summarize the returned editable ranges for the user
```

### Workflow: Convert a local Markdown into a Tencent Doc

```
User: "Turn notes/plan.md into a Tencent Doc"

Agent:
1. Read notes/plan.md locally
2. connector_call tencent-docs.create_file
     { type: doc, title: <basename>, source: { format: markdown, content: <body> } }
3. Return the share link from the response
```

### Workflow: Upload a local xlsx into a specific folder

```
User: "Upload reports/Q3.xlsx to the Reports folder"

Agent:
1. connector_call tencent-docs.list_folders                       # resolve Reports folder_id
2. Read reports/Q3.xlsx as base64
3. connector_call tencent-docs.upload_file
     { parent_folder_id, filename: "Q3.xlsx", content_base64: "..." }
4. connector_call tencent-docs.set_permission
     { file_id, scope: "publicRead" }
5. Return the file URL
```

### Workflow: Log a row into a tracking sheet

```
User: "Add a row to the bug-tracking sheet: status=Open, severity=P1, title=Login fails on Firefox"

Agent:
1. connector_call tencent-docs.search_files { query: "bug-tracking", type: "sheet" }
2. connector_call tencent-docs.sheet_get { file_id }              # resolve sheet_id
3. connector_call tencent-docs.sheet_append_rows
     { file_id, sheet_id, values: [["Open", "P1", "Login fails on Firefox"]] }
4. Confirm row count delta
```

## Error Handling

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `401 invalid_client` | ClientId / ClientSecret pasted wrong or rotated | Re-issue on the Open Platform and re-install the plugin |
| `401 invalid_token` | Access token expired and refresh failed | Trigger the connector's re-authorize flow and retry |
| `403 not_in_scope` | App not authorized for the requested scope (e.g. `doc:write`) | Enable the scope in the Open Platform app config |
| `429 rate_limited` | Exceeded the per-app QPS limit | Back off and retry with exponential delay |
| `404 file_not_found` | Wrong `file_id` or app lost access | Re-list files and confirm the file_id |
| `400 invalid_file_type` | Tried to call `doc_get` on a sheet ID | Switch to `sheet_get` |

## Tips

1. **File IDs** start with a letter prefix:
   - `Dxxxxxxxx` for online document
   - `Sxxxxxxxx` for spreadsheet
   - `Mxxxxxxxx` for smartsheet
   - `Fxxxxxxxx` for online form
   Always quote them as strings.
2. **Markdown import** works for doc and smartsheet (limited). For sheet
   use `format: csv` or upload xlsx via `upload_file`.
3. **Permissions** are inherited from the Tencent Docs web UI — if the
   user cannot open the file in the browser, the API will also reject.
4. **Rate limits** default to 20 QPS per ClientId. Batch large
   operations and prefer cursor pagination over `limit=1000`.
5. **OAuth2 refresh** the connector handles automatically; only when the
   refresh token is revoked on the Open Platform does re-authorization
   require user action.

## Common Issues

| Issue | Solution |
| --- | --- |
| `connector_call` returns `connection_not_found` | The `tencent-docs` plugin is not installed yet — install it and authenticate first |
| `connector_call` returns `token_expired` after long idle | The connector refreshes automatically; if it still fails the user revoked access — re-authorize |
| Markdown tables look wrong in the doc | Tencent Docs converts Markdown tables best when each row is on its own line and cells use ` \| ` |
| Search returns 0 hits for a known file | The index lags ~30s; wait and retry once |

## Related

- **google**: Google Drive / Sheets connector via OAuth (parallel productivity connector)
- **documents / spreadsheets / presentations**: DUYA builtin plugins for the corresponding file formats
- **qq-mail**: Tencent QQ Mail connector — share docs as mail attachments
- **wecom**: WeChat Work enterprise connector — sometimes used together with Tencent Docs in enterprise setups

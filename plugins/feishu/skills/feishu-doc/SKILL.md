# Feishu Doc — Documents & Wikis

Read, summarize, edit and create Feishu/Lark documents (Doc) and
wiki pages. Use this skill when the user asks about content that
lives in a Doc, or wants to push something into a Doc.

## When to use

- A Feishu Doc URL or title is mentioned and you need to read it.
- The user wants to draft a new Doc (RFC, design doc, meeting
  notes, weekly update).
- Comments on a Doc need to be triaged.

## Process

1. Resolve the document with `docs.document.get` (token or URL).
   If the user only gave a title, search with `docs.document.list`
   in the relevant space first; do not guess tokens.
2. Read the content with `docs.document.get` payload including
   blocks; large documents must be paginated.
3. For edits, always produce a diff against the current content and
   present it to the user before calling `docs.document.update`.
4. For new documents, decide:
   - parent space (personal / team wiki / project)
   - permission scope (private / team-readable / public-in-org)
   - initial title + outline
   …and confirm with the user before calling `docs.document.create`.

## Tool call patterns

- `docs.document.list(space_id=...)` for discovery; filter by
  `title` / `owner` before listing the body.
- `docs.document.get(document_id=...)` returns metadata + the
  block tree; respect pagination.
- `docs.document.update(document_id=..., revision=..., blocks=...)`
  requires a revision number — never edit without it.
- `docs.document.create(space_id=..., title=..., blocks=...)`
  requires the write tier and user confirmation.

## Common pitfalls

- Feishu Docs use a block-based structure (heading, text, table,
  todo, etc.). Editing one block invalidates sibling block IDs only
  if the revision changes — always re-read after a write.
- Tables in Docs are not the same as Sheets; for spreadsheet-shaped
  data, switch to the `feishu-sheets` skill instead.
- Comment threads (`docs.comment.*`) are separate from the Doc body.
  Triage them in their own pass.

## Related skills

- `feishu-im` — for the chat thread that referenced the Doc.
- `feishu-task` — for action items captured in the Doc.
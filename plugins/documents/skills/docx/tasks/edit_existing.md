# Editing existing DOCX documents

Follow all 3 steps in order. This preserves the original document's structure
and applies minimal, local edits.

## Step 1: Unpack

```bash
python scripts/office/unpack.py document.docx unpacked/
```

Extracts XML, pretty-prints, merges adjacent runs, and converts smart quotes
to XML entities (`&#x201C;` etc.) so they survive editing. Use
`--merge-runs false` to skip run merging if you need to preserve the original
run structure.

## Step 2: Edit XML

Edit files in `unpacked/word/`. The most common target is `document.xml`.

### Use the Edit tool directly

For string replacements, use the Edit tool directly on the XML files. Do not
write Python scripts for one-off edits — scripts introduce unnecessary
complexity, and the Edit tool shows exactly what is being replaced.

### Author for tracked changes and comments

**Use `"Duya"` as the author** for tracked changes and comments, unless the
user explicitly requests use of a different name. This matches duya's agent
identity.

### Smart quotes for new content

When adding text with apostrophes or quotes, use XML entities to produce
smart (typographic) quotes:

```xml
<!-- Use these entities for professional typography -->
<w:t>Here&#x2019;s a quote: &#x201C;Hello&#x201D;</w:t>
```

| Entity | Character |
|--------|-----------|
| `&#x2018;` | ‘ (left single) |
| `&#x2019;` | ’ (right single / apostrophe) |
| `&#x201C;` | “ (left double) |
| `&#x201D;` | ” (right double) |

### Adding comments

The low-friction path is **post-pack injection by anchor text** — the helper
creates `word/comments.xml`, relationships, and content-type overrides for you:

```bash
python scripts/comments_add.py output.docx --out reviewed.docx \
  --author "Duya" --add "Anchor text=Comment text with &amp; and &#x2019;"
```

To author comment ranges directly in `unpacked/word/document.xml`, follow the
marker pattern in `ooxml/comments.md` (it documents the comments.xml parts,
relationships, and content-type overrides that must exist alongside the
markers). For structured edits to existing comments (reply/resolve/replace),
use `scripts/comments_extract.py` + `scripts/comments_apply_patch.py` on the
packed file.

### Tracked changes

See `ooxml/tracked_changes.md` for insertion, deletion, and paragraph-mark
deletion patterns.

### Common pitfalls

- **Replace entire `<w:r>` elements**: When adding tracked changes, replace
  the whole `<w:r>...</w:r>` block with `<w:del>...<w:ins>...` as siblings.
  Don't inject tracked change tags inside a run.
- **Preserve `<w:rPr>` formatting**: Copy the original run's `<w:rPr>` block
  into your tracked change runs to maintain bold, font size, etc.
- **Element order in `<w:pPr>`**: `<w:pStyle>`, `<w:numPr>`, `<w:spacing>`,
  `<w:ind>`, `<w:jc>`, `<w:rPr>` last. Wrong order causes schema validation
  failures.
- **`xml:space="preserve"`**: Add this attribute to any `<w:t>` with
  leading or trailing whitespace, or the whitespace will be lost on pack.

## Step 3: Pack

```bash
python scripts/office/pack.py unpacked/ output.docx --original document.docx
```

Validates with auto-repair, condenses XML, and creates the DOCX. Use
`--validate false` to skip validation (not recommended for delivery).

**Auto-repair will fix:**
- `durableId` >= 0x7FFFFFFF (regenerates valid ID)
- Missing `xml:space="preserve"` on `<w:t>` with whitespace

**Auto-repair won't fix:**
- Malformed XML, invalid element nesting, missing relationships, schema
  violations. These must be fixed manually before packing.

## Step 4: Visual verification (HARD)

After packing, you MUST run the Visual Verification Gate before declaring
the task complete:

```bash
python scripts/render_docx.py output.docx --out-dir pages/
```

Inspect each `pages/page-*.png` with `vision_analyze`. If defects found,
fix and re-render. See the Visual Verification Gate section in `SKILL.md`.

## Editing tasks — apply instead of major rewrite

When the user asks to edit an existing document, preserve the original and
make minimal, local changes:

- Prefer inline edits (small replacements) over rewriting whole paragraphs.
- Use clear inline annotations/comments at the point of change (margin
  comments or comment markers). Don't move all feedback to the end.
- Keep the original structure unless there's a strong reason; if a
  restructure is needed, do it surgically and explain via comments.
- Don't "cross out everything and rewrite"; avoid heavy, blanket deletions.
  The goal is trackable improvements, not a fresh draft unless explicitly
  requested.

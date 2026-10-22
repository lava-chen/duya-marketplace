---
name: canvas-workflows
description: Create, inspect, organize, and edit canvases with the Conductor Canvas MCP tools. Use when a user wants to build a visual board, arrange its elements, or migrate a canvas snapshot.
---

# Conductor Canvas workflows

Use the `canvas_*` tools provided by the Conductor Canvas marketplace plugin.
Canvas IDs are explicit tool arguments; never infer one from another chat.

## Before editing

1. Call `canvas_manage` with `action: "list"` and select the intended canvas.
2. Call `canvas_get_snapshot` to inspect existing elements and their positions.
3. Keep positions inside the 40 × 30 grid. Each position uses `x`, `y`, `w`,
   and `h` in grid units.
4. Use `canvas_find_empty_space` before adding an element to an existing board.

## Editing

- Create a native item with `canvas_create_element` and a type such as
  `shape`, `text`, `document`, `table`, `link`, `image`, or `file`.
- Change text or content with `canvas_fill_content`; change appearance with
  `canvas_style_element`; move or size with the matching element tool.
- Use `canvas_connect_elements` to relate two item IDs.
- Use `canvas_auto_layout` for a preview, then `canvas_apply_layout` to commit
  the returned positions.
- `canvas_undo` and `canvas_redo` reverse element edits on the selected board.

## Moving canvas data

Use `canvas_export` to produce a portable snapshot. `canvas_import` accepts a
snapshot object and creates a separate canvas, preserving supported element
IDs, positions, content, and configuration. Confirm the destination name with
the user before importing a large board.

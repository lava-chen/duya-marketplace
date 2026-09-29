# Feishu Task — Tasks & Subtasks

Read, create, update and assign Feishu / Lark tasks. Use this skill
when the user wants to manage a TODO list, capture action items
from a meeting, or hand off work to a teammate.

## When to use

- The user says "create a task for X" or "what's on my plate?".
- A meeting or chat thread ends with action items that need to be
  captured as tasks.
- The user wants to reassign or update the status of an existing
  task.

## Process

1. Discover the right task list with `task.tasklist.list` (or
   `task.task.list` with a filter) — never create a new task list
   when one already exists for the project.
2. For each new task, capture:
   - title (one short sentence)
   - description (free-form, optional)
   - due date (ISO 8601 in the user's timezone)
   - assignees (one or more user IDs from `contact.user.search`)
   - parent task (if it's a subtask)
   …and present the payload to the user before creating.
3. For updates, always read the current task first
   (`task.task.get`) to avoid clobbering fields you didn't see.
4. Status transitions (`todo → in_progress → done`) go through
   `task.task.update`; `delete` requires the destructive tier.

## Tool call patterns

- `task.task.list(tasklist_id=..., status=...)` for list views.
- `task.task.get(task_id=...)` to refresh state before editing.
- `task.task.create(tasklist_id=..., ...)` requires user
  confirmation; the write tier covers normal creates.
- `task.task.assign(task_id=..., user_id=...)` is a `modify`-tier
  action; confirm the assignee explicitly.

## Common pitfalls

- Tasks live in tasklists, which live in projects, which live in
  spaces. Walk down before walking up — the user usually means a
  task in the active project's list, not a brand-new tasklist.
- A user ID for assignment must come from `contact.user.search`;
  do not invent one from a display name.
- Marking something `done` is an update, not a delete — never use
  `task.task.delete` for status changes.

## Related skills

- `feishu-im` — when tasks come out of a chat thread.
- `feishu-doc` — when a meeting note references a Doc.
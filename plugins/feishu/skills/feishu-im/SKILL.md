# Feishu IM — Messages & Chats

Read, summarize, draft and send messages on Feishu/Lark. Use this
skill as the entry point for any chat-related work — group threads,
DMs, and bot mentions.

## When to use

- The user asks "what did I miss in chat today?".
- You need to summarize a long thread into a standup-style note.
- You are about to send a message on the user's behalf and need a
  draft for confirmation first.

## Process

1. Call `im.chat.list` to learn which chats the user is in; filter
   to the ones with recent activity using the user's "last read"
   marker when available.
2. For each active chat, pull the recent messages with
   `im.message.list` — paginate by `page_token`/`page_size` rather
   than guessing how many pages you need.
3. Build a summary that names the people involved and the open
   questions, not just message counts.
4. For sending, draft first with `im.message.create_draft`, present
   the draft to the user, then `im.message.send` only after explicit
   confirmation. Never bypass the write tier.

## Tool call patterns

- `im.chat.list` then `im.message.list(chat_id=...)` — never call
  message list on the whole account without scoping it.
- `im.message.get(message_id=...)` to resolve a single message that
  was referenced (e.g. a link from an earlier turn).
- `im.message.send(chat_id=..., content=...)` requires user
  confirmation in `write` tier; do not call this directly without a
  draft step.

## Common pitfalls

- Group chats often span multiple topics; resist the urge to produce
  one flat bullet list. Group by topic or by speaker.
- Bot mentions (`@_user`) need a reply context; use
  `im.message.reply` instead of `im.message.send` when you have a
  `root_id` / `parent_id`.
- Messages in Feishu use a rich-text JSON structure, not plain
  strings. Use the SDK helper or the MCP's structured payload.

## Related skills

- `feishu-doc` — when a thread references a document.
- `feishu-task` — when a thread implies a follow-up action.
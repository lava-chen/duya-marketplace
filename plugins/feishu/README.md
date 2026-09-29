# feishu

飞书（Lark）协作面。覆盖消息、文档、表格、任务、日历与云空间的高频操作。

## 何时启用

- 用户在飞书里聊天、读文档、跟进任务、整理会议纪要。
- 需要把本地结果同步到飞书文档、表格或任务列表。

## 安装

需要在飞书开放平台自建一个企业自建应用，并授予以下权限范围（最小可用集合）：

| 能力 | 所需 scope |
| --- | --- |
| 读取/发送消息 | `im:message`, `im:message.group_at_msg` |
| 读写文档 | `docs:document`, `docs:document.content:read` |
| 读写表格 | `sheets:spreadsheet` |
| 任务 | `task:task`, `task:task:write` |
| 日历 | `calendar:calendar`, `calendar:calendar.event` |
| 云空间 | `drive:drive` |

把 App ID / App Secret 填入插件 setup 后即可使用。

## 提供的技能

| Skill | 用途 |
| --- | --- |
| [`feishu-im`](./skills/feishu-im/SKILL.md) | 消息读取、汇总、起草与发送 |
| [`feishu-doc`](./skills/feishu-doc/SKILL.md) | 文档读取、改写、评论与新建 |
| [`feishu-task`](./skills/feishu-task/SKILL.md) | 任务列表查询、新建、更新与分配 |

更多能力（日历、视频会议、白板、OKR、考勤等）后续按需扩展，对照 [Trae Lark 参考插件](https://github.com/larksuite/lark-mcp)。

## 权限策略

详见 [`permissions/policy.json`](./permissions/policy.json)。简述：

- 只读动作自动放行。
- 发送消息 / 新建文档 / 新建任务需要普通确认（write tier）。
- 删除消息 / 删除文档 / 删除任务需要强确认（destructive tier）。

## MCP 接入

`mcp/servers.json` 引用官方 [lark-mcp](https://github.com/larksuite/lark-mcp) 镜像（占位 tag）。如该镜像不可用，请将 `command` / `args` 切换为 stdio 二进制发布或其他官方分发。

## 状态

`_status: scaffold-stdio-docker`：这是骨架版本，覆盖三个核心技能。完整实现需要继续翻译 Lark/Feishu MCP 的工具面，并补充日历、白板、视频会议、考勤等 skills。
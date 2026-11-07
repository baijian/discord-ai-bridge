# Discord ↔ 本机 AI 桥接

在**私密 Discord 频道**里，用手机继续你在桌面 App 里已经开着的对话。

一个仓库，**两个入口**，各自独立进程、独立 Discord bot：

| 入口 | 连接的本机 App | 配置目录 |
|---|---|---|
| `bin/claude.js` | Claude Desktop（Code tab + Cowork） | `~/.config/ccbridge/` |
| `bin/codex.js` | Codex（`/Applications/ChatGPT.app`） | `~/.config/codexbridge/` |

**Discord 侧命令完全一致**；"怎么跟 App 对话"由 `providers/` 各自实现。

## 结构

```
bin/claude.js        入口（Claude provider）
bin/codex.js         入口（Codex provider）
lib/core.js          Discord 层：命令、绑定、thread、并行、渲染
lib/render.js        流式渲染（节流编辑 / 分片 / 附件）
lib/proxy.js         代理接入（Node 的 fetch/ws 不读 HTTP_PROXY，需手工注入）
lib/store.js         thread 绑定持久化
providers/claude/    Claude 实现
providers/codex/     Codex 实现
```

Provider 需要提供：`config`、`resolveBinary`、`sessions.{list,match,pick,byId,describe,kindLabel}`、
`runTurn`、`newSessionId`、`finalizeNewSession`、`afterTurn`。

## 命令（两边一致）

| 命令 | 作用 |
|---|---|
| `/help` | 列出全部命令 |
| `/sessions`（`/sessionlist`） | 列出对话并编号，标出当前绑定 |
| `/session <编号>` | 把**当前聊天**绑定到该对话；也接受短 id（≥4 位唯一前缀）或标题关键词 |
| `/new` | 解除当前聊天的绑定 |
| `/list` | 列出全部对话（带 8 位短 id） |
| `/status` | 看当前绑定、是否在跑 |
| `/stop` / `/stop all` | 中止本频道 / 全部任务 |
| `/attach` / `/attach <id>` / `/attach auto` | 主频道手动指定对话 |
| `/sync <id>` / `/sync new <标题>` | 给对话开 thread / 从 Discord 新建对话 |
| `/unsync` | 在 thread 里解绑 |

两种绑定方式：

- `/session <编号>` —— 直接绑定当前频道/thread（最像日常聊天）
- `/sync <id>` —— 新开一条 thread 再绑定（多个对话并行时用）

`/sessions` 的编号在**当前聊天内 15 分钟有效**。

## 两个 provider 的差异

| | Claude | Codex |
|---|---|---|
| 会话来源 | App 会话登记簿（`claude-code-sessions/`） | `~/.codex/state_5.sqlite` 的 `threads` 表 |
| 发消息 | `claude -p --resume` | 对话已在 App 打开时 `codex queue`（实时）；否则 `codex exec resume` |
| 桌面可见 | 需重启 App | 打开着则实时；没打开需重启 |
| 新建对话 | 自己生成 id + 写登记簿 | 交给 codex 建，再把 `source/originator` 标成 App 自建（否则 App 隐藏） |

## 配置

两个 provider 各用一个配置目录，字段同名：

- Claude：`~/.config/ccbridge/config.json`，API key 放 `~/.config/ccbridge/api.key`（兼容旧的 `deepseek.key`）
- Codex：`~/.config/codexbridge/config.json`，认证直接复用 `~/.codex/auth.json`（无需额外 key）

```json
{
  "discordToken": "BOT_TOKEN",
  "allowedUserIds": ["YOUR_DISCORD_USER_ID"],
  "channelId": "CHANNEL_ID",
  "projectDir": "~/claude-project",
  "permission": "ro",
  "baseUrl": "https://api.anthropic.com",
  "proxyUrl": "http://127.0.0.1:7890"
}
```

| 字段 | 说明 |
|---|---|
| `allowedUserIds` | **必填**，只有这些人的消息会被处理；其他人静默丢弃 |
| `channelId` | 只响应这个频道及挂在它下面的 thread；留空则不限 |
| `permission` | `ro` 只读 / `rw` 文件读写 / `full` 完全放开（含执行命令） |
| `baseUrl` | Claude provider 的 API 端点，默认 Anthropic 官方；用兼容端点时改这里 |
| `proxyUrl` | 可选，默认读 `HTTPS_PROXY` 等环境变量 |

Discord bot 需要：`Message Content Intent`、`Send Messages`、`Read Message History`、
`Create Public Threads`、`Send Messages in Threads`。

## 运行

```bash
cd discord-ai-bridge
npm install
```

**用 launchd**（不要挂终端；`nohup` 挡不住进程组被 SIGKILL）：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccbridge.claude.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccbridge.codex.plist
```

plist 可以照这个模板建（`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`）：

```xml
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/node</string>
  <string>/ABSOLUTE/PATH/TO/discord-ai-bridge/bin/claude.js</string>
</array>
<key>WorkingDirectory</key>
<string>/ABSOLUTE/PATH/TO/discord-ai-bridge</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>EnvironmentVariables</key>
<dict>
  <key>HTTPS_PROXY</key><string>http://127.0.0.1:7890</string>
</dict>
```

`KeepAlive` 负责崩溃自动拉起；`EnvironmentVariables` 必写代理——launchd 不继承 shell 环境。

日志：`~/.config/ccbridge/bridge.log`、`~/.config/codexbridge/bridge.log`。

## 已知限制

- **单向**：Discord → 桌面会话可见可续；桌面侧发言不回传 Discord。
- **别同时写同一个对话**（桌面正在生成时不要从 Discord 发）。
- 做不到"随时随地实时"：实时只在 App 已加载该对话时成立。
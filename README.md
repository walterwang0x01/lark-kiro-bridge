# lark-kiro-bridge

把本机的 **Kiro CLI** 接到飞书 / Lark 上：在群里 `@bot` 或私聊机器人，消息直达本地 `kiro-cli chat`，回复以**流式卡片**实时刷新；每个聊天独立 session，切目录不丢上下文。

不止是"飞书里聊代码"——结合 Kiro 自带的 lark-* 技能集，机器人还能反过来帮你**操作飞书自己**：删日程、查邮件、改文档、跑 Base 查询、生成 PPT。本地文件操作 + 飞书 API 编排，一个机器人都能干。

## 它能做什么

### 核心交互

- **飞书消息 → Kiro CLI**：群里 `@bot` 或私聊机器人，消息被转发给本机 `kiro-cli chat`，回复以**流式卡片**实时刷新到飞书。
- **每个 chat 独立 Kiro session**：不同群、不同工作目录互相隔离，续聊靠 `--resume-id` 自动接上。
- **打断与排队**：新消息到达自动 abort 旧任务；`/stop` 主动中止。
- **图片 / 文件输入**:发到机器人,自动下载到本地,把绝对路径喂给 Kiro 处理。
- **语音输入**：发语音消息，bridge 调飞书 ASR 转成文字（≤60 秒，需 `ffmpeg` 和 ASR 权限），再交给 Kiro 处理。
- **多模型切换**：`/model` 命令查看 / 切换 / 重置 kiro-cli 模型，支持 per-chat 覆盖。

### 工作区管理

- **工作目录方案 B**：`(chatId, cwd) → kiroSessionId` 双层映射,**切目录不丢上下文,切回来自动续聊**。
- **命名工作区**：`/ws save brand` 把当前 cwd 起个名字，下次 `/ws use brand` 一句切回。
- **根目录白名单**：`workspace.allowedRoots` 限制 `/cd` 能去的范围,避免误切到敏感目录。

### 运维与稳定性

- **进程注册表**：同一个飞书 app 多实例运行会被检测出来（避免 WS 事件被随机路由导致"机器人有时回复有时不回复"）。
- **Idle watchdog**：kiro-cli 卡住时自动 killTree，可全局或按 chat 配置阈值。
- **结构化日志**：NDJSON 按天滚动，超期自动清理，`/doctor` 把日志反喂给 Kiro 自诊断。
- **访问控制**：用户白名单 / 群白名单 / 管理员白名单三层。
- **macOS 后台守护**：`launchd` plist，崩溃自动拉起，开机自启。

### 与 Kiro 生态的联动

这是本项目真正的护城河——配合 Kiro 自带的 lark-* 技能,机器人能用飞书 API 操作飞书自己:

- 在群里说"删掉今天 23 点的会议" → Kiro 调 lark-calendar 找到日程,确认后删除
- "整理一下上周的会议纪要" → Kiro 调 lark-vc 搜索会议,提取纪要,生成周报
- "把这个改动提交一下,拆成原子 commit" → Kiro 在你指定的项目目录执行 git workflow
- "查一下张三的 open_id" → Kiro 调 lark-contact 解析

这是云端 AI 编程助手(Cursor / Copilot / Devin)做不到的——它们碰不到你本机的项目目录,也没有飞书 API 调度能力。

## 快速上手

### 0. 前置条件

- macOS（Linux / Windows daemon 在路线图，前台 `run` 模式可用）
- Node.js ≥ 20
- `kiro-cli` 已装好且能跑：`kiro-cli chat --no-interactive --trust-all-tools "hi"` 应有输出
- 飞书企业自建应用，开启**机器人能力** + 订阅 `im.message.receive_v1` 事件 + 长连接模式
- **可选**：`ffmpeg`（用于飞书语音转文字）。`brew install ffmpeg` / `apt install ffmpeg`。
  没装也能跑，只是收到语音消息时会提示"请安装 ffmpeg"，文字和图片都不受影响。
- **可选**：飞书 ASR scope `speech_to_text:speech`（在飞书开发者后台为 bot 添加）。
  没加权限语音转写会失败，但其他功能正常。**飞书免费版租户不支持调用 ASR**。

### 1. 安装

```bash
git clone https://github.com/walterwang0x01/lark-kiro-bridge.git
cd lark-kiro-bridge
pnpm install
pnpm build
node bin/lark-kiro-bridge.mjs --help
```

全局安装（推荐部署）：

```bash
pnpm build
pnpm link --global
lark-kiro-bridge --help
```

### 2. 配置飞书凭证

```bash
lark-kiro-bridge init
# 提示输入 App ID 和 App Secret
# 写入 ~/.lark-kiro-bridge/config.json （权限 0600）
```

或者直接编辑 `~/.lark-kiro-bridge/config.json`：

```json
{
  "lark": {
    "appId": "cli_xxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxx"
  },
  "kiro": {
    "binPath": "kiro-cli",
    "trustedTools": ["fs_read", "fs_write", "grep", "glob", "code"],
    "timeoutMs": 600000,
    "idleTimeoutMinutes": 5
  },
  "workspace": {
    "defaultCwd": "/Users/you/Projects",
    "allowedRoots": ["/Users/you/Projects"]
  },
  "access": {
    "allowedUsers": [],
    "allowedChats": [],
    "admins": []
  },
  "preferences": {
    "requireMentionInGroup": true,
    "cardUpdateIntervalMs": 800,
    "logRetentionDays": 7
  }
}
```

### 3. 启动

前台跑（开发调试用）：

```bash
lark-kiro-bridge run
```

后台守护（推荐生产）：

```bash
lark-kiro-bridge service install
lark-kiro-bridge service start
lark-kiro-bridge service status
```

启动成功后,在飞书私聊机器人发"你好",应当看到一张流式刷新的卡片。

## 飞书内的斜杠命令

| 命令 | 作用 | 谁能用 |
|------|------|------|
| `/help` | 帮助卡片 | 所有人 |
| `/status` | 当前 cwd / 工作区 / Kiro session / 任务状态 | 所有人 |
| `/pwd` | 当前工作目录 | 所有人 |
| `/new` 或 `/reset` | 重置当前 cwd 下的 Kiro 会话 | 所有人 |
| `/stop` | 停止正在跑的 Kiro 任务 | 所有人 |
| `/model [name\|auto]` | 查看 / 切换 / 重置当前 chat 的模型 | 所有人 |
| `/timeout [N\|off\|default]` | 设置 idle watchdog 阈值（分钟） | 所有人 |
| `/reconnect` | 强制重连飞书 WebSocket（网络抖动后） | **管理员** |
| `/doctor [描述]` | 把日志反喂给 Kiro 自诊断 | **管理员** |
| `/cd <path>` | 切换工作目录（支持 `~/` 展开，受 `allowedRoots` 限制） | **管理员** |
| `/ws list` | 列出所有命名工作区 | 所有人 |
| `/ws save <name>` | 把当前 cwd 存为命名工作区 | **管理员** |
| `/ws use <name>` | 切到命名工作区 | **管理员** |
| `/ws remove <name>` | 删除命名工作区 | **管理员** |
| 其他 `/xxx` | 原样转发给 Kiro CLI | 所有人 |
| 任意文本 | 转发给 Kiro CLI | 所有人 |

**响应规则**：
- 私聊：所有消息都触发
- 群聊（含主题群）：必须 `@bot` 才触发；`requireMentionInGroup: false` 可关闭这个限制
- `@all` 永不响应

⚠️ kiro-cli 自带的 TUI 命令（`/agent` `/tools` `/compact` `/login` `/logout`）在非交互模式下不可用。

## 工作目录方案 B 是怎么工作的

每个飞书 chat 维护一个状态对象：

```json
{
  "currentCwd": "/Users/.../portfolio",
  "sessionsByCwd": {
    "/Users/.../portfolio": "kiro-sess-aaa",
    "/Users/.../agenzo":    "kiro-sess-bbb"
  },
  "idleTimeoutMinutes": null
}
```

也就是说：

1. **切目录不丢上下文** — 你 `/cd ~/Projects/agenzo` 之后，portfolio 那条 Kiro session 还在；切回去自动续聊。
2. **每个 (chat, cwd) 独立 session** — 不同群、不同目录之间不会串话。
3. **命名工作区**只是绝对路径的别名 — `/ws save brand → /Users/.../personal-brand-agent` 之后 `/ws use brand` 等同于 `/cd /Users/.../personal-brand-agent`。
4. **per-chat watchdog 覆盖** — `/timeout 10` 只影响当前 chat,不影响其他 chat 和全局默认。

## 数据目录

| 路径 | 内容 |
|------|------|
| `~/.lark-kiro-bridge/config.json` | 凭证 + 配置（mode 0600） |
| `~/.lark-kiro-bridge/sessions.json` | 每个 chat 的 cwd + (cwd → kiroSessionId) + per-chat watchdog 覆盖 |
| `~/.lark-kiro-bridge/workspaces.json` | 命名工作区映射 |
| `~/.lark-kiro-bridge/processes.json` | 当前运行的 bridge 实例注册表（启动时检测同 app 多实例） |
| `~/.lark-kiro-bridge/media/<chatId>/` | 飞书发来的图片 / 文件，24h 后自动清理 |
| `~/.lark-kiro-bridge/logs/YYYY-MM-DD.log` | NDJSON 结构化日志，超过 `logRetentionDays`（默认 7 天）启动时清理 |
| `~/.lark-kiro-bridge/logs/daemon-{stdout,stderr}.log` | launchd 输出 |

## 访问控制（团队推广用）

默认全开（`allowedUsers/allowedChats/admins` 都为空）。一个人用足够，团队推广前先收紧：

```json
"access": {
  "allowedUsers": ["ou_xxxxxxxxxxxxx"],
  "allowedChats": ["oc_xxxxxxxxxxxxx"],
  "admins":       ["ou_xxxxxxxxxxxxx"]
}
```

- **allowedUsers** 为空 = 所有用户允许；非空 = 仅列出的允许
- **allowedChats** 同理；DMs 不受群白名单约束
- **admins** 为空 = 所有用户都是管理员；非空 = 仅列出的能跑 `/cd` `/ws save/use/remove` `/reconnect` `/doctor`

找 `open_id` / `chat_id` 最快的办法：让目标用户私聊一句机器人，然后看日志：

```bash
grep '"chatId"' ~/.lark-kiro-bridge/logs/$(date +%Y-%m-%d).log | tail -3
```

## 故障排查

**机器人不响应**

1. 看日志：`tail -f ~/.lark-kiro-bridge/logs/$(date +%Y-%m-%d).log`
2. 检查飞书后台：应用是否上线、长连接事件订阅是否包含 `im.message.receive_v1`
3. 用 `/status` 测试单聊：私聊机器人发 `/status`，应该立即出卡片
4. 群里只 `@bot` 才回复，不 @ 是设计行为
5. 同一个 app 跑了两个 bridge 进程时事件会随机分发：检查 `~/.lark-kiro-bridge/processes.json`

**卡片不更新（始终停在"⏳ 思考中"）**

- Kiro CLI 卡住了。`idleTimeoutMinutes` 默认 5 分钟会自动 kill；想立刻解决：`/stop` 或 `/timeout 1`
- 自查：在终端跑 `kiro-cli chat --no-interactive --trust-all-tools "hi"`，应当 5–10 秒内返回

**`/cd` 报"路径不在白名单"**

把目标根加到 `workspace.allowedRoots`，重启 `lark-kiro-bridge service restart` 或前台进程 Ctrl+C 重跑。

**Kiro 改错了项目**

`/status` 看 cwd 是不是你以为的；`/cd <正确目录>` 切过去再问。

## 项目结构

```
lark-kiro-bridge/
├── src/
│   ├── lib/                # 基础设施：路径、日志、配置、debounce、安全
│   ├── store/              # JSON 持久化（带文件锁）
│   ├── lark/               # 飞书 SDK 封装（事件长连接 + OpenAPI + 媒体下载 + 卡片回调）
│   ├── kiro/               # spawn kiro-cli + 流式 stdout 解析 + 输出过滤 + 模型查询
│   ├── card/               # 飞书卡片 v2 schema + 流式渲染器 + 业务卡片 builders
│   ├── commands/           # 斜杠命令解析 + help
│   ├── core/               # ChatPipeline + Dispatcher + bootstrap
│   ├── daemon/             # launchd plist 管理 + 进程注册表
│   ├── cli.ts              # commander 入口
│   └── index.ts            # 库导出
├── bin/
│   └── lark-kiro-bridge.mjs
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── README.md
```

## 路线图

- v0.2：Kiro `--verbose` 输出解析,在卡片里展示工具调用过程
- v0.3：Linux systemd 守护、Windows Task Scheduler
- v0.3：扫码绑定飞书应用（PersonalAgent 类型），免去手填 App ID/Secret
- v0.3：群名 → 工作区的启发式默认（进 agenzo 群默认在 agenzo 目录）
- v0.4：飞书内 `/config` 表单管理 access policy，无需手编 JSON
- v1.0：服务器集中部署模式、多用户隔离、Web 管理面板

## License

MIT

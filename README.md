# lark-kiro-bridge

> 把 **Kiro CLI** 接到飞书 / Lark — 在飞书里聊代码、跑命令、操作飞书自己。

[![npm version](https://img.shields.io/npm/v/lark-kiro-bridge.svg?color=cb3837)](https://www.npmjs.com/package/lark-kiro-bridge)
[![npm downloads](https://img.shields.io/npm/dm/lark-kiro-bridge.svg)](https://www.npmjs.com/package/lark-kiro-bridge)
[![license](https://img.shields.io/npm/l/lark-kiro-bridge.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/lark-kiro-bridge.svg)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/walterwang0x01/lark-kiro-bridge?style=social)](https://github.com/walterwang0x01/lark-kiro-bridge)

🇨🇳 中文 | [🇺🇸 English](./README.en.md)

---

群里 `@bot` 或私聊机器人，消息直达本地 `kiro-cli chat`，回复以**结构化卡片 + 流式打字光标**实时刷新。每个 chat 独立 session，切目录不丢上下文。

**核心价值**：云端 AI 编程助手（Cursor / Copilot / Devin）碰不到你本机的项目目录，也没有飞书 API 调度能力。lark-kiro-bridge **=** 在飞书里跑本地命令 **+** 操作飞书自己，一个机器人解决两件事。

```
┌───────────────────────────────────────┐
│ 💬 Kiro                                │
├───────────────────────────────────────┤
│ ☕ 3 个工具调用 ▸ (folded)             │
│ ✅ Bash — lark-cli calendar +create…▾ │  ← 最新工具实时展开
│ ┌─────────────────────────────────┐   │
│ │ **Command** lark-cli calendar … │   │
│ │ **Output** {"ok": true, ...}    │   │
│ └─────────────────────────────────┘   │
│                                        │
│ 日程已创建成功 ✅                      │
│ 主题：测试                             │
│ 时间：今天 23:00 ~ 明天 00:00          │
│                                        │
│ ✍️ 正在输出     [ ⏹ 终止 ]            │
└───────────────────────────────────────┘
```

## 目录

<details>
<summary>展开</summary>

- [✨ 特性](#-特性)
- [🚀 快速上手](#-快速上手)
- [📖 飞书内的命令](#-飞书内的命令)
- [💡 使用场景](#-使用场景)
- [⚙️ 配置](#️-配置)
- [📚 进阶文档](#-进阶文档)
- [🤝 参与贡献](#-参与贡献)
- [📄 License](#-license)

</details>

## ✨ 特性

- 🎴 **结构化卡片** — 每次工具调用一个独立可折叠面板，多调用自动聚合，思考过程独立展示
- ⚡ **流式打字光标** — 飞书原生 `streaming_mode`，配合 footer 实时状态指示
- 🗂️ **工作区方案 B** — 切目录不丢上下文：每个 `(chat, cwd)` 独立 Kiro session，自动续聊
- 🔘 **按钮可点** — `/model` `/help` `/status` `/ws list` 全部可点击操作，0 命令记忆
- 🛡️ **进程组 kill** — `detached: true` + `process.kill(-pid)` 杀掉 kiro-cli 全部子孙
- ⏱ **Idle Watchdog** — 卡住自动 killTree，可全局 / per-chat 配置
- 🔐 **三层访问控制** — 用户 / 群 / 管理员白名单
- 🍎 **macOS 原生守护** — launchd 崩溃自动拉起，开机自启
- 📊 **`/doctor` 自诊断** — 让 Kiro 看日志自己分析故障

## 🚀 快速上手

### 前置条件

- macOS（Linux / Windows daemon 在路线图）
- Node.js ≥ 20
- `kiro-cli` 已安装并登录
- 飞书企业自建应用 → 启用机器人能力 → 订阅 `im.message.receive_v1` + `card.action.trigger`（长连接模式）

### 3 步上线

```bash
# 1. 安装
npm i -g lark-kiro-bridge

# 2. 配飞书凭证
lark-kiro-bridge init

# 3. 启动后台守护
lark-kiro-bridge start
```

启动后在飞书私聊机器人发「你好」，应该立即看到流式刷新的卡片。

> 飞书后台具体配置 → [docs/FAQ.md#机器人不响应](./docs/FAQ.md)

## 📖 飞书内的命令

### 日常命令（所有人）

| 命令 | 别名 | 作用 |
|---|---|---|
| `/help` | `/h` `/?` | 帮助卡片（可点按钮） |
| `/status` | `/s` | 当前 cwd / session / watchdog |
| `/model [name]` | `/m` | 查看 / 切换模型，按钮一键切 |
| `/new` | `/reset` | 重置当前 cwd 下的 Kiro 会话 |
| `/stop` | `/abort` | 停止正在跑的任务 |
| `/pwd` | `/cwd` | 当前工作目录 |
| `/ws list` | — | 列出命名工作区，按钮一键切 |
| `/timeout [N\|off]` | `/to` | idle watchdog 阈值（分钟） |
| `/doctor [描述]` | — | 让 Kiro 看日志自诊断 |

### 管理员命令

| 命令 | 作用 |
|---|---|
| `/cd <path>` | 切换工作目录（受 `allowedRoots` 限制） |
| `/ws save <name>` | 把当前 cwd 存为命名工作区 |
| `/ws use <name>` | 切到命名工作区 |
| `/ws remove <name>` | 删除命名工作区 |
| `/reconnect` | 强制重连飞书 WebSocket |

> 默认所有人都是管理员（`access.admins` 为空）。团队推广前请收紧。

**响应规则**：私聊全收；群里必须 `@bot`；`@all` 永不响应。

## 💡 使用场景

```
你: 删掉今天 23 点的会议
🤖 调 lark-cli calendar +agenda 找到日程 → 二次确认 → +delete

你: 整理一下上周的会议纪要发到产品群
🤖 lark-cli vc +list → 提取纪要 → 调 lark-cli message +send 到指定群

你: 把 portfolio 项目今天的改动 commit 一下
🤖 cd portfolio → git diff → 拆分 atomic commits → git push

你: 查一下张三的 open_id 顺便给他发个会议邀请
🤖 lark-cli contact +find 张三 → 拿到 open_id → 调 lark-cli calendar +create

你: [发了一张设计稿] 帮我评估技术可行性
🤖 自动下载图片 → @file 喂给 Kiro → 视觉分析 + 给出实现方案
```

## ⚙️ 配置

### 最小可用（自动生成）

`lark-kiro-bridge init` 写入 `~/.lark-kiro-bridge/config.json`：

```json
{
  "lark": {
    "appId": "cli_xxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxx"
  }
}
```

其他字段都有合理默认值。

### 完整配置参考

<details>
<summary>点开看所有可配置项</summary>

```json
{
  "lark": {
    "appId": "cli_xxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxx"
  },
  "kiro": {
    "binPath": "kiro-cli",
    "trustedTools": [
      "fs_read", "fs_write", "grep", "glob", "code",
      "execute_bash", "web_search", "web_fetch"
    ],
    "timeoutMs": 600000,
    "idleTimeoutMinutes": 5,
    "model": "claude-sonnet-4.6"
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

`trustedTools` — Kiro 不询问就能调用的工具：
- `fs_read fs_write grep glob code` — 文件读写、代码搜索
- `execute_bash` — 跑 shell 命令（lark-cli / git / 等）。**单人用安全；团队场景请评估**
- `web_search web_fetch` — 联网搜资料

`access` — 三层白名单，详见 [SECURITY.md](./SECURITY.md)：
- `allowedUsers` 为空 = 所有人允许
- `allowedChats` 为空 = 所有 chat 允许
- `admins` 为空 = 所有人都是管理员

`workspace.allowedRoots` — `/cd` 能去的根目录白名单，限制爆炸半径。

</details>

### CLI

```bash
lark-kiro-bridge init                # 首次配置
lark-kiro-bridge run                 # 前台启动（开发用）
lark-kiro-bridge config-show         # 显示当前配置（脱敏）

lark-kiro-bridge start               # 装并起 daemon
lark-kiro-bridge stop                # 停 daemon
lark-kiro-bridge restart             # 重启
lark-kiro-bridge status              # 状态
lark-kiro-bridge unregister          # 卸载

lark-kiro-bridge ps                  # 列本机所有 bridge 进程
lark-kiro-bridge kill <id> [--force] # 杀掉某个进程
```

## 📚 进阶文档

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 整体数据流、卡片渲染体系、工作目录方案 B、设计取舍 |
| [docs/FAQ.md](./docs/FAQ.md) | 常见疑问 + 故障排查（机器人不响应 / 200340 / 卡片卡死 / …） |
| [SECURITY.md](./SECURITY.md) | 安全策略、漏洞披露、加固指南 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更日志 |

## 🤝 参与贡献

PR / Issue 都欢迎。开发流程：

```bash
git clone https://github.com/walterwang0x01/lark-kiro-bridge.git
cd lark-kiro-bridge
pnpm install
pnpm typecheck && pnpm lint && pnpm test    # 提交前必跑
pnpm build
node bin/lark-kiro-bridge.mjs run           # 本地跑（先 stop daemon）
```

代码规范：TypeScript strict / Biome lint / vitest 测试 / commit 用 conventional commits。

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)（规划中）。

## 致谢

设计上参考了：

- **[zara/feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge)** — 同类项目，多处实现思路（卡片设计、daemon、工作目录方案）
- **[Slack Thinking Steps](https://slack.dev/slack-thinking-steps-ai-agents/)** — 工具调用面板的视觉范式

## 路线图

- **v0.2** ✅ 当前版（结构化卡片 + 按钮回调 + Slack-style 工具面板）
- **v0.3** Linux systemd / Windows Task Scheduler 守护
- **v0.3** 扫码绑定飞书应用，免去手填 App ID/Secret
- **v0.4** 飞书内 `/config` 表单管理 access policy
- **v0.4** 语音输入（飞书 ASR）
- **v1.0** 服务器集中部署 / 多用户隔离 / Web 管理面板

## 📄 License

[MIT](./LICENSE) © 2026 walterwang0x01

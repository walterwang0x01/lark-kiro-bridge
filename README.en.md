# lark-kiro-bridge

> Bridge **Kiro CLI** to Feishu / Lark — chat code, run commands, and operate Feishu itself.

[![npm version](https://img.shields.io/npm/v/lark-kiro-bridge.svg?color=cb3837)](https://www.npmjs.com/package/lark-kiro-bridge)
[![npm downloads](https://img.shields.io/npm/dm/lark-kiro-bridge.svg)](https://www.npmjs.com/package/lark-kiro-bridge)
[![license](https://img.shields.io/npm/l/lark-kiro-bridge.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/lark-kiro-bridge.svg)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/walterwang0x01/lark-kiro-bridge?style=social)](https://github.com/walterwang0x01/lark-kiro-bridge)

[🇨🇳 中文](./README.md) | 🇺🇸 English

---

`@bot` in a group chat or DM the bot directly. Your message goes straight to local `kiro-cli chat`. Replies stream back as **structured cards with native typing cursor**. Each chat keeps an isolated session, and switching directories doesn't lose context.

**Why this exists**: cloud AI coding assistants (Cursor / Copilot / Devin) can't touch your local project directories, and have no way to operate Feishu's own APIs. lark-kiro-bridge **=** running local commands inside Feishu **+** orchestrating Feishu APIs from chat — one bot for both.

```
┌───────────────────────────────────────┐
│ 💬 Kiro                                │
├───────────────────────────────────────┤
│ ☕ 3 tool calls ▸ (folded)             │
│ ✅ Bash — lark-cli calendar +create…▾ │  ← latest tool stays expanded
│ ┌─────────────────────────────────┐   │
│ │ **Command** lark-cli calendar … │   │
│ │ **Output** {"ok": true, ...}    │   │
│ └─────────────────────────────────┘   │
│                                        │
│ Calendar event created ✅              │
│ Title: Test                            │
│ When:  Today 23:00 ~ 00:00 (1h)        │
│                                        │
│ ✍️ Streaming     [ ⏹ Stop ]           │
└───────────────────────────────────────┘
```

## Table of Contents

<details>
<summary>Expand</summary>

- [✨ Features](#-features)
- [🚀 Quick Start](#-quick-start)
- [📖 Slash Commands](#-slash-commands)
- [💡 Use Cases](#-use-cases)
- [⚙️ Configuration](#️-configuration)
- [📚 Documentation](#-documentation)
- [🤝 Contributing](#-contributing)
- [📄 License](#-license)

</details>

## ✨ Features

- 🎴 **Structured cards** — Each tool call gets its own collapsible panel; multi-call groups auto-condense; reasoning gets its own panel
- ⚡ **Streaming typing cursor** — Native Feishu `streaming_mode` + footer status indicator
- 🗂️ **Workspace plan B** — `/cd` doesn't drop context: per-`(chat, cwd)` Kiro session map auto-resumes
- 🔘 **Clickable buttons** — `/model` `/help` `/status` `/ws list` are all interactive cards, zero command memorization
- 🛡️ **Process group kill** — `detached: true` + `process.kill(-pid)` reaches kiro-cli's grandchildren
- ⏱ **Idle watchdog** — Stuck process auto-killed; tunable globally and per-chat
- 🔐 **Three-tier access control** — User / chat / admin allowlists
- 🍎 **macOS native daemon** — launchd auto-restart on crash, login auto-start
- 📊 **`/doctor` self-diagnosis** — Feed logs back to Kiro to analyze its own failures

## 🚀 Quick Start

### Prerequisites

- macOS (Linux / Windows daemon on roadmap)
- Node.js ≥ 20
- `kiro-cli` installed and logged in
- A Feishu / Lark custom app — bot enabled, subscribed to `im.message.receive_v1` and `card.action.trigger` (long-connection mode)

### 3 Steps

```bash
# 1. Install
npm i -g lark-kiro-bridge

# 2. Configure Feishu credentials
lark-kiro-bridge init

# 3. Start the background daemon
lark-kiro-bridge start
```

DM the bot "hi" — you should see a streaming card immediately.

> Detailed Feishu console setup → [docs/FAQ.md](./docs/FAQ.md) (Chinese)

## 📖 Slash Commands

### Daily commands (everyone)

| Command | Aliases | Purpose |
|---|---|---|
| `/help` | `/h` `/?` | Help card with action buttons |
| `/status` | `/s` | Current cwd / session / watchdog |
| `/model [name]` | `/m` | View / switch / reset model with one click |
| `/new` | `/reset` | Reset Kiro session for current cwd |
| `/stop` | `/abort` | Abort the running task |
| `/pwd` | `/cwd` | Current working directory |
| `/ws list` | — | List named workspaces with switch buttons |
| `/timeout [N\|off]` | `/to` | Idle watchdog threshold (minutes) |
| `/doctor [desc]` | — | Let Kiro inspect logs and diagnose |

### Admin commands

| Command | Purpose |
|---|---|
| `/cd <path>` | Switch working directory (gated by `allowedRoots`) |
| `/ws save <name>` | Save current cwd as a named workspace |
| `/ws use <name>` | Switch to a named workspace |
| `/ws remove <name>` | Delete a named workspace |
| `/reconnect` | Force reconnect Feishu WebSocket |

> By default everyone is admin (`access.admins` empty). Tighten before sharing with a team.

**Trigger rules**: DMs respond to anything; group chats require `@bot`; `@all` is never answered.

## 💡 Use Cases

```
You: Delete today's 23:00 meeting
🤖  Calls lark-cli calendar +agenda → finds event → confirms → +delete

You: Summarize last week's meetings and post to the product channel
🤖  lark-cli vc +list → extracts notes → lark-cli message +send to channel

You: Commit today's changes in the portfolio project
🤖  cd portfolio → git diff → splits into atomic commits → git push

You: Find Alice's open_id and send her a meeting invite
🤖  lark-cli contact +find Alice → gets open_id → lark-cli calendar +create

You: [drops a design mockup image] evaluate technical feasibility
🤖  Auto-downloads image → @file feeds to Kiro → vision analysis + plan
```

## ⚙️ Configuration

### Minimum (auto-generated)

`lark-kiro-bridge init` writes `~/.lark-kiro-bridge/config.json`:

```json
{
  "lark": {
    "appId": "cli_xxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxx"
  }
}
```

All other fields have sensible defaults.

### Full reference

<details>
<summary>Click to expand all configurable fields</summary>

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

**`trustedTools`** — Tools Kiro can invoke without asking:
- `fs_read fs_write grep glob code` — File and code operations
- `execute_bash` — Run shell commands (lark-cli / git / etc). **Safe for personal use; evaluate for team scenarios**
- `web_search web_fetch` — Internet search

**`access`** — Three-tier allowlists, see [SECURITY.md](./SECURITY.md):
- Empty `allowedUsers` = everyone allowed
- Empty `allowedChats` = every chat allowed
- Empty `admins` = everyone is admin

**`workspace.allowedRoots`** — Whitelist of directories `/cd` can reach. Limits blast radius.

</details>

### CLI

```bash
lark-kiro-bridge init                # First-time setup
lark-kiro-bridge run                 # Foreground (dev)
lark-kiro-bridge config-show         # Show current config (redacted)

lark-kiro-bridge start               # Install and start daemon
lark-kiro-bridge stop                # Stop daemon
lark-kiro-bridge restart             # Restart
lark-kiro-bridge status              # Daemon status
lark-kiro-bridge unregister          # Uninstall

lark-kiro-bridge ps                  # List all bridge processes on this host
lark-kiro-bridge kill <id> [--force] # Kill a process
```

## 📚 Documentation

| Doc | Content |
|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Data flow, card rendering, workspace plan B, design trade-offs |
| [docs/FAQ.md](./docs/FAQ.md) | Common questions + troubleshooting |
| [SECURITY.md](./SECURITY.md) | Security policy, vulnerability disclosure, hardening |
| [CHANGELOG.md](./CHANGELOG.md) | Release notes |

> Most docs are in Chinese; English versions are on the roadmap. PRs welcome.

## 🤝 Contributing

PRs and issues welcome. Dev flow:

```bash
git clone https://github.com/walterwang0x01/lark-kiro-bridge.git
cd lark-kiro-bridge
pnpm install
pnpm typecheck && pnpm lint && pnpm test    # required before commit
pnpm build
node bin/lark-kiro-bridge.mjs run           # local run (stop daemon first)
```

Conventions: TypeScript strict / Biome lint / vitest tests / conventional commits.

## Acknowledgments

Design inspired by:

- **[zara/feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge)** — Sibling project for Claude Code; multiple implementation references (card design, daemon, workspace plan)
- **[Slack Thinking Steps](https://slack.dev/slack-thinking-steps-ai-agents/)** — Tool-call panel visual paradigm

## Roadmap

- **v0.2** ✅ Current (structured cards + button callbacks + Slack-style tool panels)
- **v0.3** Linux systemd / Windows Task Scheduler daemon
- **v0.3** QR-code Feishu app binding (no manual App ID/Secret)
- **v0.4** In-Feishu `/config` form for access policy
- **v0.4** Voice input via Feishu ASR
- **v1.0** Centralized server deployment / multi-user isolation / web admin panel

## 📄 License

[MIT](./LICENSE) © 2026 walterwang0x01

# 架构与设计

深入理解 lark-kiro-bridge 内部如何工作。普通用户**不需要看这份**，README 已经覆盖日常使用；这份是给想读源码、贡献代码、或在生产环境调优的人看的。

## 整体数据流

```
┌──────────┐                        ┌─────────┐                    ┌───────────┐
│   飞书   │  ① WebSocket 长连接    │ bridge  │  ③ spawn 子进程    │ kiro-cli  │
│ (Lark)   │ ─────────────────────► │ daemon  │ ─────────────────► │  chat     │
│          │ ◄───────────────────── │         │ ◄───────────────── │           │
└──────────┘  ⑤ 流式 patchCard      └─────────┘  ④ stdout 流       └───────────┘
                                         │
                              ② OpenAPI HTTPS │
                                         ▼
                                  ┌──────────┐
                                  │ 飞书 API │
                                  │ (open)   │
                                  └──────────┘
```

1. **入站事件**：飞书 → WebSocket 长连接（`im.message.receive_v1` + `card.action.trigger`）→ bridge `dispatcher`
2. **OpenAPI**：bridge → 飞书 HTTPS（发卡片、patch 卡片、下载图片资源、查机器人 open_id）
3. **spawn kiro-cli**：bridge 用 execa spawn 子进程，参数有 `--no-interactive --resume-id <sid> --trust-tools=...`
4. **stdout 流**：kiro-cli 输出（trace + 真正回复 + 工具裸输出）→ bridge 解析成 RunState
5. **流式 patchCard**：每次 RunState 变更 → 节流（800ms 默认）→ patch 飞书卡片

## 卡片渲染体系

参考自 [zara/feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge) + [Slack Thinking Steps](https://slack.dev/slack-thinking-steps-ai-agents/) 设计。

### 数据模型 RunState

每次 Kiro 任务一个对象，模型见 `src/kiro/runState.ts`：

```ts
interface RunState {
  blocks: Block[];        // 时序排列的 [文本块 | 工具调用块]
  reasoning: { content: string; active: boolean };
  terminal: 'running' | 'done' | 'error' | 'interrupted' | 'idle_timeout';
  errorMsg?: string;
  footer: 'thinking' | 'tool_running' | 'streaming' | null;
}

interface ToolEntry {
  id: string;             // 稳定 id（用于飞书 panel key）
  name: string;           // 'Read' / 'Bash' / 'Grep' / ...
  input: Record<string, unknown>;
  output?: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
}
```

### stdout 状态机解析

`src/kiro/runStreamParser.ts` 用两态机：`normal` ↔ `in-tool`。

kiro-cli stdout 形如：
```
Reading file: /path/x.md, all lines (using tool: read)
✓ Successfully read 6519 bytes from /path/x.md
- Completed in 0.0s

I will run the following command: lark-cli ... (using tool: shell)
Purpose: ...
<命令的裸 stdout，可能是大段 JSON>
- Completed in 0.6s

> 真正的 LLM 回复

 ▸ Credits: 0.12 • Time: 9s
```

解析规则：
- `Reading file: …` `I will run …` 等行 → 创建 ToolEntry，进 `in-tool` 状态
- `in-tool` 状态下所有行 → 累积到当前 tool 的 `output`
- `- Completed in …` → 当前 tool 标记为 done，回 `normal`
- `> ...` → 去前缀加到 text block
- `✓ Successfully` `Purpose:` `▸ Credits` → 静默丢弃

### 渲染策略

`src/card/runRenderer.ts` 按 RunState 渲染飞书 v2 卡片：

| 工具数 | 任务状态 | 渲染策略 |
|---|---|---|
| `< 3` | 任意 | 每个工具独立 collapsible_panel |
| `≥ 3` | running | 前面折叠成「☕ N 个工具调用」总结，最新一个完整展开 |
| `≥ 3` | finalized | 全部折叠成总结 |

视觉细节：
- **每个工具一个 collapsible_panel**，header 显示 `✅ Read — ~/path/to/file.md`
- 工具 input 按工具类型智能渲染（Bash 用 `**Command** ```bash ...````、Read 用 `**File** \`~/path\``、Grep 用 `**Pattern** \`xxx\` **Path** \`...\``）
- 错误工具：`border.color: 'red'`
- 思考过程：单独 panel，进行中默认展开
- 进行中状态：`config.streaming_mode: true`（飞书显示原生打字光标）+ `config.summary.content`（通知列表显示「正在调用工具」）
- 进行中底部：footer status（🧠/🧰/✍️）+ `⏹ 终止` 按钮

### 大小限制

防止超过飞书单 element 30KB 上限：

| 范围 | 上限 |
|---|---|
| 单个工具 header summary | 80 字符 |
| 单个 input 字段 | 600 字符 |
| 单个工具 output | 1200 字符 |
| 单个工具 body 总长 | 2500 字符 |

超出后截断，附「完整内容查 `/doctor` 或日志」。

## 工作目录方案 B

每个飞书 chat 维护一个 `(cwd → kiroSessionId)` 映射，**切目录不丢上下文**。

### 数据结构

`~/.lark-kiro-bridge/sessions.json`:

```json
{
  "version": 1,
  "chats": {
    "oc_xxxxx": {
      "currentCwd": "/Users/.../portfolio",
      "sessionsByCwd": {
        "/Users/.../portfolio": "kiro-sess-aaa",
        "/Users/.../agenzo":    "kiro-sess-bbb"
      },
      "lastActiveAt": 1779543920519,
      "idleTimeoutMinutes": null
    }
  }
}
```

### 行为

1. **切目录不丢上下文**：你 `/cd ~/Projects/agenzo` 后，portfolio 那条 Kiro session 还在；切回去自动续聊（`--resume-id kiro-sess-aaa`）
2. **每个 (chat, cwd) 独立 session**：不同群、不同目录之间不会串话
3. **命名工作区只是别名**：`/ws save brand → /Users/.../personal-brand-agent`，之后 `/ws use brand` 等同于 `/cd /Users/.../personal-brand-agent`
4. **per-chat watchdog 覆盖**：`/timeout 10` 只影响当前 chat

### 文件锁

`src/store/sessions.ts` 用 `proper-lockfile` 保证多进程并发写不损坏文件——理论上你不会同时跑两个 daemon，但万一有（比如同 app 双实例），数据安全。

## 进程管理

### 进程组 kill

kiro-cli 实际是个壳，会 fork 出 `kiro-cli-chat → bun tui.js → acp` 多层子孙进程。普通 `child.kill()` 只杀直接子进程，孙子进程会变孤儿。

`src/kiro/runner.ts` 的解法：
```ts
execa(binPath, args, {
  detached: true,  // 让 kiro-cli 自成独立 process group
  ...
});

// kill 时给整个 group 发信号
process.kill(-pid, 'SIGTERM');
setTimeout(() => process.kill(-pid, 'SIGKILL'), 2000);
```

### Idle Watchdog

每 30 秒检查 `Date.now() - lastChunkAt`，超过阈值则 killTree。

阈值优先级：per-chat 覆盖（`/timeout 10`） > 全局 `kiro.idleTimeoutMinutes` > 0（关闭）

### 多实例检测

`~/.lark-kiro-bridge/processes.json` 注册当前进程。启动时扫描同 appId 的存活进程，发现重复 → 警告（不阻断启动，但用户应手动 `kill` 多余的）。

为啥重要：飞书 WS 同 app 两个连接时事件**随机路由**，会出现"机器人有时回复有时不回复"。

## 命令型卡片回调

`/model`、`/help`、`/status`、`/ws list` 卡片上的按钮走 `card.action.trigger` 事件。

### 流程

1. 用户点按钮 → 飞书推送 `card.action.trigger` 事件 → bridge `dispatcher.handleCardAction`
2. 按钮 value 字段约定：`{ action: 'model.set', name: 'claude-sonnet-4.6' }`
3. 路由到对应 handler，admin 写操作走 admin 校验
4. 执行后发新卡片回执（`✅ 模型已切换`）

### Action 清单

| action | 写操作？admin? | 说明 |
|---|---|---|
| `model.show` | 否 | 重发 model picker |
| `model.set` | **是** | 切模型 + 写 config.json |
| `model.reset` | **是** | 清模型覆盖 |
| `model.refresh` | 否 | 清缓存重新查 |
| `session.new` | **是** | 重置当前 chat 会话 |
| `session.stop` | 否 | 中止当前任务 |
| `session.status` | 否 | 重发 status 卡片 |
| `ws.list` | 否 | 重发 ws-list 卡片 |
| `ws.use` | **是** | 切换工作区 |

## 项目目录

```
src/
├── lib/                       # 基础设施
│   ├── paths.ts               # 数据目录路径常量
│   ├── logger.ts              # pino 结构化日志 + 启动清理
│   ├── config.ts              # zod schema + 加载 + 原子保存
│   ├── debounce.ts            # 流式更新节流
│   └── security.ts            # cwd 白名单 + admin 校验
├── store/                     # JSON 持久化（带文件锁）
│   ├── sessions.ts            # ChatSession × KiroSession 映射
│   └── workspaces.ts          # 命名工作区映射
├── lark/                      # 飞书 SDK 封装
│   ├── client.ts              # WS 长连接 + OpenAPI
│   ├── cardAction.ts          # card.action.trigger 事件解析
│   ├── media.ts               # 图片/文件下载 + 24h 清理
│   ├── parse.ts               # 消息事件解析
│   └── types.ts               # 业务层类型
├── kiro/                      # spawn kiro-cli + 流解析 + 模型
│   ├── runner.ts              # 子进程封装（detached + killTree + watchdog）
│   ├── runState.ts            # 结构化运行状态（blocks/tools/reasoning）
│   ├── runStreamParser.ts     # stdout 状态机解析器
│   └── models.ts              # /model 列表查询 + 5 分钟缓存
├── card/                      # 飞书卡片 v2 渲染
│   ├── runRenderer.ts         # RunState → 卡片 JSON
│   ├── runCardController.ts   # 一次任务的卡片生命周期
│   ├── toolRender.ts          # 单工具 header/body 渲染
│   ├── builders.ts            # 命令型卡片（/model /help /status /ws）
│   ├── schema.ts              # 旧版 simple done 卡片（保留兼容）
│   └── renderer.ts            # 旧版 CardRenderer（保留兼容）
├── commands/                  # 斜杠命令解析
│   ├── parse.ts               # 命令解析器（typo 容错）
│   └── help.ts                # /help 文本（已被 builders.ts 替代）
├── core/                      # 核心调度
│   ├── pipeline.ts            # ChatPipeline（per-chat 串行 + preempt）
│   ├── dispatcher.ts          # 总分发器
│   └── bootstrap.ts           # 启动装配
├── daemon/                    # macOS launchd
│   ├── launchd.ts             # plist 安装 / start / stop
│   └── registry.ts            # 进程注册表
├── cli.ts                     # commander CLI 入口
└── index.ts                   # 库导出（程序化嵌入用）
```

## 设计取舍记录

### 为啥 cwd 不存到 kiro-cli 的 session 里

kiro-cli 自己的 session 是按 cwd 启动的（`kiro-cli chat --resume-id` 必须在原 cwd 跑）。我们额外在 sessions.json 维护 `(chatId, cwd) → sid` 映射，**目的是让用户在飞书里 `/cd` 切目录时不丢上下文**——切回原目录能直接 resume，不需要再次设置 prompt。

### 为啥不用 webhook 模式

WS 长连接：
- 不需要公网 IP
- 不需要域名 / HTTPS 证书
- 飞书侧负责重连
- 适合本机 / 内网部署

webhook 适合云上部署多实例集群——这不是 lark-kiro-bridge 的目标场景。

### 为啥每个 chat 串行而不是并发

- LLM 模型对话上下文是有时序的——用户发 1、2、3 三条消息，期望 LLM 按顺序回（而不是 3 先回 1 后回）
- 同 chat 跑两个 kiro-cli 子进程会争抢 session 资源，容易乱
- ChatPipeline 设计：新消息 abort 旧任务（preempt），保证最新意图最先响应

### 为啥不用 vercel ai sdk / langchain

我们不在 bridge 层做 LLM 编排——这是 kiro-cli 的工作。bridge 只做"消息转发 + 卡片渲染"，保持极简，复杂的工具调用 / agent loop 全交给 kiro-cli 处理。

## 参考资料

- [飞书卡片 JSON 2.0](https://open.feishu.cn/document/feishu-cards/feishu-card-overview)
- [飞书卡片回传交互](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks)
- [Slack Thinking Steps（卡片设计参考）](https://slack.dev/slack-thinking-steps-ai-agents/)
- [zara/feishu-claude-code-bridge（同类项目，多处实现参考）](https://github.com/zarazhangrui/feishu-claude-code-bridge)

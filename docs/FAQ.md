# FAQ & 故障排查

## FAQ — 用之前你可能想问的

### Q: 跟 zara/feishu-claude-code-bridge 有啥区别

zara 是接 **Claude Code** 的，本项目接 **Kiro CLI**。架构思路上有借鉴（卡片设计、工作目录方案、daemon），但代码独立实现。

如果你已经在用 Claude Code，用 zara；如果你用 Kiro CLI（特别是想用其内置的 lark-* 技能集操作飞书自己），用本项目。

### Q: 我没有飞书企业账号，免费版能用吗

**大部分功能可以**，少数功能受限：

| 功能 | 免费版 |
|---|---|
| 文本消息收发 | ✅ |
| 长连接事件 | ✅ |
| 消息卡片 | ✅ |
| 图片 / 文件下载 | ✅ |
| 卡片回调按钮 | ✅ |
| 语音 ASR | ❌（需付费 scope） |

### Q: 为啥不用云端 AI（Cursor / Copilot / Devin）

云端 AI 编程助手有两个本项目能解决的痛点：

1. **碰不到你本机的项目目录**——你不可能把所有私密 repo 都丢上云
2. **没有飞书 API 调度能力**——没法直接帮你删日程、查邮件、改文档

lark-kiro-bridge + kiro-cli + lark-* 技能集 = 在飞书里跑本地命令 + 操作飞书 API 的统一入口。

### Q: 安全吗？把 shell 工具开了不会被滥用？

默认 `trustedTools` **没开** `execute_bash`。打开后：
- **单人本机用**：风险 = 你自己会让 bot 跑啥命令。理论上有 prompt injection 风险（用户图片里嵌指令骗 bot 跑命令），但日常使用极少触发
- **团队场景**：必须收紧 `access.admins` + `workspace.allowedRoots`，并考虑去掉 `execute_bash`

详细安全配置见 [SECURITY.md](../SECURITY.md)。

### Q: kiro-cli 每次跑都重新 login？

`kiro-cli` 的认证 state 在 `~/.kiro/`，bridge 不动它。一次 login 就行，后续 spawn 共用。

### Q: 切换模型后立刻生效吗

`/model claude-sonnet-4.6` 写到 config.json，**下一条消息生效**。不影响正在跑的任务。

### Q: 一台机器能跑多个 bridge 吗

**不能跑同 appId 的多个**——飞书 WS 同 app 只允许一个连接 ack 事件，多了事件会被随机分发，机器人有时回有时不回。`processes.json` 注册表会检测出来。

可以跑**不同 appId** 的多个（比如个人 app + 团队 app），互不干扰。

### Q: idleTimeoutMinutes 应该设多少

经验值：
- **5 分钟**（默认）— Kiro 大部分任务都能完成
- **10 分钟** — 跑大型 refactor / 长 web search 时可能要长，调高
- **0**（关闭）— 不推荐，万一 kiro-cli 真卡住会一直占着

per-chat：在飞书发 `/timeout 10` 临时调

### Q: 卡片显示的内容有 30KB 上限会怎样

bridge 自动截断到 2.5KB/工具，超过部分提示「完整内容查 `/doctor` 或日志」。日志在 `~/.lark-kiro-bridge/logs/YYYY-MM-DD.log` 永远完整。

---

## 故障排查

### 机器人不响应

按这个顺序排查：

1. **看日志**
   ```bash
   tail -f ~/.lark-kiro-bridge/logs/$(date +%Y-%m-%d).log
   ```

2. **检查飞书后台**
   - 应用是否上线
   - 「事件配置」订阅了 `im.message.receive_v1` + 长连接模式

3. **测试单聊 / 命令**
   ```
   私聊机器人发 /status
   ```
   应该立即出卡片。如果出，说明事件链路通；如果不出，日志里应该有线索。

4. **群里只 @bot 才回复**
   设计行为。`requireMentionInGroup: false` 可以关闭。

5. **多实例冲突**
   ```bash
   lark-kiro-bridge ps
   ```
   看一眼有没有多余的进程。多于 1 个用 `lark-kiro-bridge kill <id>` 杀掉。

### 点按钮报「出错了，code: 200340」

飞书后台没订阅卡片回调。

修复：
- 「事件与回调」→「**回调配置**」（不是事件配置！）
- 「添加回调」→ 搜 `card.action.trigger`（中文叫「卡片回传交互」）
- 订阅方式选「**使用长连接接收回调**」
- 保存

立即生效，不用重启 bridge。

### 卡片不更新（停在「⏳ 思考中」）

**原因**：kiro-cli 卡住了。

**自查**：
```bash
kiro-cli chat --no-interactive --trust-all-tools "hi"
```
应当 5–10 秒内返回。如果终端跑也卡，是 kiro-cli 自己的问题（可能没登录、网络挂了）。

**立即恢复**：
- 卡片上点 `⏹ 终止` 按钮
- 或飞书发 `/stop`
- 默认 5 分钟会自动 idle timeout

### `/cd` 报「路径不在白名单」

把目标根加到 `workspace.allowedRoots`，重启：

```bash
lark-kiro-bridge restart
```

### Kiro 改错了项目

最常见原因：bridge 当前 cwd 不是你以为的那个。

```
飞书发 /status   ← 看 cwd 字段
飞书发 /cd ~/正确路径
```

### `/model` 报「无法获取模型列表」

**原因**：daemon 跑的环境 PATH 里没找到 `kiro-cli`。

**确认**：
```bash
which kiro-cli   # 看终端能不能找到
```

**修复**：把绝对路径写到 `config.json` 里：
```json
{
  "kiro": {
    "binPath": "/Users/you/.local/bin/kiro-cli"
  }
}
```

重启 daemon 生效。

### daemon 启动后立刻挂

看 launchd 日志：
```bash
tail ~/.lark-kiro-bridge/logs/daemon-stderr.log
```

常见原因：
- `config.json` 缺字段（zod 校验失败）→ `lark-kiro-bridge config-show` 看看
- `appId/appSecret` 错 → 飞书 SDK 启动时就报 401
- 端口被占（不太可能，bridge 不监听端口）

### 同时开了 dev 模式 + daemon

两个进程抢 WS，事件随机分发。`ps` 看一眼，杀掉手动启的那个：

```bash
lark-kiro-bridge ps
lark-kiro-bridge kill <id>
```

或全部清理后只起 daemon：

```bash
pkill -f 'dist/cli.js run'
sleep 2
lark-kiro-bridge start
```

### 飞书发不出卡片，报 400 / 230099 错误码

通常是卡片 schema 写错了。bridge 偶发可能因为某条 LLM 输出包含特殊字符把 markdown 搞坏。

**临时绕过**：在飞书重发一次同样的问题（多数情况一次成功）。

**根因排查**：
```bash
grep '"err":' ~/.lark-kiro-bridge/logs/$(date +%Y-%m-%d).log | tail -3
```
看具体的飞书 API 报错。

### 想看真实卡片 JSON 是什么

在 dev 模式跑：
```bash
node bin/lark-kiro-bridge.mjs run
```
日志 level 调成 debug 时会打 patchCard 的 payload。或者直接读 `dist/cli.js` 加 `console.log` 临时调试。

---

## 还没解决？

1. 用 **`/doctor [问题描述]`** 让 Kiro 看日志自己分析
2. [GitHub Issues](https://github.com/walterwang0x01/lark-kiro-bridge/issues) 提单（带：bridge 版本 + kiro-cli 版本 + 关键日志片段）
3. 安全相关问题走 [SECURITY.md](../SECURITY.md) 的私密渠道，不要发公开 issue

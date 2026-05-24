# lark-kiro-bridge

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 和
[Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

待发版的改动会先写在这里。

## [0.2.0] — 2026-05-24

### 新增（Added）

- **🆕 扫码创建飞书应用**：`lark-kiro-bridge run` 首次启动自动弹二维码，飞书 App 扫码同意即可完成应用创建 + 凭证写入 + 自动配置必要权限（30 秒上手，无需开发者后台手动操作）
- `init --manual` 选项：保留手动输入已有 App ID/Secret 的方式
- `init --app-id <id> --app-secret <secret>`：一行参数完成配置（CI 场景）
- 扫码用户自动加入 `access.admins` 列表，避免后续敏感命令对所有人开放
- 完整中英双语文档：`README.md` / `README.en.md` / `docs/ARCHITECTURE.md` / `docs/FAQ.md`
- 路线图更新：扫码绑定从 v0.3 提前到 v0.2 完成

### 变更（Changed）

- **结构化卡片重做（参考  + Slack）**：每次工具调用一个独立 `collapsible_panel`，多调用 ≥3 自动折叠成总结，思考过程独立 panel
- 卡片配置 `streaming_mode: true` + `summary` 字段，支持飞书原生打字光标
- 进行中卡片底部加 `⏹ 终止` 按钮 + 实时状态指示（🧠/🧰/✍️）
- 单个工具 body 截断到 2.5KB，防止超过飞书 30KB 单 element 限制
- 工具 input 按类型智能渲染（Bash 用 ```bash code block，Read 自动用 `~/` 替换 home 路径）
- README 重新组织：增加 badges、TOC、真实场景对话、双语切换链接

### 移除（Removed）

- `outputFilter.ts` 和测试（功能已合并到 `runStreamParser.ts`）

## [0.1.0] — 2026-05-24

首次公开发布。

### 新增（Added）

#### 核心交互
- 飞书 / Lark 消息转发到本机 `kiro-cli chat`，回复通过流式卡片实时刷新
- 结构化运行卡片：每次工具调用一个独立 collapsible_panel（Read / Bash / Grep / WebFetch / …）
- 多个工具调用聚合：≥3 个时前面折叠成「☕ N 个工具调用」总结，最新一个完整展示
- `streaming_mode: true` + `summary` 字段，飞书显示原生打字光标和通知摘要
- 底部 footer 状态指示（🧠 思考中 / 🧰 调工具 / ✍️ 输出中）+ ⏹ 终止按钮

#### 工作区管理
- 工作目录方案 B：`(chatId, cwd) → kiroSessionId` 双层映射，切目录不丢上下文
- 命名工作区：`/ws save|use|list|remove` 快速切换
- 根目录白名单：`workspace.allowedRoots` 限制 `/cd` 范围

#### 斜杠命令（含别名容错）
- `/new` `/cd` `/pwd` `/status` `/stop` `/timeout` `/model` `/reconnect` `/doctor` `/help`
- `/ws list|save|use|remove`
- 别名：`/m`=`/model`, `/h`=`/help`, `/s`=`/status`, `/reset`=`/new`, `/abort`=`/stop` 等
- typo 容错：`/mode` `/modle` 都识别为 `/model`
- 未知 `/xxx` 命令原样转发给 Kiro

#### 命令型卡片（按钮回调）
- v2 交互卡片，按钮走 `card.action.trigger` 长连接回调
- `/model` 卡片：每行模型带「选用」蓝色按钮，主力 / 实验性 / 旧版分组折叠
- `/help` 卡片：底部「📊 状态 / 🎛️ 模型 / 🗂️ 工作区 / 🔄 重置会话」快捷按钮
- `/status` 卡片：底部按钮直接跳转模型/工作区/重置/停止
- `/ws list` 卡片：每行「切换」按钮

#### 多媒体输入
- 图片 / 文件自动下载到 `~/.lark-kiro-bridge/media/<chatId>/`，绝对路径喂给 Kiro
- 媒体文件 24h 后自动清理

#### 多模型管理
- `kiro chat --list-models` 查询，5 分钟缓存
- 短名补全：`/m sonnet-4.6` 自动补 `claude-` 前缀
- 模型选择写入 `config.kiro.model`，下条消息立即生效

#### 运维与稳定性
- **进程组 kill**：`detached: true` + `process.kill(-pid)` 杀掉 kiro-cli 全部子孙进程
- **Idle watchdog**：默认 5 分钟，可全局或 per-chat 覆盖
- **进程注册表**：`processes.json` 检测同 app 多实例，避免 WS 事件随机分发
- **三层访问控制**：`allowedUsers` / `allowedChats` / `admins` 白名单
- **macOS launchd daemon**：崩溃自动重启，登录自启
- **结构化日志**：NDJSON 按天滚动，超过 `logRetentionDays`（默认 7 天）启动时清理
- **`/doctor`**：把日志反喂给 Kiro 自诊断

#### CLI
- `init` `run` `config-show`
- `start` `stop` `restart` `status` `unregister`
- `service install|uninstall|start|stop|status`
- `ps` `kill <id> [--force]`

### 安全（Security）

- `~/.lark-kiro-bridge/config.json` 强制 mode `0600`
- 日志写入前敏感字段（appSecret、access token）脱敏
- 卡片回调 admin 写操作（`model.set` / `ws.use` / `session.new` 等）二次校验

### 测试

- 150 个单元测试（vitest）覆盖：命令解析（含 typo 容错）、卡片回调解析、消息解析、
  ASR、SessionStore 文件锁并发
- typecheck（tsc strict）+ biome lint 全过

### 已知限制

- 仅 macOS 守护进程支持（launchd）；Linux / Windows daemon 在路线图
- 飞书免费版租户不支持 ASR，语音输入在路线图
- 群里 `@all` 永不响应（设计行为）

[Unreleased]: https://github.com/walterwang0x01/lark-kiro-bridge/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/walterwang0x01/lark-kiro-bridge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/walterwang0x01/lark-kiro-bridge/releases/tag/v0.1.0

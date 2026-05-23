/**
 * 消息总分发器
 *
 * 把一条飞书消息变成一个动作：
 *   1. 访问控制校验（用户/群白名单、@bot 检测）
 *   2. 下载图片/文件资源（如果有）
 *   3. 解析斜杠命令
 *   4. 路由到 commandHandler 或 kiroHandler
 *   5. 更新卡片
 *
 * 跨 chat 并发不限（每个 chat 自己内部串行）。
 */
import type { Logger } from 'pino';
import type { Config } from '../lib/config.js';
import { patchAndSaveConfig } from '../lib/config.js';
import type { LarkClient } from '../lark/client.js';
import type { IncomingMessage, CardActionEvent } from '../lark/types.js';
import { stripMentions } from '../lark/parse.js';
import { downloadMessageMedia } from '../lark/media.js';
import { parseCommand, type ParsedCommand } from '../commands/parse.js';
import { isUserAllowed, isAdmin, validateCwd, SecurityError } from '../lib/security.js';
import { readRecentLogLines } from '../lib/logger.js';
import { SessionStore } from '../store/sessions.js';
import { WorkspaceStore } from '../store/workspaces.js';
import { runKiro } from '../kiro/runner.js';
import { listModels, clearModelCache } from '../kiro/models.js';
import { CardRenderer } from '../card/renderer.js';
import type { CardContext } from '../card/schema.js';
import {
  buildModelPickerCard,
  buildHelpCard,
  buildWorkspaceListCard,
  buildStatusCard,
  buildAckCard,
  buildLoadingCard,
} from '../card/builders.js';
import { ChatPipeline } from './pipeline.js';

export interface DispatcherOptions {
  config: Config;
  lark: LarkClient;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  logger: Logger;
  /** 当 /reconnect 命令触发时调用，由 bootstrap 注入 */
  onReconnect?: () => Promise<void>;
}

export class Dispatcher {
  private config: Config;
  private readonly lark: LarkClient;
  private readonly sessions: SessionStore;
  private readonly workspaces: WorkspaceStore;
  private readonly log: Logger;
  private readonly pipelines = new Map<string, ChatPipeline>();
  private readonly onReconnect?: () => Promise<void>;

  constructor(opts: DispatcherOptions) {
    this.config = opts.config;
    this.lark = opts.lark;
    this.sessions = opts.sessions;
    this.workspaces = opts.workspaces;
    this.log = opts.logger.child({ module: 'dispatcher' });
    if (opts.onReconnect) this.onReconnect = opts.onReconnect;
  }

  private getPipeline(chatId: string): ChatPipeline {
    let p = this.pipelines.get(chatId);
    if (!p) {
      p = new ChatPipeline(chatId, this.log);
      this.pipelines.set(chatId, p);
    }
    return p;
  }

  /** eventId 去重缓存：飞书 at-least-once 投递保险 */
  private readonly seenEventIds = new Map<string, number>();
  private readonly EVENT_TTL_MS = 5 * 60 * 1000;

  private isDuplicate(eventId: string): boolean {
    if (!eventId) return false;
    const now = Date.now();
    // 顺手清理过期
    for (const [k, t] of this.seenEventIds) {
      if (now - t > this.EVENT_TTL_MS) this.seenEventIds.delete(k);
    }
    if (this.seenEventIds.has(eventId)) return true;
    this.seenEventIds.set(eventId, now);
    return false;
  }

  /**
   * 主入口：处理一条飞书消息。
   */
  async handle(msg: IncomingMessage): Promise<void> {
    // 0) 去重（飞书 at-least-once 可能重推同一 eventId）
    if (this.isDuplicate(msg.eventId)) {
      this.log.info({ eventId: msg.eventId }, 'duplicate event, skip');
      return;
    }

    // 1) 学习 botOpenId（第一次有人 @bot 的时候）
    if (!this.lark['botOpenIdCache' as never]) {
      // 私有字段访问不太优雅；改用 setBotOpenId 即可
      const guess = msg.mentions.find((m) => m.name?.toLowerCase().includes('kiro'))?.openId;
      if (guess) this.lark.setBotOpenId(guess);
    }

    // 2) 访问控制
    if (!isUserAllowed(msg.senderOpenId, msg.chatId, this.config)) {
      this.log.debug({ user: msg.senderOpenId, chat: msg.chatId }, 'message dropped by access control');
      return;
    }

    // 3) 群里要 @bot 才回复（除非 preferences.requireMentionInGroup=false）
    if (msg.chatType === 'group' || msg.chatType === 'topic_group') {
      if (this.config.preferences.requireMentionInGroup) {
        // 暂时还没拿到 botOpenId 的话先放过（避免漏消息）；后续 setBotOpenId 后会生效
        // 简化逻辑：mentions 不为空且没人提到 bot → 跳过
        const botMentioned = msg.mentions.some((m) =>
          (m.name ?? '').toLowerCase().includes('kiro') || (m.name ?? '').toLowerCase().includes('bot'),
        );
        if (!botMentioned && msg.mentions.length > 0) {
          this.log.debug('group message without @bot, ignored');
          return;
        }
        if (msg.mentions.length === 0) {
          this.log.debug('group message has no mentions at all, ignored (requireMentionInGroup)');
          return;
        }
      }
    }

    // 4) 仅支持 text/post 消息；image/file/audio 走媒体下载
    const supportedMedia =
      msg.messageType === 'image' ||
      msg.messageType === 'file' ||
      msg.messageType === 'audio';
    if (msg.messageType !== 'text' && msg.messageType !== 'post' && !supportedMedia) {
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'error',
          title: '⚠️ 不支持的消息类型',
          body: `当前版本不支持 \`${msg.messageType}\` 类型，已忽略。`,
        }),
      );
      return;
    }

    // 提取纯净文本（去掉 @bot mention key）
    const guessedBotOpenId =
      msg.mentions.find((m) => (m.name ?? '').toLowerCase().includes('kiro'))?.openId ?? '';
    const cleanText = stripMentions(msg, guessedBotOpenId).trim();

    // 4.5) 媒体下载（在文本之前完成，下面 prompt 拼接时把路径塞前面）
    let mediaPaths: string[] = [];
    if (supportedMedia) {
      try {
        mediaPaths = await downloadMessageMedia(this.lark, msg);
      } catch (e) {
        this.log.warn({ err: e }, 'media download error, will skip');
      }
      if (mediaPaths.length === 0 && !cleanText) {
        // 媒体下载失败、又没文字 → 报错给用户
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: 'error',
            title: '❌ 资源下载失败',
            body: `\`${msg.messageType}\` 资源下载失败，请重发或检查机器人权限。`,
          }),
        );
        return;
      }
    }

    if (!cleanText && mediaPaths.length === 0) {
      this.log.debug('empty text after strip and no media, ignored');
      return;
    }

    // 5) 解析命令
    const cmd = parseCommand(cleanText);
    const session = await this.sessions.get(msg.chatId, this.config.workspace.defaultCwd);

    // 命令需要管理员权限的判断
    const needAdmin = (() => {
      if (!cmd) return false;
      switch (cmd.kind) {
        case 'cd':
        case 'ws-save':
        case 'ws-use':
        case 'ws-remove':
        case 'reconnect':
          return true;
        default:
          return false;
      }
    })();
    if (needAdmin && !isAdmin(msg.senderOpenId, this.config)) {
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'error',
          title: '🚫 权限不足',
          body: '此命令仅管理员可用。',
        }),
      );
      return;
    }

    // 6) 路由
    if (cmd) {
      switch (cmd.kind) {
        case 'help':
          await this.sendInteractiveCard(msg, buildHelpCard());
          return;
        case 'pwd': {
          const wsName = await this.workspaceNameOf(session.currentCwd);
          const body = wsName
            ? `📁 \`${session.currentCwd}\`\n🗂️ 工作区：\`${wsName}\``
            : `📁 \`${session.currentCwd}\``;
          await this.sendInteractiveCard(
            msg,
            buildAckCard({ state: 'done', title: '📁 当前目录', body }),
          );
          return;
        }
        case 'status': {
          const kiroSid = await this.sessions.getKiroSession(msg.chatId, session.currentCwd);
          const wsName = await this.workspaceNameOf(session.currentCwd);
          const idleMin = this.effectiveIdleMinutes(session.idleTimeoutMinutes);
          const cardOpts: Parameters<typeof buildStatusCard>[0] = {
            cwd: session.currentCwd,
            hasActiveTask: this.getPipeline(msg.chatId).hasActiveTask(),
            idleMinutes: idleMin,
            isPerChatOverride: session.idleTimeoutMinutes !== undefined,
          };
          if (wsName !== undefined) cardOpts.workspaceName = wsName;
          if (kiroSid !== undefined) cardOpts.kiroSessionId = kiroSid;
          await this.sendInteractiveCard(msg, buildStatusCard(cardOpts));
          return;
        }
        case 'new': {
          await this.sessions.clearKiroSession(msg.chatId, session.currentCwd);
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'done',
              title: '🔄 会话已重置',
              body: `下次提问会在 \`${session.currentCwd}\` 下新建 Kiro session。`,
            }),
          );
          return;
        }
        case 'stop': {
          const ok = this.getPipeline(msg.chatId).abortCurrent();
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: ok ? 'aborted' : 'done',
              title: ok ? '⏹ 已发出中止信号' : 'ℹ️ 没有进行中的任务',
              body: ok
                ? '当前任务正在收尾，最多 2 秒后切到中止态。'
                : '当前 chat 没有正在跑的 Kiro 任务。',
            }),
          );
          return;
        }
        case 'cd': {
          try {
            const abs = validateCwd(cmd.path, this.config, session.currentCwd);
            await this.sessions.setCwd(msg.chatId, abs, this.config.workspace.defaultCwd);
            const wsName = await this.workspaceNameOf(abs);
            await this.sendInteractiveCard(
              msg,
              buildAckCard({
                state: 'done',
                title: '📁 目录已切换',
                body: wsName
                  ? `\`${abs}\`\n🗂️ 工作区：\`${wsName}\``
                  : `\`${abs}\``,
              }),
            );
          } catch (e) {
            const m = e instanceof SecurityError ? e.message : String((e as Error).message);
            await this.sendInteractiveCard(
              msg,
              buildAckCard({ state: 'error', title: '❌ 切换失败', body: m }),
            );
          }
          return;
        }
        case 'ws-list': {
          const all = await this.workspaces.list();
          await this.sendInteractiveCard(
            msg,
            buildWorkspaceListCard({ workspaces: all, currentCwd: session.currentCwd }),
          );
          return;
        }
        case 'ws-save': {
          await this.workspaces.save(cmd.name, session.currentCwd);
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'done',
              title: '🗂️ 工作区已保存',
              body: `\`${cmd.name}\` → \`${session.currentCwd}\``,
            }),
          );
          return;
        }
        case 'ws-use': {
          const target = await this.workspaces.get(cmd.name);
          if (!target) {
            await this.sendInteractiveCard(
              msg,
              buildAckCard({
                state: 'error',
                title: '❌ 工作区不存在',
                body: `没有名为 \`${cmd.name}\` 的工作区。用 \`/ws list\` 查看全部。`,
              }),
            );
            return;
          }
          try {
            const abs = validateCwd(target, this.config, session.currentCwd);
            await this.sessions.setCwd(msg.chatId, abs, this.config.workspace.defaultCwd);
            await this.sendInteractiveCard(
              msg,
              buildAckCard({
                state: 'done',
                title: '🗂️ 工作区已切换',
                body: `\`${cmd.name}\` → \`${abs}\``,
              }),
            );
          } catch (e) {
            const m = e instanceof SecurityError ? e.message : String((e as Error).message);
            await this.sendInteractiveCard(
              msg,
              buildAckCard({ state: 'error', title: '❌ 切换失败', body: m }),
            );
          }
          return;
        }
        case 'ws-remove': {
          const ok = await this.workspaces.remove(cmd.name);
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: ok ? 'done' : 'error',
              title: ok ? '🗑️ 工作区已删除' : '❌ 工作区不存在',
              body: ok
                ? `已删除 \`${cmd.name}\``
                : `没有名为 \`${cmd.name}\` 的工作区`,
            }),
          );
          return;
        }
        case 'timeout': {
          await this.handleTimeoutCmd(msg, session, cmd);
          return;
        }
        case 'reconnect': {
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'done',
              title: '🔄 正在重连',
              body: '正在重新建立飞书 WebSocket 连接…',
            }),
          );
          if (this.onReconnect) {
            try {
              await this.onReconnect();
            } catch (e) {
              this.log.warn({ err: e }, 'reconnect failed');
            }
          }
          return;
        }
        case 'doctor': {
          await this.handleDoctorCmd(msg, cmd.description, session.currentCwd);
          return;
        }
        case 'model': {
          await this.handleModelCmd(msg, cmd, session.currentCwd);
          return;
        }
        case 'kiro-internal': {
          const body = [
            `❓ \`/${cmd.name}\` 是 kiro-cli 的**交互式 TUI** 命令，桥接器跑的是非交互模式（\`--no-interactive\`），无法执行。`,
            '',
            '**怎么办**',
            cmd.name === 'model' || cmd.name === 'agent'
              ? `要切换 ${cmd.name === 'model' ? '模型' : 'agent'}，请编辑 \`~/.lark-kiro-bridge/config.json\` 里的 \`kiro.${cmd.name}\` 字段，然后 \`/reconnect\` 生效。`
              : `这条命令只在终端跑 \`kiro-cli\` 时可用，桥接器无法代理。`,
            '',
            '**桥接器自身的命令** 用 `/help` 查看。',
          ].join('\n');
          await this.replyErrorCard(msg, body, session.currentCwd);
          return;
        }
        case 'unknown':
          // 不识别的 /xxx 命令：原样转发给 Kiro
          break;
      }
    }

    // 7) 普通消息 / 未知命令 → 跑 Kiro
    await this.runKiroTask(msg, cleanText, session.currentCwd, mediaPaths, session.idleTimeoutMinutes);
  }

  private async workspaceNameOf(cwd: string): Promise<string | undefined> {
    const all = await this.workspaces.list();
    for (const [name, p] of Object.entries(all)) {
      if (p === cwd) return name;
    }
    return undefined;
  }

  /**
   * 计算某个 chat 实际生效的 idle watchdog 分钟数。
   *   - per-chat override 存在（包括 0）→ 优先用它
   *   - 否则用 config.kiro.idleTimeoutMinutes
   */
  private effectiveIdleMinutes(perChatOverride: number | undefined): number {
    if (perChatOverride !== undefined) return perChatOverride;
    return this.config.kiro.idleTimeoutMinutes;
  }

  private async handleTimeoutCmd(
    msg: IncomingMessage,
    session: { idleTimeoutMinutes?: number; currentCwd: string },
    cmd: Extract<ParsedCommand, { kind: 'timeout' }>,
  ): Promise<void> {
    if (cmd.mode === 'show') {
      const eff = this.effectiveIdleMinutes(session.idleTimeoutMinutes);
      const body = [
        `当前阈值：**${eff > 0 ? `${eff} 分钟` : '关闭'}**${
          session.idleTimeoutMinutes !== undefined ? '（per-chat 覆盖）' : '（全局默认）'
        }`,
        '',
        "<font color='grey'>用法</font>",
        '`/timeout 10` — 改成 10 分钟',
        '`/timeout off` — 关闭',
        '`/timeout default` — 回归全局默认',
      ].join('\n');
      await this.sendInteractiveCard(
        msg,
        buildAckCard({ state: 'done', title: '⏱ Idle Watchdog', body }),
      );
      return;
    }
    if (cmd.mode === 'set') {
      await this.sessions.setIdleTimeout(msg.chatId, cmd.minutes, this.config.workspace.defaultCwd);
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'done',
          title: '⏱ 已设置',
          body: `idle watchdog → \`${cmd.minutes}\` 分钟`,
        }),
      );
      return;
    }
    if (cmd.mode === 'off') {
      await this.sessions.setIdleTimeout(msg.chatId, 0, this.config.workspace.defaultCwd);
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'done',
          title: '⏱ 已关闭',
          body: '当前 chat 不会因为长时间无输出而被自动终止。',
        }),
      );
      return;
    }
    // default
    await this.sessions.setIdleTimeout(msg.chatId, undefined, this.config.workspace.defaultCwd);
    const eff = this.effectiveIdleMinutes(undefined);
    await this.sendInteractiveCard(
      msg,
      buildAckCard({
        state: 'done',
        title: '⏱ 已恢复默认',
        body: `回归全局默认：${eff > 0 ? `${eff} 分钟` : '关闭'}`,
      }),
    );
  }

  /**
   * /doctor [描述]
   * 把最近 200 行结构化日志 + 用户描述拼成 prompt 喂给 Kiro 自诊断。
   * 走标准 runKiroTask 流程，享受所有流式卡片和 watchdog。
   */
  private async handleDoctorCmd(
    msg: IncomingMessage,
    description: string,
    cwd: string,
  ): Promise<void> {
    const lines = readRecentLogLines(200);
    const userDesc = description.trim() || '（无）';
    const prompt = [
      '你是 lark-kiro-bridge 的运维助手。下面是这个桥接器最近的结构化日志（NDJSON），',
      '以及用户描述的问题。请基于日志找出可能的故障点，给出诊断结论和修复建议。',
      '只看日志，不要假设其他状态。',
      '',
      '**用户描述**',
      userDesc,
      '',
      '**最近日志（最多 200 行，已截短长行）**',
      '```',
      lines.length > 0 ? lines.join('\n') : '（无日志）',
      '```',
    ].join('\n');
    const session = await this.sessions.get(msg.chatId, this.config.workspace.defaultCwd);
    await this.runKiroTask(msg, prompt, cwd, [], session.idleTimeoutMinutes);
  }

  /**
   * /model         → 列出所有模型 + 当前选中（漂亮按钮卡片）
   * /model <name>  → 切换模型，写入 config.json，立即生效
   * /model auto    → 清除模型覆盖，回归 kiro-cli 默认（auto）
   *
   * 短名容错：/model sonnet-4.6 → 自动补 claude- 前缀
   *
   * 设计取舍：
   *   - 切模型只改全局 config.json，不做 per-chat 覆盖（先做最少必要）
   *   - 切完不需要 reconnect，下一条消息直接生效（spawn kiro-cli 时读最新 config）
   */
  private async handleModelCmd(
    msg: IncomingMessage,
    cmd: Extract<ParsedCommand, { kind: 'model' }>,
    cwd: string,
  ): Promise<void> {
    if (cmd.mode === 'show') {
      // 先发占位，再异步取列表 + patch
      await this.sendInteractiveCardAsync(
        msg,
        buildLoadingCard('查询可用模型…', '🎛️ 加载模型列表'),
        async () => {
          const list = await listModels(this.config.kiro.binPath);
          if (!list) {
            return buildAckCard({
              state: 'error',
              body: '无法获取模型列表，可能是 kiro-cli 没登录或不在 PATH。\n用 `/doctor` 让 Kiro 自己看日志。',
            });
          }
          const current = this.config.kiro.model ?? list.defaultModel ?? 'auto';
          return buildModelPickerCard({ current, list });
        },
      );
      return;
    }

    if (cmd.mode === 'reset') {
      this.config = patchAndSaveConfig(this.config, (draft) => {
        delete draft.kiro.model;
      });
      clearModelCache();
      const list = await listModels(this.config.kiro.binPath);
      const fallback = list?.defaultModel ?? 'auto';
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'done',
          title: '✅ 模型已恢复默认',
          body: `已清除模型覆盖，回归 kiro-cli 默认（\`${fallback}\`）`,
        }),
      );
      return;
    }

    // mode === 'set'
    await this.sendInteractiveCardAsync(
      msg,
      buildLoadingCard(`切换到 \`${cmd.name}\` …`, '🎛️ 切换模型'),
      async () => {
        const list = await listModels(this.config.kiro.binPath);
        const target = this.resolveModelName(cmd.name, list);
          if (list && target === undefined) {
            const valid = list.models.map((m) => `\`${m.name}\``).join('、');
            return buildAckCard({
              state: 'error',
              title: '❌ 模型不存在',
              body: `没有名为 \`${cmd.name}\` 的模型。\n\n可用：${valid}\n\n用 \`/model\` 查看完整列表。`,
            });
          }
        const finalName = target ?? cmd.name;
        this.config = patchAndSaveConfig(this.config, (draft) => {
          draft.kiro.model = finalName;
        });
        return buildAckCard({
          state: 'done',
          title: '✅ 模型已切换',
          body: `已切换到 \`${finalName}\`（下一条消息生效）`,
        });
      },
    );
  }

  /**
   * 模型名解析：
   *   - 列表里精确匹配 → 直接返回
   *   - 列表里有 "claude-<name>" → 返回带前缀的全名（短名容错）
   *   - 都不匹配 → 返回 undefined（让上层报错）
   * 列表为空（fetch 失败）时直接返回原名，不阻塞。
   */
  private resolveModelName(
    name: string,
    list: Awaited<ReturnType<typeof listModels>>,
  ): string | undefined {
    if (!list) return name;
    if (list.models.some((m) => m.name === name)) return name;
    const prefixed = `claude-${name}`;
    if (list.models.some((m) => m.name === prefixed)) return prefixed;
    return undefined;
  }

  /**
   * 发送一张飞书 v2 交互卡片（带按钮的那种）作为对原消息的回复。
   * 跟 replyDoneCard 不同：不走 CardRenderer 的状态机，发一次就完事，
   * 不会再 patch；按钮回调走 onCardAction 流程。
   */
  private async sendInteractiveCard(msg: IncomingMessage, card: object): Promise<void> {
    try {
      await this.lark.replyCard(msg.messageId, card);
    } catch (e) {
      this.log.error({ err: e }, 'sendInteractiveCard failed; falling back to text');
      try {
        await this.lark.sendText(msg.chatId, '❌ 卡片发送失败，请检查日志');
      } catch {
        // ignore
      }
    }
  }

  /**
   * 命令型卡片的"先占位再 patch"模式。
   *
   * 用于命令本身需要做异步工作（spawn kiro-cli 等）才能算出最终卡片内容的场景：
   *   1. 先用 placeholderCard 立刻 reply 出去，让用户看到反馈
   *   2. 异步跑 buildFinalCard()
   *   3. 用 patchCard 替换成最终卡片
   *
   * 失败时直接发 fallback 错误卡片，不让用户卡在 placeholder。
   */
  private async sendInteractiveCardAsync(
    msg: IncomingMessage,
    placeholderCard: object,
    buildFinalCard: () => Promise<object>,
  ): Promise<void> {
    let placeholderMessageId: string | undefined;
    try {
      placeholderMessageId = await this.lark.replyCard(msg.messageId, placeholderCard);
    } catch (e) {
      this.log.error({ err: e }, 'placeholder card send failed');
      // placeholder 都发不出去，直接尝试拿最终结果再发一次
    }

    let finalCard: object;
    try {
      finalCard = await buildFinalCard();
    } catch (e) {
      this.log.error({ err: e }, 'buildFinalCard threw');
      finalCard = buildAckCard({
        state: 'error',
        body: `❌ 命令执行失败：${(e as Error).message}`,
      });
    }

    if (placeholderMessageId) {
      try {
        await this.lark.patchCard(placeholderMessageId, finalCard);
      } catch (e) {
        this.log.error({ err: e }, 'patch final card failed; sending fresh');
        await this.sendInteractiveCard(msg, finalCard);
      }
    } else {
      // placeholder 没发出去，直接发最终卡片
      await this.sendInteractiveCard(msg, finalCard);
    }
  }

  /**
   * 直接发卡片到 chatId（不 reply 任何特定消息）。
   * cardAction handler 用这个——按钮触发时不 reply 那条卡片本身（嵌套体验差），
   * 而是发新消息。
   */
  private async sendCardToChat(chatId: string, card: object): Promise<void> {
    try {
      await this.lark.sendCard(chatId, card);
    } catch (e) {
      this.log.error({ err: e }, 'sendCardToChat failed; falling back to text');
      try {
        await this.lark.sendText(chatId, '❌ 卡片发送失败，请检查日志');
      } catch {
        // ignore
      }
    }
  }

  /**
   * 处理用户点了卡片按钮的事件。
   * value 约定字段：{ action: 'xxx.yyy', ...payload }
   *
   * 安全：button 触发的命令也会经过 admin 校验（调用 needAdminForAction）。
   */
  async handleCardAction(evt: CardActionEvent): Promise<void> {
    // 访问控制：跟普通消息一样
    if (!isUserAllowed(evt.senderOpenId, evt.chatId, this.config)) {
      this.log.debug({ user: evt.senderOpenId }, 'card action dropped by access control');
      return;
    }
    const action = String(evt.value['action'] ?? '');
    if (!action) {
      this.log.debug({ value: evt.value }, 'card action without "action" field, ignored');
      return;
    }

    // admin 校验：写操作要管理员
    if (this.actionNeedsAdmin(action) && !isAdmin(evt.senderOpenId, this.config)) {
      await this.sendCardToChat(
        evt.chatId,
        buildAckCard({ state: 'error', body: '此操作仅管理员可用' }),
      );
      return;
    }

    const session = await this.sessions.get(evt.chatId, this.config.workspace.defaultCwd);

    switch (action) {
      case 'model.show': {
        const list = await listModels(this.config.kiro.binPath);
        const current = this.config.kiro.model ?? list?.defaultModel ?? 'auto';
        if (!list) {
          await this.sendCardToChat(
            evt.chatId,
            buildAckCard({ state: 'error', body: '无法获取模型列表' }),
          );
          return;
        }
        await this.sendCardToChat(evt.chatId, buildModelPickerCard({ current, list }));
        return;
      }
      case 'model.refresh': {
        clearModelCache();
        const list = await listModels(this.config.kiro.binPath);
        const current = this.config.kiro.model ?? list?.defaultModel ?? 'auto';
        if (!list) {
          await this.sendCardToChat(
            evt.chatId,
            buildAckCard({ state: 'error', body: '刷新失败' }),
          );
          return;
        }
        await this.sendCardToChat(evt.chatId, buildModelPickerCard({ current, list }));
        return;
      }
      case 'model.set': {
        const name = String(evt.value['name'] ?? '').trim();
        if (!name) return;
        const list = await listModels(this.config.kiro.binPath);
        const target = this.resolveModelName(name, list);
        if (list && target === undefined) {
          await this.sendCardToChat(
            evt.chatId,
            buildAckCard({ state: 'error', body: `没有名为 \`${name}\` 的模型` }),
          );
          return;
        }
        const finalName = target ?? name;
        this.config = patchAndSaveConfig(this.config, (draft) => {
          draft.kiro.model = finalName;
        });
        await this.sendCardToChat(
          evt.chatId,
          buildAckCard({
            state: 'done',
            body: `已切换模型：\`${finalName}\`（下一条消息生效）`,
          }),
        );
        return;
      }
      case 'model.reset': {
        this.config = patchAndSaveConfig(this.config, (draft) => {
          delete draft.kiro.model;
        });
        clearModelCache();
        const list = await listModels(this.config.kiro.binPath);
        const fallback = list?.defaultModel ?? 'auto';
        await this.sendCardToChat(
          evt.chatId,
          buildAckCard({
            state: 'done',
            body: `已清除模型覆盖，回归 \`${fallback}\``,
          }),
        );
        return;
      }
      case 'session.new': {
        await this.sessions.clearKiroSession(evt.chatId, session.currentCwd);
        await this.sendCardToChat(
          evt.chatId,
          buildAckCard({
            state: 'done',
            body: `已重置 \`${session.currentCwd}\` 下的会话`,
          }),
        );
        return;
      }
      case 'session.stop': {
        const ok = this.getPipeline(evt.chatId).abortCurrent();
        await this.sendCardToChat(
          evt.chatId,
          buildAckCard({
            state: ok ? 'aborted' : 'done',
            body: ok ? '已发出中止信号' : '当前没有进行中的任务',
          }),
        );
        return;
      }
      case 'session.status': {
        const kiroSid = await this.sessions.getKiroSession(evt.chatId, session.currentCwd);
        const wsName = await this.workspaceNameOf(session.currentCwd);
        const idleMin = this.effectiveIdleMinutes(session.idleTimeoutMinutes);
        const cardOpts: Parameters<typeof buildStatusCard>[0] = {
          cwd: session.currentCwd,
          hasActiveTask: this.getPipeline(evt.chatId).hasActiveTask(),
          idleMinutes: idleMin,
          isPerChatOverride: session.idleTimeoutMinutes !== undefined,
        };
        if (wsName !== undefined) cardOpts.workspaceName = wsName;
        if (kiroSid !== undefined) cardOpts.kiroSessionId = kiroSid;
        await this.sendCardToChat(evt.chatId, buildStatusCard(cardOpts));
        return;
      }
      case 'ws.list': {
        const all = await this.workspaces.list();
        await this.sendCardToChat(
          evt.chatId,
          buildWorkspaceListCard({
            workspaces: all,
            currentCwd: session.currentCwd,
          }),
        );
        return;
      }
      case 'ws.use': {
        const name = String(evt.value['name'] ?? '').trim();
        if (!name) return;
        const target = await this.workspaces.get(name);
        if (!target) {
          await this.sendCardToChat(
            evt.chatId,
            buildAckCard({ state: 'error', body: `没有名为 \`${name}\` 的工作区` }),
          );
          return;
        }
        try {
          const abs = validateCwd(target, this.config, session.currentCwd);
          await this.sessions.setCwd(evt.chatId, abs, this.config.workspace.defaultCwd);
          await this.sendCardToChat(
            evt.chatId,
            buildAckCard({
              state: 'done',
              body: `已切换到工作区 \`${name}\` → \`${abs}\``,
            }),
          );
        } catch (e) {
          const m = e instanceof SecurityError ? e.message : String((e as Error).message);
          await this.sendCardToChat(
            evt.chatId,
            buildAckCard({ state: 'error', body: m }),
          );
        }
        return;
      }
      default:
        this.log.debug({ action }, 'unknown card action, ignored');
    }
  }

  /** 哪些 action 是写操作，需要 admin */
  private actionNeedsAdmin(action: string): boolean {
    return (
      action === 'model.set' ||
      action === 'model.reset' ||
      action === 'ws.use' ||
      action === 'session.new'
    );
  }

  private async replyDoneCard(
    msg: IncomingMessage,
    body: string,
    cwd: string,
    wsName?: string,
  ): Promise<void> {
    const ctx: CardContext = { cwd };
    if (wsName !== undefined) ctx.workspaceName = wsName;
    const renderer = new CardRenderer({
      lark: this.lark,
      chatId: msg.chatId,
      replyToMessageId: msg.messageId,
      intervalMs: this.config.preferences.cardUpdateIntervalMs,
      logger: this.log,
      ctx,
    });
    await renderer.open('done', body);
    // 立即终止（done 卡片不需要流式）
    await renderer.finalize('done', body);
  }

  private async replyErrorCard(msg: IncomingMessage, body: string, cwd: string): Promise<void> {
    const renderer = new CardRenderer({
      lark: this.lark,
      chatId: msg.chatId,
      replyToMessageId: msg.messageId,
      intervalMs: this.config.preferences.cardUpdateIntervalMs,
      logger: this.log,
      ctx: { cwd },
    });
    await renderer.open('error', body);
    await renderer.finalize('error', body);
  }

  /**
   * 把一条用户消息丢给 Kiro 处理。
   * - 在 ChatPipeline 里跑（自动 preempt）
   * - 用 CardRenderer 流式刷新卡片
   * - mediaPaths 非空时，把绝对路径作为前缀加到 prompt 前面，让 kiro-cli 能读到
   * - perChatIdleMin 控制本次 idle watchdog 阈值
   */
  private async runKiroTask(
    msg: IncomingMessage,
    prompt: string,
    cwd: string,
    mediaPaths: string[] = [],
    perChatIdleMin?: number,
  ): Promise<void> {
    const pipeline = this.getPipeline(msg.chatId);
    const taskId = `${msg.eventId || msg.messageId}-${Date.now().toString(36)}`;
    const wsName = await this.workspaceNameOf(cwd);
    const cardCtx: CardContext = { cwd };
    if (wsName !== undefined) cardCtx.workspaceName = wsName;

    // 拼接 prompt：媒体路径 + 文本
    const finalPrompt = mediaPaths.length
      ? mediaPaths.map((p) => `@${p}`).join(' ') + (prompt ? '\n\n' + prompt : '')
      : prompt;

    const idleMin = this.effectiveIdleMinutes(perChatIdleMin);
    const idleTimeoutMs = idleMin > 0 ? idleMin * 60 * 1000 : 0;

    await pipeline.submit({
      id: taskId,
      run: async (signal) => {
        const renderer = new CardRenderer({
          lark: this.lark,
          chatId: msg.chatId,
          replyToMessageId: msg.messageId,
          intervalMs: this.config.preferences.cardUpdateIntervalMs,
          logger: this.log,
          ctx: cardCtx,
        });
        try {
          await renderer.open('pending', '');
        } catch (e) {
          this.log.error({ err: e }, 'failed to open card; aborting task');
          return;
        }

        const resumeId = await this.sessions.getKiroSession(msg.chatId, cwd);
        // 在卡片上下文里标注是新会话还是续接
        renderer.updateContext({
          sessionStatus: resumeId ? `↪️ ${resumeId.slice(0, 8)}` : '🆕 新会话',
        });

        const runOpts: Parameters<typeof runKiro>[0] = {
          prompt: finalPrompt,
          cwd,
          binPath: this.config.kiro.binPath,
          trustedTools: this.config.kiro.trustedTools,
          timeoutMs: this.config.kiro.timeoutMs,
          idleTimeoutMs,
          signal,
          onChunk: (text) => renderer.appendText(text),
          onTrace: (summary) => renderer.appendTrace(summary),
        };
        if (resumeId !== undefined) runOpts.resumeId = resumeId;
        if (this.config.kiro.model !== undefined) runOpts.model = this.config.kiro.model;
        if (this.config.kiro.agent !== undefined) runOpts.agent = this.config.kiro.agent;

        let result;
        try {
          result = await runKiro(runOpts);
        } catch (e) {
          await renderer.finalize(
            'error',
            `Kiro 执行出错\n\`\`\`\n${(e as Error).message}\n\`\`\``,
          );
          return;
        }

        if (result.aborted) {
          await renderer.finalize(
            'aborted',
            result.text || "<font color='grey'>任务被打断</font>",
          );
          return;
        }
        if (result.idleTimedOut) {
          await renderer.finalize(
            'timedout',
            (result.text || '') +
              `\n\n<font color='grey'>${idleMin} 分钟无响应，已自动终止</font>`,
          );
          return;
        }
        if (result.timedOut) {
          await renderer.finalize(
            'timedout',
            (result.text || '') +
              `\n\n<font color='grey'>超过 ${
                this.config.kiro.timeoutMs / 1000
              }s 未完成，已强制终止</font>`,
          );
          return;
        }
        if (result.exitCode !== 0) {
          await renderer.finalize(
            'error',
            (result.text || '') +
              `\n\n<font color='grey'>kiro-cli 退出码 ${result.exitCode}</font>`,
          );
          return;
        }

        // 成功：保存新 sessionId 用于续接
        if (result.newSessionId && result.newSessionId !== resumeId) {
          await this.sessions.setKiroSession(msg.chatId, cwd, result.newSessionId);
          renderer.updateContext({
            sessionStatus: `↪️ ${result.newSessionId.slice(0, 8)}`,
          });
        }
        await renderer.finalize(
          'done',
          result.text || "<font color='grey'>（无回复）</font>",
        );
      },
    });
  }
}

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
import { transcribeAudio } from '../lark/asr.js';
import { parseCommand, type ParsedCommand } from '../commands/parse.js';
import { readRecentLogLines } from '../lib/logger.js';
import { SessionStore } from '../store/sessions.js';
import { WorkspaceStore } from '../store/workspaces.js';
import type { ActiveCardsStore } from '../store/activeCards.js';
import { runKiro } from '../kiro/runner.js';
import { listModels, clearModelCache } from '../kiro/models.js';
import { CardRenderer } from '../card/renderer.js';
import { RunCardController } from '../card/runCardController.js';
import {
  buildModelPickerCard,
  buildHelpCard,
  buildWorkspaceListCard,
  buildStatusCard,
  buildAckCard,
  buildLoadingCard,
  buildConfigViewCard,
  buildConfigFormCard,
  buildPsCard,
  buildMemoryListCard,
  buildMemoryViewCard,
  buildMemoryEditFormCard,
  buildMemoryNewFormCard,
  buildCronListCard,
  buildCronTranslateConfirmCard,
  buildCronTranslatedConfirmCard,
} from '../card/builders.js';
import { ChatPipeline } from './pipeline.js';
import { listProcesses, findProcess } from '../daemon/registry.js';
import {
  MemoryStore,
  MemoryError,
  validateFilename,
  normalizeFilename,
  extractInclusion,
} from '../memory/store.js';
import type { CronStore } from '../cron/store.js';
import type { CronScheduler } from '../cron/scheduler.js';
import type { CronTask } from '../cron/store.js';
import { parseExpression, nextRun, formatNextRun } from '../cron/expression.js';
import { formToCron, type ScheduleForm } from '../cron/scheduleForm.js';
import { buildScheduleFormCard, type ScheduleFormState } from '../card/scheduleCard.js';
import { runSelfChecks } from '../lib/selftest.js';
import { buildSelftestCard } from '../card/selftestCard.js';
import {
  isUserAllowed,
  isAdmin,
  validateCwd,
  validateAccessChange,
  SecurityError,
} from '../lib/security.js';

export interface DispatcherOptions {
  config: Config;
  lark: LarkClient;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  logger: Logger;
  /** 当 /reconnect 命令触发时调用，由 bootstrap 注入 */
  onReconnect?: () => Promise<void>;
  /** Cron 持久化与调度（v0.6+ 注入；不注入则 /cron 命令报"未启用"）*/
  cronStore?: CronStore;
  cronScheduler?: CronScheduler;
  /** 进行中卡片注册表；由 bootstrap 注入。不传时所有 add/remove 都是 no-op（兼容老调用方）*/
  activeCards?: ActiveCardsStore;
}

export class Dispatcher {
  private config: Config;
  private readonly lark: LarkClient;
  private readonly sessions: SessionStore;
  private readonly workspaces: WorkspaceStore;
  private readonly log: Logger;
  private readonly pipelines = new Map<string, ChatPipeline>();
  private readonly onReconnect?: () => Promise<void>;
  private readonly memory = new MemoryStore();
  private readonly cronStore?: CronStore;
  private readonly cronScheduler?: CronScheduler;
  private readonly activeCards?: ActiveCardsStore;

  constructor(opts: DispatcherOptions) {
    this.config = opts.config;
    this.lark = opts.lark;
    this.sessions = opts.sessions;
    this.workspaces = opts.workspaces;
    this.log = opts.logger.child({ module: 'dispatcher' });
    if (opts.onReconnect) this.onReconnect = opts.onReconnect;
    if (opts.cronStore) this.cronStore = opts.cronStore;
    if (opts.cronScheduler) this.cronScheduler = opts.cronScheduler;
    if (opts.activeCards) this.activeCards = opts.activeCards;
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

  /**
   * rapid-fire 消息合并：同 chat 短时间连发时把多条消息拼成一次 Kiro 调用。
   *
   * 价值：用户在飞书 IM 里习惯连发短消息（"等等"、"还有"、"刚才那个改一下"），
   * 不合并的话每条都跑一次 Kiro，浪费 token 还会被前面的 abort 打断；合并后
   * 一次性给 Kiro 完整意图。
   *
   * 实现：每条消息进来先放 buffer，200ms 内有新消息就追加；到时一次性 submit。
   *   - 第一条触发计时器、注册 buffer
   *   - 后续消息往 buffer 里追加文本（+ 媒体路径）
   *   - 200ms 静默期到 → flush，用第一条的 msg/eventId 作为 reply 锚点
   */
  private readonly mergeBuffers = new Map<
    string,
    {
      anchor: IncomingMessage;
      texts: string[];
      mediaPaths: string[];
      cwd: string;
      perChatIdleMin: number | undefined;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly MERGE_WINDOW_MS = 200;

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

    // 1) 学习 botOpenId（兜底：bootstrap 启动时已经调过 /open-apis/bot/v3/info 主动获取，
    //    极少数情况下接口没返回，就按"第一次有人 @ 任意 bot"的方式学习）
    if (!this.lark.getCachedBotOpenId()) {
      // 飞书 mention.id_type 在 mentions[].key="@_user_X" 体系里区分不出"是不是机器人"，
      // 但群里被 @ 的人有 open_id；如果只有一个 mention，多半就是 @ 了 bot 自己。
      // 名字带 kiro / bot 的优先级最高（兼容老用户），其次回退到第一个 mention。
      const byName = msg.mentions.find((m) =>
        ['kiro', 'bot'].some((kw) => (m.name ?? '').toLowerCase().includes(kw)),
      )?.openId;
      const fallback = msg.mentions[0]?.openId;
      const guess = byName ?? fallback;
      if (guess) {
        this.lark.setBotOpenId(guess);
        this.log.info(
          { openId: guess, source: byName ? 'name-match' : 'first-mention-fallback' },
          'bot open_id learned from mention',
        );
      }
    }

    // 2) 访问控制
    if (!isUserAllowed(msg.senderOpenId, msg.chatId, msg.chatType, this.config)) {
      this.log.debug(
        { user: msg.senderOpenId, chat: msg.chatId, chatType: msg.chatType },
        'message dropped by access control',
      );
      return;
    }

    // 3) 群里要 @bot 才回复（除非 preferences.requireMentionInGroup=false）
    if (msg.chatType === 'group' || msg.chatType === 'topic_group') {
      if (this.config.preferences.requireMentionInGroup) {
        const botOpenId = this.lark.getCachedBotOpenId();
        if (botOpenId) {
          // 标准路径：用 open_id 精确判定，不依赖 bot 起的名字
          const botMentioned = msg.mentions.some((m) => m.openId === botOpenId);
          if (!botMentioned) {
            this.log.debug(
              { mentions: msg.mentions.length },
              'group message without @bot, ignored',
            );
            return;
          }
        } else {
          // 启动初期 botOpenId 还没 ready 的兜底：放过有 mention 的消息（可能就是 @bot），
          // 丢弃没有 mention 的消息。学习路径会在上一步生效，下一条消息起恢复正常。
          if (msg.mentions.length === 0) {
            this.log.debug('group message has no mentions and botOpenId unknown, ignored');
            return;
          }
        }
      }
    }

    // 4) 仅支持 text/post 消息；image/file/audio 走媒体下载
    const supportedMedia =
      msg.messageType === 'image' || msg.messageType === 'file' || msg.messageType === 'audio';
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
    const botOpenIdForStrip =
      this.lark.getCachedBotOpenId() ||
      msg.mentions.find((m) => (m.name ?? '').toLowerCase().includes('kiro'))?.openId ||
      '';
    const cleanText = stripMentions(msg, botOpenIdForStrip).trim();

    // 4.5) 媒体下载（在文本之前完成，下面 prompt 拼接时把路径塞前面）
    let mediaPaths: string[] = [];
    let asrText = ''; // 语音转写出来的文本，会被拼到 cleanText 前面
    if (supportedMedia) {
      try {
        mediaPaths = await downloadMessageMedia(this.lark, msg);
      } catch (e) {
        this.log.warn({ err: e }, 'media download error, will skip');
      }
      // 音频消息：尝试调飞书 ASR 转写。成功就把 .opus 路径从 mediaPaths 移除（kiro-cli 看不懂音频），
      // 失败则把音频当成普通"文件附件"留给 Kiro，Kiro 起码能告诉用户"这是个音频文件"。
      if (msg.messageType === 'audio' && mediaPaths.length > 0) {
        const audioPath = mediaPaths[0]!;
        const r = await transcribeAudio(this.lark, audioPath);
        if (r.ok) {
          asrText = r.text;
          mediaPaths = mediaPaths.filter((p) => p !== audioPath);
          this.log.info({ textLen: r.text.length }, 'audio transcribed');
        } else {
          this.log.warn({ reason: r.reason, detail: r.detail }, 'audio transcription failed');
          // 给用户一个明确的提示卡片，告诉他/她语音没识别成功。不阻塞继续
          // 走 runKiro（mediaPaths 还在，Kiro 至少能识别这是音频文件）。
          const hint = (() => {
            switch (r.reason) {
              case 'ffmpeg-missing':
                return '⚠️ 未检测到 `ffmpeg`，无法把语音转成文字。\n请安装：`brew install ffmpeg`（macOS）或包管理器对应命令。';
              case 'too-long':
                return `⚠️ 语音太长（${r.detail ?? '> 60s'}），飞书 ASR 仅支持 60 秒以内。请分段重发。`;
              case 'api-failed':
                return `⚠️ 语音识别失败：${r.detail ?? '请稍后重试'}`;
              case 'ffmpeg-failed':
                return '⚠️ 语音转码失败，可能音频文件损坏。';
              case 'empty':
                return '⚠️ 语音中没识别到有效内容。';
              default:
                return '⚠️ 语音识别失败。';
            }
          })();
          await this.sendInteractiveCard(
            msg,
            buildAckCard({ state: 'error', title: '🎙️ 语音转写失败', body: hint }),
          );
          // 如果用户没附带文字，就到此为止；附带了文字才继续走 Kiro
          if (!cleanText) return;
        }
      }
      if (mediaPaths.length === 0 && !cleanText && !asrText) {
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

    if (!cleanText && !asrText && mediaPaths.length === 0) {
      this.log.debug('empty text after strip and no media, ignored');
      return;
    }

    // 把 ASR 转写出的文本拼到用户文本前。
    //
    // 设计取舍：
    //   - 保留 [语音] 前缀，便于 /doctor 排查 ASR 链路
    //   - 后面加一段简短 system 提示，告诉 LLM 这是日常对话，不要变成 "ASR 系统状态汇报员"
    //     （之前 LLM 看到 [语音] 会把它当成调试场景，回复一大段 ASR 工作机制说明）
    //   - 转写可能有错别字，LLM 应自然按口语意图回应
    const ASR_SYSTEM_HINT =
      '（以上由语音转写得到，可能有错别字。请按用户日常对话的口语意图回答，简短自然，不要谈论"语音"或转写本身。）';
    const effectiveText = asrText
      ? cleanText
        ? `[语音] ${asrText}\n\n${cleanText}\n\n${ASR_SYSTEM_HINT}`
        : `[语音] ${asrText}\n\n${ASR_SYSTEM_HINT}`
      : cleanText;

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
        case 'config':
        case 'exit':
          return true;
        case 'memory':
          // list / view 只读，不要 admin；edit/new/rm 要
          return cmd.mode === 'edit' || cmd.mode === 'new' || cmd.mode === 'rm';
        case 'cron':
          // list 只读，不要 admin；其他全要
          return cmd.mode !== 'list' && cmd.mode !== 'next';
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
                body: wsName ? `\`${abs}\`\n🗂️ 工作区：\`${wsName}\`` : `\`${abs}\``,
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
              body: ok ? `已删除 \`${cmd.name}\`` : `没有名为 \`${cmd.name}\` 的工作区`,
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
        case 'selftest': {
          await this.handleSelftestCmd(msg);
          return;
        }
        case 'model': {
          await this.handleModelCmd(msg, cmd, session.currentCwd);
          return;
        }
        case 'config': {
          await this.handleConfigCmd(msg);
          return;
        }
        case 'ps': {
          await this.handlePsCmd(msg);
          return;
        }
        case 'exit': {
          await this.handleExitCmd(msg, cmd.target);
          return;
        }
        case 'memory': {
          await this.handleMemoryCmd(msg, cmd, session.currentCwd);
          return;
        }
        case 'cron': {
          await this.handleCronCmd(msg, cmd, session.currentCwd);
          return;
        }
        case 'schedule': {
          await this.handleScheduleCmd(msg);
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
    await this.runKiroTask(
      msg,
      effectiveText,
      session.currentCwd,
      mediaPaths,
      session.idleTimeoutMinutes,
    );
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
   * /selftest 命令：跑结构化健康检查并回一张报告卡片。
   *
   * 检查项见 `src/lib/selftest.ts`。这里负责把运行时上下文（WS 状态、token 缓存）
   * 注入给 runSelfChecks，结果交给 buildSelftestCard 渲染。
   *
   * 注意：hasTokenCache 在当前 SDK 没有公开 API 查询，用 isWsConnected() 近似——
   * WS 连上就意味着 token 至少拿过一次。
   */
  private async handleSelftestCmd(msg: IncomingMessage): Promise<void> {
    const wsConnected = this.lark.isWsConnected();
    const report = await runSelfChecks({
      config: this.config,
      senderOpenId: msg.senderOpenId,
      wsConnected,
      hasTokenCache: wsConnected,
      kiroBinPath: this.config.kiro.binPath,
    });
    await this.sendInteractiveCard(msg, buildSelftestCard(report));
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
    _cwd: string, // 当前未使用；保留参数签名一致性，后续可能用于 per-chat 模型覆盖
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
    // 访问控制：cardAction 没有 chatType 字段（飞书 SDK 不给），所以**只校验 senderOpenId**。
    // 这是合理的：卡片是 bridge 自己发出去的，飞书已经做了"消息可见性"的访问控制；
    // 我们再用 allowedChats 校验会误伤私聊（chatId 不在群白名单里 → 私聊按钮永远点不动）。
    // 安全性：senderOpenId 校验已经能挡住租户外用户；admin 写操作另有 isAdmin 校验。
    const { allowedUsers } = this.config.access;
    if (allowedUsers.length > 0 && !allowedUsers.includes(evt.senderOpenId)) {
      this.log.warn(
        { user: evt.senderOpenId, chat: evt.chatId },
        'card action dropped by access control (sender not in allowedUsers)',
      );
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
          await this.sendCardToChat(evt.chatId, buildAckCard({ state: 'error', body: '刷新失败' }));
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
      case 'session.continue': {
        // 用户在超时卡片上点了"继续未完成的部分"
        // 用同一 chat 的 sessionId 续接，给 kiro-cli 一条简短的"继续"指令
        // sessionId 在 storage 里，这里走 fireContinue 触发 executeKiroTask
        await this.fireContinue(evt.chatId);
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
          await this.sendCardToChat(evt.chatId, buildAckCard({ state: 'error', body: m }));
        }
        return;
      }
      case 'config.show':
      case 'config.edit': {
        const isEditMode = action === 'config.edit';
        const card = isEditMode
          ? buildConfigFormCard({
              allowedUsers: this.config.access.allowedUsers,
              allowedChats: this.config.access.allowedChats,
              admins: this.config.access.admins,
              requireMentionInGroup: this.config.preferences.requireMentionInGroup,
              idleTimeoutMinutes: this.config.kiro.idleTimeoutMinutes,
            })
          : buildConfigViewCard({
              allowedUsers: this.config.access.allowedUsers,
              allowedChats: this.config.access.allowedChats,
              admins: this.config.access.admins,
              requireMentionInGroup: this.config.preferences.requireMentionInGroup,
              idleTimeoutMinutes: this.config.kiro.idleTimeoutMinutes,
              cardUpdateIntervalMs: this.config.preferences.cardUpdateIntervalMs,
              isAdmin: isAdmin(evt.senderOpenId, this.config),
            });
        await this.sendCardToChat(evt.chatId, card);
        return;
      }
      case 'config.submit': {
        await this.handleConfigSubmit(evt);
        return;
      }
      case 'process.stop': {
        const target = String(evt.value['target'] ?? '').trim();
        if (!target) return;
        const proc = await findProcess(target);
        if (!proc) {
          await this.sendCardToChat(
            evt.chatId,
            buildAckCard({ state: 'error', body: `没找到进程 \`${target}\`` }),
          );
          return;
        }
        try {
          process.kill(proc.pid, 'SIGTERM');
          await this.sendCardToChat(
            evt.chatId,
            buildAckCard({
              state: 'done',
              body:
                proc.pid === process.pid
                  ? `当前进程（pid \`${proc.pid}\`）即将退出。daemon 会自动重启；前台 run 模式需手动再起。`
                  : `已向 pid \`${proc.pid}\` 发 SIGTERM`,
            }),
          );
        } catch (e) {
          await this.sendCardToChat(
            evt.chatId,
            buildAckCard({
              state: 'error',
              body: `无法停止 pid \`${proc.pid}\`：${(e as Error).message}`,
            }),
          );
        }
        return;
      }
      case 'steering.list': {
        const scope = (evt.value['scope'] === 'global' ? 'global' : 'project') as
          | 'global'
          | 'project';
        await this.sendCardToChat(
          evt.chatId,
          this.buildSteeringListCard(scope, session.currentCwd, evt.senderOpenId),
        );
        return;
      }
      case 'steering.view': {
        const scope = (evt.value['scope'] === 'global' ? 'global' : 'project') as
          | 'global'
          | 'project';
        const name = String(evt.value['name'] ?? '');
        try {
          const content = this.memory.get(scope, session.currentCwd, name);
          await this.sendCardToChat(
            evt.chatId,
            buildMemoryViewCard({
              scope,
              name,
              content,
              isAdmin: isAdmin(evt.senderOpenId, this.config),
            }),
          );
        } catch (e) {
          const m = e instanceof MemoryError ? e.message : (e as Error).message;
          await this.sendCardToChat(evt.chatId, buildAckCard({ state: 'error', body: m }));
        }
        return;
      }
      case 'steering.edit': {
        const scope = (evt.value['scope'] === 'global' ? 'global' : 'project') as
          | 'global'
          | 'project';
        const name = String(evt.value['name'] ?? '');
        try {
          const content = this.memory.get(scope, session.currentCwd, name);
          if (content.length > 5000) {
            await this.sendCardToChat(
              evt.chatId,
              buildAckCard({
                state: 'error',
                title: '⚠️ 文件过大',
                body: `\`${name}\` 超过 5000 字符，飞书表单不支持。请用本地编辑器打开：\n\`${scope === 'global' ? '~/.kiro/steering/' : '.kiro/steering/'}${name}\``,
              }),
            );
            return;
          }
          await this.sendCardToChat(
            evt.chatId,
            buildMemoryEditFormCard({ scope, name, content, isNew: false }),
          );
        } catch (e) {
          const m = e instanceof MemoryError ? e.message : (e as Error).message;
          await this.sendCardToChat(evt.chatId, buildAckCard({ state: 'error', body: m }));
        }
        return;
      }
      case 'steering.newPrompt': {
        const scope = (evt.value['scope'] === 'global' ? 'global' : 'project') as
          | 'global'
          | 'project';
        await this.sendCardToChat(evt.chatId, buildMemoryNewFormCard({ scope }));
        return;
      }
      case 'steering.rm': {
        const scope = (evt.value['scope'] === 'global' ? 'global' : 'project') as
          | 'global'
          | 'project';
        const name = String(evt.value['name'] ?? '');
        try {
          const ok = this.memory.delete(scope, session.currentCwd, name);
          await this.sendCardToChat(
            evt.chatId,
            buildAckCard({
              state: ok ? 'done' : 'error',
              body: ok ? `已删除 \`${name}\`` : `\`${name}\` 不存在`,
            }),
          );
          // 删完顺便刷新列表
          if (ok) {
            await this.sendCardToChat(
              evt.chatId,
              this.buildSteeringListCard(scope, session.currentCwd, evt.senderOpenId),
            );
          }
        } catch (e) {
          const m = e instanceof MemoryError ? e.message : (e as Error).message;
          await this.sendCardToChat(evt.chatId, buildAckCard({ state: 'error', body: m }));
        }
        return;
      }
      case 'steering.submit': {
        await this.handleSteeringSubmit(evt, session.currentCwd);
        return;
      }
      case 'cron.list': {
        await this.sendCardToChat(
          evt.chatId,
          await this.buildCronListCardForChat(evt.chatId, evt.senderOpenId),
        );
        return;
      }
      case 'cron.run': {
        await this.handleCronAction(evt, 'run');
        return;
      }
      case 'cron.pause': {
        await this.handleCronAction(evt, 'pause');
        return;
      }
      case 'cron.resume': {
        await this.handleCronAction(evt, 'resume');
        return;
      }
      case 'cron.rm': {
        await this.handleCronAction(evt, 'rm');
        return;
      }
      case 'cron.translateConfirm': {
        const raw = String(evt.value['raw'] ?? '');
        const prompt = String(evt.value['prompt'] ?? '');
        await this.handleCronTranslate(evt, raw, prompt);
        return;
      }
      case 'cron.createConfirmed': {
        const expression = String(evt.value['expression'] ?? '');
        const description = String(evt.value['description'] ?? '');
        const prompt = String(evt.value['prompt'] ?? '');
        await this.handleCronCreate(evt, session.currentCwd, expression, description, prompt);
        return;
      }
      case 'schedule.submit': {
        await this.handleScheduleSubmit(evt, session.currentCwd);
        return;
      }
      case 'schedule.cancel': {
        await this.handleScheduleCancel(evt);
        return;
      }
      default:
        // 用 warn 级别（默认日志可见），方便排查"按钮点了没反应"这类问题
        this.log.warn(
          { action, valueKeys: Object.keys(evt.value) },
          'unknown card action, ignored',
        );
    }
  }

  /** 哪些 action 是写操作，需要 admin */
  private actionNeedsAdmin(action: string): boolean {
    return (
      action === 'model.set' ||
      action === 'model.reset' ||
      action === 'ws.use' ||
      action === 'session.new' ||
      action === 'config.edit' ||
      action === 'config.submit' ||
      action === 'process.stop' ||
      action === 'steering.edit' ||
      action === 'steering.rm' ||
      action === 'steering.newPrompt' ||
      action === 'steering.submit' ||
      action === 'cron.run' ||
      action === 'cron.pause' ||
      action === 'cron.resume' ||
      action === 'cron.rm' ||
      action === 'cron.translateConfirm' ||
      action === 'cron.createConfirmed' ||
      action === 'schedule.submit'
    );
  }

  /**
   * /config 命令：展示当前配置（只读卡片，admin 可见编辑按钮）
   */
  private async handleConfigCmd(msg: IncomingMessage): Promise<void> {
    const card = buildConfigViewCard({
      allowedUsers: this.config.access.allowedUsers,
      allowedChats: this.config.access.allowedChats,
      admins: this.config.access.admins,
      requireMentionInGroup: this.config.preferences.requireMentionInGroup,
      idleTimeoutMinutes: this.config.kiro.idleTimeoutMinutes,
      cardUpdateIntervalMs: this.config.preferences.cardUpdateIntervalMs,
      isAdmin: isAdmin(msg.senderOpenId, this.config),
    });
    await this.sendInteractiveCard(msg, card);
  }

  /**
   * 处理 config 表单提交。
   *
   * 流程：
   *   1. 解析 form_value（用户输入的逗号分隔列表 / 整数 / yes/no）
   *   2. 用 validateAccessChange 校验，防止把自己锁出去
   *   3. patchAndSaveConfig 落盘 + 立即生效
   *   4. 回一张确认卡片（同时显示新的 config view）
   */
  private async handleConfigSubmit(evt: CardActionEvent): Promise<void> {
    const fv = evt.formValue ?? {};
    const parseCsv = (raw: unknown): string[] =>
      String(raw ?? '')
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    const allowedUsers = parseCsv(fv['allowedUsers']);
    const allowedChats = parseCsv(fv['allowedChats']);
    const admins = parseCsv(fv['admins']);
    const requireMentionInGroup = String(fv['requireMentionInGroup'] ?? 'yes') === 'yes';
    const idleRaw = String(fv['idleTimeoutMinutes'] ?? '5').trim();
    const idleMin = Number(idleRaw);
    if (!Number.isFinite(idleMin) || idleMin < 0 || idleMin > 600) {
      await this.sendCardToChat(
        evt.chatId,
        buildAckCard({
          state: 'error',
          body: `❌ Idle watchdog 必须是 0~600 之间的整数，收到 \`${idleRaw}\``,
        }),
      );
      return;
    }

    // 防自锁校验
    const accessErrors = validateAccessChange({
      submitterOpenId: evt.senderOpenId,
      next: { allowedUsers, allowedChats, admins },
    });
    if (accessErrors.length > 0) {
      await this.sendCardToChat(
        evt.chatId,
        buildAckCard({
          state: 'error',
          title: '⚠️ 配置不安全',
          body: accessErrors.join('\n\n'),
        }),
      );
      return;
    }

    // 落盘
    this.config = patchAndSaveConfig(this.config, (draft) => {
      draft.access.allowedUsers = allowedUsers;
      draft.access.allowedChats = allowedChats;
      draft.access.admins = admins;
      draft.preferences.requireMentionInGroup = requireMentionInGroup;
      draft.kiro.idleTimeoutMinutes = Math.floor(idleMin);
    });
    this.log.info(
      {
        allowedUsersN: allowedUsers.length,
        allowedChatsN: allowedChats.length,
        adminsN: admins.length,
        requireMentionInGroup,
        idleMin: Math.floor(idleMin),
        by: evt.senderOpenId,
      },
      'config updated via card form',
    );

    // 回执 + 新的 view 卡片
    await this.sendCardToChat(
      evt.chatId,
      buildAckCard({
        state: 'done',
        title: '✅ 配置已保存',
        body: '改动立即生效，无需重启。',
      }),
    );
    await this.sendCardToChat(
      evt.chatId,
      buildConfigViewCard({
        allowedUsers: this.config.access.allowedUsers,
        allowedChats: this.config.access.allowedChats,
        admins: this.config.access.admins,
        requireMentionInGroup: this.config.preferences.requireMentionInGroup,
        idleTimeoutMinutes: this.config.kiro.idleTimeoutMinutes,
        cardUpdateIntervalMs: this.config.preferences.cardUpdateIntervalMs,
        isAdmin: isAdmin(evt.senderOpenId, this.config),
      }),
    );
  }

  /**
   * /ps 命令：列出本机所有 bridge 进程，标记当前回复的进程。
   */
  private async handlePsCmd(msg: IncomingMessage): Promise<void> {
    const list = await listProcesses();
    await this.sendInteractiveCard(msg, buildPsCard({ processes: list, selfPid: process.pid }));
  }

  /**
   * /exit <id|#> 命令：SIGTERM 指定进程。
   *
   * 安全策略：
   *   - 自己 → 优雅停止（让 daemon 守护重启；如果是前台 run 则直接退）
   *   - 他人 → SIGTERM
   *   - 找不到目标 → 报错
   */
  private async handleExitCmd(msg: IncomingMessage, target: string): Promise<void> {
    const proc = await findProcess(target);
    if (!proc) {
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'error',
          title: '❌ 没找到进程',
          body: `没有匹配 \`${target}\` 的进程。\n用 \`/ps\` 查看当前列表。`,
        }),
      );
      return;
    }
    const isSelf = proc.pid === process.pid;
    try {
      process.kill(proc.pid, 'SIGTERM');
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'done',
          title: isSelf ? '⏹ 当前进程退出中' : '⏹ 已发出停止信号',
          body: isSelf
            ? `pid \`${proc.pid}\` 即将退出。${'daemon 守护下会自动重启；如果是前台 `run` 则需要你手动再起。'}`
            : `已向 pid \`${proc.pid}\`（\`${proc.shortId}\`）发 SIGTERM。`,
        }),
      );
    } catch (e) {
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'error',
          title: '❌ 信号失败',
          body: `无法向 pid \`${proc.pid}\` 发信号：${(e as Error).message}`,
        }),
      );
    }
  }

  /**
   * /steering（memory）命令统一入口。
   *
   * 子命令：
   *   - list / 无参数      → 列出当前 scope 的 steering 文件
   *   - view <name>        → 看具体内容
   *   - edit <name>        → 弹表单编辑（admin）
   *   - new <name>         → 新建（带初始名）（admin）
   *   - rm <name>          → 删除（admin）
   *
   * scope 通过 cmd.scope（global / project，默认 project）控制。
   */
  private async handleMemoryCmd(
    msg: IncomingMessage,
    cmd: Extract<ParsedCommand, { kind: 'memory' }>,
    cwd: string,
  ): Promise<void> {
    if (cmd.mode === 'list') {
      await this.sendInteractiveCard(
        msg,
        this.buildSteeringListCard(cmd.scope, cwd, msg.senderOpenId),
      );
      return;
    }
    const normName = normalizeFilename(cmd.name);
    if (cmd.mode === 'view') {
      const validErrors = validateFilename(normName);
      if (validErrors.length > 0) {
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: 'error',
            title: '❌ 文件名非法',
            body: validErrors.join('\n'),
          }),
        );
        return;
      }
      try {
        const content = this.memory.get(cmd.scope, cwd, normName);
        await this.sendInteractiveCard(
          msg,
          buildMemoryViewCard({
            scope: cmd.scope,
            name: normName,
            content,
            isAdmin: isAdmin(msg.senderOpenId, this.config),
          }),
        );
      } catch (e) {
        const m = e instanceof MemoryError ? e.message : (e as Error).message;
        await this.sendInteractiveCard(msg, buildAckCard({ state: 'error', body: m }));
      }
      return;
    }
    if (cmd.mode === 'edit') {
      const validErrors = validateFilename(normName);
      if (validErrors.length > 0) {
        await this.sendInteractiveCard(
          msg,
          buildAckCard({ state: 'error', body: validErrors.join('\n') }),
        );
        return;
      }
      try {
        const content = this.memory.get(cmd.scope, cwd, normName);
        if (content.length > 5000) {
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'error',
              title: '⚠️ 文件过大',
              body: `\`${normName}\` 超过 5000 字符，飞书表单不支持。请用本地编辑器编辑。`,
            }),
          );
          return;
        }
        await this.sendInteractiveCard(
          msg,
          buildMemoryEditFormCard({ scope: cmd.scope, name: normName, content, isNew: false }),
        );
      } catch (e) {
        const m = e instanceof MemoryError ? e.message : (e as Error).message;
        await this.sendInteractiveCard(msg, buildAckCard({ state: 'error', body: m }));
      }
      return;
    }
    if (cmd.mode === 'new') {
      const validErrors = validateFilename(normName);
      if (validErrors.length > 0) {
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: 'error',
            title: '❌ 文件名非法',
            body: validErrors.join('\n'),
          }),
        );
        return;
      }
      // 新建场景：name 已知，弹空白编辑表单
      await this.sendInteractiveCard(
        msg,
        buildMemoryEditFormCard({ scope: cmd.scope, name: normName, content: '', isNew: true }),
      );
      return;
    }
    if (cmd.mode === 'rm') {
      const validErrors = validateFilename(normName);
      if (validErrors.length > 0) {
        await this.sendInteractiveCard(
          msg,
          buildAckCard({ state: 'error', body: validErrors.join('\n') }),
        );
        return;
      }
      try {
        const ok = this.memory.delete(cmd.scope, cwd, normName);
        await this.sendInteractiveCard(
          msg,
          buildAckCard({
            state: ok ? 'done' : 'error',
            body: ok ? `已删除 \`${normName}\`` : `\`${normName}\` 不存在`,
          }),
        );
      } catch (e) {
        const m = e instanceof MemoryError ? e.message : (e as Error).message;
        await this.sendInteractiveCard(msg, buildAckCard({ state: 'error', body: m }));
      }
      return;
    }
  }

  /**
   * 构造 steering 列表卡片（带 inclusion frontmatter 解析）。
   * 抽出来给命令入口和按钮回调共用。
   */
  private buildSteeringListCard(
    scope: 'global' | 'project',
    cwd: string,
    senderOpenId: string,
  ): object {
    const files = this.memory.list(scope, cwd);
    const enriched = files.map((f) => {
      let inclusion = 'always';
      try {
        const c = this.memory.get(scope, cwd, f.name);
        inclusion = extractInclusion(c);
      } catch {
        // ignore
      }
      return { name: f.name, inclusion, size: f.size };
    });
    return buildMemoryListCard({
      scope,
      cwd,
      files: enriched,
      isAdmin: isAdmin(senderOpenId, this.config),
    });
  }

  /**
   * 处理 steering 表单提交。
   *
   * 三种来源：
   *   1. 编辑现有文件（value.name 有值，isNew=false）→ form_value 只有 content
   *   2. /steering new <name> 命令进入的编辑（value.name 有值，isNew=true）→ form_value 只有 content
   *   3. 点「📝 新建」按钮的入口表单（value.name 无值，isNew=true）→ form_value 含 name + content
   */
  private async handleSteeringSubmit(evt: CardActionEvent, cwd: string): Promise<void> {
    const fv = evt.formValue ?? {};
    const scope = (evt.value['scope'] === 'global' ? 'global' : 'project') as 'global' | 'project';
    const isNew = evt.value['isNew'] === true;

    // 决定文件名：value 里有就用 value，否则从表单 name 字段取
    let name = String(evt.value['name'] ?? '').trim();
    if (!name && typeof fv['name'] === 'string') {
      name = normalizeFilename(String(fv['name']));
    }
    if (!name) {
      await this.sendCardToChat(
        evt.chatId,
        buildAckCard({ state: 'error', body: '❌ 缺少文件名' }),
      );
      return;
    }
    const validErrors = validateFilename(name);
    if (validErrors.length > 0) {
      await this.sendCardToChat(
        evt.chatId,
        buildAckCard({
          state: 'error',
          title: '❌ 文件名非法',
          body: validErrors.join('\n'),
        }),
      );
      return;
    }

    const content = String(fv['content'] ?? '');
    try {
      this.memory.save(scope, cwd, name, content);
      this.log.info(
        {
          scope,
          name,
          size: content.length,
          isNew,
          by: evt.senderOpenId,
        },
        'steering saved',
      );
      await this.sendCardToChat(
        evt.chatId,
        buildAckCard({
          state: 'done',
          title: isNew ? '✅ 已创建' : '✅ 已保存',
          body: `\`${name}\`（${scope === 'global' ? '全局' : '项目'}），下次 Kiro 启动时生效。`,
        }),
      );
      // 刷新列表卡片
      await this.sendCardToChat(
        evt.chatId,
        this.buildSteeringListCard(scope, cwd, evt.senderOpenId),
      );
    } catch (e) {
      const m = e instanceof MemoryError ? e.message : (e as Error).message;
      await this.sendCardToChat(evt.chatId, buildAckCard({ state: 'error', body: m }));
    }
  }

  // ===== /cron 实现 =====

  /**
   * /cron 命令统一入口。
   *
   * 子命令：list / add / rm / pause / resume / run / next / translate
   *
   * 大部分子命令需要 cronStore + cronScheduler；如果 dispatcher 没注入这两个，
   * 给一张"功能未启用"提示卡（防止 /cron 命令在无 cron 配置下崩）。
   */
  private async handleCronCmd(
    msg: IncomingMessage,
    cmd: Extract<ParsedCommand, { kind: 'cron' }>,
    cwd: string,
  ): Promise<void> {
    if (!this.cronStore || !this.cronScheduler) {
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'error',
          title: '⚠️ 定时任务未启用',
          body: '当前 bridge 实例没启用 cron 模块。请升级到最新版后重启。',
        }),
      );
      return;
    }

    switch (cmd.mode) {
      case 'list': {
        await this.sendInteractiveCard(
          msg,
          await this.buildCronListCardForChat(msg.chatId, msg.senderOpenId),
        );
        return;
      }
      case 'add': {
        // 解析表达式
        const parsed = parseExpression(cmd.expression);
        if (parsed.kind === 'unknown') {
          // 弹翻译确认卡片
          await this.sendInteractiveCard(
            msg,
            buildCronTranslateConfirmCard({ raw: cmd.expression, prompt: cmd.prompt }),
          );
          return;
        }
        // 直接创建
        await this.handleCronCreateInner(
          msg,
          cwd,
          parsed.expression,
          parsed.description,
          cmd.prompt,
        );
        return;
      }
      case 'translate': {
        // 用户主动用 /cron translate 触发
        await this.sendInteractiveCard(
          msg,
          buildCronTranslateConfirmCard({ raw: cmd.raw, prompt: '' }),
        );
        return;
      }
      case 'rm':
      case 'pause':
      case 'resume':
      case 'run':
      case 'next': {
        const proc = await this.cronStore.findById(cmd.id);
        if (!proc) {
          await this.sendInteractiveCard(
            msg,
            buildAckCard({
              state: 'error',
              title: '❌ 没找到任务',
              body: `没有匹配 \`${cmd.id}\` 的任务。用 \`/cron\` 查看列表。`,
            }),
          );
          return;
        }
        await this.applyCronAction(
          (card) => this.sendInteractiveCard(msg, card),
          proc.id,
          cmd.mode,
        );
        return;
      }
    }
  }

  /**
   * 构造当前 chat 的 cron 列表卡片（带下次触发时间）。
   */
  private async buildCronListCardForChat(chatId: string, senderOpenId: string): Promise<object> {
    if (!this.cronStore || !this.cronScheduler) {
      return buildAckCard({
        state: 'error',
        title: '⚠️ 定时任务未启用',
        body: 'cron 模块未注入',
      });
    }
    const tasks = await this.cronStore.list(chatId);
    return buildCronListCard({
      tasks: tasks.map((t) => ({
        id: t.id,
        expression: t.expression,
        description: t.description,
        prompt: t.prompt,
        enabled: t.enabled,
        lastRunAt: t.lastRunAt,
        nextRunAt: this.cronScheduler!.nextRun(t.id) ?? nextRun(t.expression),
      })),
      isAdmin: isAdmin(senderOpenId, this.config),
    });
  }

  /** 处理列表卡片上的按钮操作（run/pause/resume/rm）。 */
  private async handleCronAction(
    evt: CardActionEvent,
    mode: 'run' | 'pause' | 'resume' | 'rm',
  ): Promise<void> {
    const id = String(evt.value['id'] ?? '');
    if (!id) return;
    await this.applyCronAction((card) => this.sendCardToChat(evt.chatId, card), id, mode);
  }

  /**
   * 应用一个 cron 操作（命令入口和按钮回调共用）。
   *
   * sendCard：怎么发回执卡片（命令是 reply，按钮是 sendToChat）
   */
  private async applyCronAction(
    sendCard: (card: object) => Promise<void>,
    id: string,
    mode: 'run' | 'pause' | 'resume' | 'rm' | 'next',
  ): Promise<void> {
    if (!this.cronStore || !this.cronScheduler) return;
    const task = await this.cronStore.findById(id);
    if (!task) {
      await sendCard(buildAckCard({ state: 'error', body: `没找到任务 \`${id}\`` }));
      return;
    }
    switch (mode) {
      case 'rm': {
        const ok = await this.cronStore.delete(task.id);
        if (ok) this.cronScheduler.unregister(task.id);
        await sendCard(
          buildAckCard({
            state: 'done',
            body: `已删除 \`${task.id.slice(0, 6)}\``,
          }),
        );
        return;
      }
      case 'pause': {
        await this.cronStore.update(task.id, (t) => {
          t.enabled = false;
        });
        this.cronScheduler.unregister(task.id);
        await sendCard(
          buildAckCard({
            state: 'done',
            body: `已暂停 \`${task.id.slice(0, 6)}\`，用 resume 恢复`,
          }),
        );
        return;
      }
      case 'resume': {
        const updated = await this.cronStore.update(task.id, (t) => {
          t.enabled = true;
        });
        if (updated) this.cronScheduler.register(updated);
        await sendCard(
          buildAckCard({
            state: 'done',
            body: `已恢复 \`${task.id.slice(0, 6)}\``,
          }),
        );
        return;
      }
      case 'run': {
        // 立即手动触发（异步），不等结果
        this.fireCronTask(task).catch((e) => {
          this.log.error({ err: e, id: task.id }, 'manual cron run failed');
        });
        await sendCard(
          buildAckCard({
            state: 'done',
            body: `已手动触发 \`${task.id.slice(0, 6)}\`，结果会以新卡片回到这里`,
          }),
        );
        return;
      }
      case 'next': {
        const nxt = this.cronScheduler.nextRun(task.id) ?? nextRun(task.expression);
        await sendCard(
          buildAckCard({
            state: 'done',
            title: '⏰ 下次触发',
            body: `\`${task.id.slice(0, 6)}\`：${formatNextRun(nxt)}`,
          }),
        );
        return;
      }
    }
  }

  /**
   * 用户在 /cron add 命令里给的表达式无法解析，点了「让 Kiro 翻译」按钮。
   *
   * 实现：spawn 一次 kiro-cli 让它输出 cron 5 段表达式。
   * Kiro 翻译完后弹出二次确认卡片。
   */
  private async handleCronTranslate(
    evt: CardActionEvent,
    raw: string,
    prompt: string,
  ): Promise<void> {
    if (!this.cronStore || !this.cronScheduler) return;
    // 先发占位卡片
    await this.sendCardToChat(
      evt.chatId,
      buildLoadingCard(`正在让 Kiro 把 \`${raw}\` 翻译成 cron 表达式…`, '🤔 翻译中'),
    );

    const translatePrompt = [
      '把下面这句中文/英文调度描述转成标准 cron 5 段表达式。',
      '只输出表达式本身（5 段，空格分隔），不要任何解释、引号、代码块标记。',
      '例如输入"每天9点"，输出：0 9 * * *',
      '',
      `输入：${raw}`,
    ].join('\n');

    // 直接调 runKiro 的内部能力
    const { runKiro } = await import('../kiro/runner.js');
    let result: Awaited<ReturnType<typeof runKiro>>;
    try {
      const runOpts: Parameters<typeof runKiro>[0] = {
        prompt: translatePrompt,
        cwd: this.config.workspace.defaultCwd,
        binPath: this.config.kiro.binPath,
        trustedTools: [],
        timeoutMs: 60_000,
        idleTimeoutMs: 30_000,
        signal: new AbortController().signal,
        onChunk: () => undefined,
      };
      if (this.config.kiro.model !== undefined) runOpts.model = this.config.kiro.model;
      result = await runKiro(runOpts);
    } catch (e) {
      await this.sendCardToChat(
        evt.chatId,
        buildAckCard({
          state: 'error',
          body: `翻译失败：${(e as Error).message}`,
        }),
      );
      return;
    }

    // 提取 cron 表达式（Kiro 可能多说了几句）
    const text = (result.text ?? '').trim();
    const m = text.match(/(\S+\s+\S+\s+\S+\s+\S+\s+\S+)/);
    if (!m) {
      await this.sendCardToChat(
        evt.chatId,
        buildAckCard({
          state: 'error',
          title: '❌ Kiro 没给出 cron 表达式',
          body: `Kiro 输出：\n\`\`\`\n${text.slice(0, 500)}\n\`\`\``,
        }),
      );
      return;
    }
    const expression = (m[1] as string).trim();
    const parsed = parseExpression(expression);
    if (parsed.kind === 'unknown') {
      await this.sendCardToChat(
        evt.chatId,
        buildAckCard({
          state: 'error',
          title: '❌ Kiro 给的表达式不合法',
          body: `\`${expression}\`\n\n请用 \`/cron add\` 直接输入合法 cron 表达式。`,
        }),
      );
      return;
    }
    // 弹二次确认卡
    await this.sendCardToChat(
      evt.chatId,
      buildCronTranslatedConfirmCard({
        raw,
        expression: parsed.expression,
        description: parsed.description,
        nextRun: formatNextRun(nextRun(parsed.expression)),
        prompt,
      }),
    );
  }

  /** 二次确认通过后真正创建 cron 任务（来自 cron.createConfirmed action）。 */
  private async handleCronCreate(
    evt: CardActionEvent,
    cwd: string,
    expression: string,
    description: string,
    prompt: string,
  ): Promise<void> {
    if (!this.cronStore || !this.cronScheduler) return;
    const parsed = parseExpression(expression);
    if (parsed.kind === 'unknown') {
      await this.sendCardToChat(
        evt.chatId,
        buildAckCard({ state: 'error', body: `非法表达式 \`${expression}\`` }),
      );
      return;
    }
    try {
      const task = await this.cronStore.create({
        chatId: evt.chatId,
        cwd,
        expression: parsed.expression,
        prompt,
        description: description || parsed.description,
        createdBy: evt.senderOpenId,
      });
      this.cronScheduler.register(task);
      await this.sendCardToChat(
        evt.chatId,
        buildAckCard({
          state: 'done',
          title: '✅ 定时任务已创建',
          body: `\`${task.id.slice(0, 6)}\`：${parsed.description}\n下次：\`${formatNextRun(nextRun(task.expression))}\``,
        }),
      );
    } catch (e) {
      await this.sendCardToChat(
        evt.chatId,
        buildAckCard({
          state: 'error',
          body: `创建失败：${(e as Error).message}`,
        }),
      );
    }
  }

  /** 从 /cron add 命令直接创建（已通过表达式解析，不需要二次确认）。 */
  private async handleCronCreateInner(
    msg: IncomingMessage,
    cwd: string,
    expression: string,
    description: string,
    prompt: string,
  ): Promise<void> {
    if (!this.cronStore || !this.cronScheduler) return;
    try {
      const task = await this.cronStore.create({
        chatId: msg.chatId,
        cwd,
        expression,
        prompt,
        description,
        createdBy: msg.senderOpenId,
      });
      this.cronScheduler.register(task);
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'done',
          title: '✅ 定时任务已创建',
          body: `\`${task.id.slice(0, 6)}\`：${description}\n下次：\`${formatNextRun(nextRun(task.expression))}\`\nPrompt：${prompt.length > 100 ? prompt.slice(0, 100) + '…' : prompt}`,
        }),
      );
    } catch (e) {
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'error',
          body: `创建失败：${(e as Error).message}`,
        }),
      );
    }
  }

  // ===== /schedule new — 可视化定时任务表单 =====

  /**
   * /schedule new 入口：弹一张默认状态的表单卡片。
   * 默认值：频率=daily，时分=09:00，prompt/name 都为空。
   *
   * 跟 /cron 一样，要求 cronStore + cronScheduler 注入；否则报"未启用"。
   */
  private async handleScheduleCmd(msg: IncomingMessage): Promise<void> {
    if (!this.cronStore || !this.cronScheduler) {
      await this.sendInteractiveCard(
        msg,
        buildAckCard({
          state: 'error',
          title: '⚠️ 定时任务未启用',
          body: '当前 bridge 实例没启用 cron 模块。请升级到最新版后重启。',
        }),
      );
      return;
    }
    // 写操作 admin 守卫：表单提交才需要 admin。打开表单本身不需要——
    // 让普通用户也能看到这个 UI（实际能不能创建由 submit 的 admin 校验决定）。
    const initial: ScheduleFormState = {
      frequency: 'daily',
      hour: 9,
      minute: 0,
    };
    await this.sendInteractiveCard(msg, buildScheduleFormCard({ state: initial }));
  }

  /**
   * 用户点了「取消」按钮：把表单卡替换成"已取消"提示。
   */
  private async handleScheduleCancel(evt: CardActionEvent): Promise<void> {
    const card = buildAckCard({
      state: 'aborted',
      title: '已取消',
      body: '没有创建任何任务。',
    });
    try {
      await this.lark.patchCard(evt.messageId, card);
    } catch (e) {
      this.log.error({ err: e, action: 'schedule.cancel' }, 'patchCard failed');
      await this.sendCardToChat(evt.chatId, card);
    }
  }

  /**
   * 用户点了「创建」按钮（form submit）。
   *
   * MVP 只处理 daily 频率，强制写死。其他频率请用 /cron add。
   *
   * 流程：
   *   1. 从 evt.formValue 拿 hour/minute/prompt/name
   *   2. 拼成 ScheduleForm，调 formToCron
   *   3. 失败 → patchCard 显示带 error 的同张表单
   *   4. 成功 → cronStore.create + scheduler.register，patchCard 替换为成功提示
   */
  private async handleScheduleSubmit(evt: CardActionEvent, cwd: string): Promise<void> {
    if (!this.cronStore || !this.cronScheduler) return;
    const fv = evt.formValue ?? {};

    const hourRaw = String(fv['hour'] ?? '9').trim();
    const minuteRaw = String(fv['minute'] ?? '0').trim();
    // input 接收的是用户键入的字符串，可能是空、"9"、"09"、"9 " 等
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    const promptRaw = String(fv['prompt'] ?? '').trim();
    const nameRaw = String(fv['name'] ?? '').trim();

    const form: ScheduleForm = { frequency: 'daily', hour, minute };

    // prompt 必填
    if (!promptRaw) {
      const errCard = buildScheduleFormCard({
        state: this.formToState(form, promptRaw, nameRaw),
        error: '请填写"内容"——到点要让 Kiro 做什么',
      });
      await this.replaceWithCard(evt, errCard);
      return;
    }

    const result = formToCron(form);
    if (!result.ok) {
      const errCard = buildScheduleFormCard({
        state: this.formToState(form, promptRaw, nameRaw),
        error: result.error,
      });
      await this.replaceWithCard(evt, errCard);
      return;
    }

    // 任务名：用户填了用用户的，否则取 prompt 前 20 字
    const description = nameRaw || promptRaw.slice(0, 20);

    try {
      const task = await this.cronStore.create({
        chatId: evt.chatId,
        cwd,
        expression: result.expression,
        prompt: promptRaw,
        description,
        createdBy: evt.senderOpenId,
        runOnce: result.runOnce,
      });
      this.cronScheduler.register(task);
      const next = this.cronScheduler.nextRun(task.id) ?? nextRun(task.expression);
      const card = buildAckCard({
        state: 'done',
        title: '✅ 定时任务已创建',
        body: [
          `\`${task.id.slice(0, 6)}\` · ${description}`,
          `**频率**：${result.description}`,
          `**下次触发**：${formatNextRun(next)}`,
        ].join('\n'),
      });
      await this.replaceWithCard(evt, card);
    } catch (e) {
      const errCard = buildScheduleFormCard({
        state: this.formToState(form, promptRaw, nameRaw),
        error: `创建失败：${(e as Error).message}`,
      });
      await this.replaceWithCard(evt, errCard);
    }
  }

  /**
   * 把 ScheduleForm + 用户输入合并回 ScheduleFormState（出错时回填表单用）。
   */
  private formToState(form: ScheduleForm, prompt: string, name: string): ScheduleFormState {
    const out: ScheduleFormState = { frequency: form.frequency };
    if (form.hour !== undefined) out.hour = form.hour;
    if (form.minute !== undefined) out.minute = form.minute;
    if (form.weekdays !== undefined) out.weekdays = form.weekdays;
    if (form.dayOfMonth !== undefined) out.dayOfMonth = form.dayOfMonth;
    if (form.date !== undefined) out.date = form.date;
    if (form.expression !== undefined) out.expression = form.expression;
    if (prompt) out.prompt = prompt;
    if (name) out.name = name;
    return out;
  }

  /**
   * 把卡片替换到原消息上（patchCard 失败时降级为新发卡）。
   */
  private async replaceWithCard(evt: CardActionEvent, card: object): Promise<void> {
    try {
      await this.lark.patchCard(evt.messageId, card);
    } catch (e) {
      this.log.error({ err: e }, 'patchCard failed; fallback to send new card');
      await this.sendCardToChat(evt.chatId, card);
    }
  }

  /**
   * cron 任务到点触发：构造一个伪 IncomingMessage 调用 runKiroTask。
   *
   * 关键设计：触发时往原 chat 发一张「⏰ 定时任务」开头的卡片，跟用户主动 @ 走完全相同的卡片渲染体系，
   * 只是头部多一个 "⏰ 定时" 标记（通过 prompt 前缀实现，让 Kiro 知道这是定时任务）。
   *
   * 注意：这里**不走** rapid-fire 合并（因为是定时，不存在用户连发）。
   * 直接调用 executeKiroTask。
   */
  async fireCronTask(task: CronTask): Promise<void> {
    const fakeMessage: IncomingMessage = {
      eventId: `cron-${task.id}-${Date.now()}`,
      messageId: '',
      chatId: task.chatId,
      chatType: 'group',
      senderOpenId: task.createdBy || 'cron',
      messageType: 'text',
      rawContent: '',
      text: task.prompt,
      mentions: [],
      receivedAt: Date.now(),
    };
    // 触发时给一张提示卡片，让用户知道是定时任务
    try {
      await this.sendCardToChat(
        task.chatId,
        buildAckCard({
          state: 'done',
          title: '⏰ 定时任务触发',
          body: `\`${task.id.slice(0, 6)}\` (${task.description || task.expression})\n${task.prompt.length > 100 ? task.prompt.slice(0, 100) + '…' : task.prompt}`,
        }),
      );
    } catch (e) {
      this.log.warn({ err: e, id: task.id }, 'failed to send cron trigger notice');
    }

    // 调 executeKiroTask 跑 Kiro，跟普通消息一样的卡片渲染
    await this.executeKiroTask(fakeMessage, task.prompt, task.cwd, [], undefined);
  }

  /**
   * 用户在超时卡片上点"继续未完成的部分"按钮的处理。
   *
   * 关键：靠 kiro-cli 的 session 续接能力——sessionId 已存在 sessions store，
   * executeKiroTask 拿到 resumeId 就会传 `--resume-id` 给 kiro-cli，
   * 模型读到完整对话历史，自然知道接着上次的工作干。
   *
   * 我们这里只需要构造一条"继续"prompt 触发任务，无需重传全部上下文。
   */
  async fireContinue(chatId: string): Promise<void> {
    const session = await this.sessions.get(chatId, this.config.workspace.defaultCwd);
    const resumeId = await this.sessions.getKiroSession(chatId, session.currentCwd);
    if (!resumeId) {
      // 没有 sessionId 说明上次根本没跑成功；提示一下就行
      await this.sendCardToChat(
        chatId,
        buildAckCard({
          state: 'error',
          title: '⚠️ 无法继续',
          body: '当前 chat 在该工作目录下没有可续接的会话。请重新发送原消息。',
        }),
      );
      return;
    }
    const fakeMessage: IncomingMessage = {
      eventId: `continue-${chatId}-${Date.now()}`,
      messageId: '',
      chatId,
      chatType: 'group',
      senderOpenId: 'continue-button',
      messageType: 'text',
      rawContent: '',
      text: '',
      mentions: [],
      receivedAt: Date.now(),
    };
    const continuePrompt =
      '继续上次未完成的工作。如果上次任务有明确的剩余步骤就只完成剩余的；如果接近完成就只补完最后一步。' +
      '不要重做已经完成的部分。';
    await this.executeKiroTask(
      fakeMessage,
      continuePrompt,
      session.currentCwd,
      [],
      session.idleTimeoutMinutes,
    );
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
   *
   * **包了一层 rapid-fire 合并**：先放 buffer，等 200ms 静默期再真正 submit；
   * 期间若同 chat 又来新消息，就追加到同一个 buffer，不会触发 abort+rerun。
   *
   * 真正的 Kiro 调用在 executeKiroTask 里。
   */
  private async runKiroTask(
    msg: IncomingMessage,
    prompt: string,
    cwd: string,
    mediaPaths: string[] = [],
    perChatIdleMin?: number,
  ): Promise<void> {
    // 命令型场景（doctor 等）prompt 极长且不该合并，跳过合并直接执行
    // 这里用启发式：prompt > 500 字符或 包含 "**最近日志**" 视为命令型
    const skipMerge = prompt.length > 500 || prompt.includes('**最近日志');
    if (skipMerge) {
      await this.executeKiroTask(msg, prompt, cwd, mediaPaths, perChatIdleMin);
      return;
    }

    const existing = this.mergeBuffers.get(msg.chatId);
    if (existing) {
      // 追加到现有 buffer
      if (prompt) existing.texts.push(prompt);
      existing.mediaPaths.push(...mediaPaths);
      // 重置计时器，给最新一条消息再续 200ms
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        this.flushMergeBuffer(msg.chatId);
      }, this.MERGE_WINDOW_MS);
      this.log.debug(
        { chatId: msg.chatId, accumulated: existing.texts.length },
        'merging rapid-fire message',
      );
      return;
    }

    // 第一条：开 buffer 等更多
    const timer = setTimeout(() => {
      this.flushMergeBuffer(msg.chatId);
    }, this.MERGE_WINDOW_MS);
    this.mergeBuffers.set(msg.chatId, {
      anchor: msg,
      texts: prompt ? [prompt] : [],
      mediaPaths: [...mediaPaths],
      cwd,
      perChatIdleMin,
      timer,
    });
  }

  /**
   * flush 当前 chat 的合并 buffer：把累计的文本拼一起，调 executeKiroTask。
   */
  private flushMergeBuffer(chatId: string): void {
    const buf = this.mergeBuffers.get(chatId);
    if (!buf) return;
    this.mergeBuffers.delete(chatId);
    clearTimeout(buf.timer);
    const merged = buf.texts.filter((t) => t.length > 0).join('\n\n');
    if (buf.texts.length > 1) {
      this.log.info(
        { chatId, mergedCount: buf.texts.length, totalLen: merged.length },
        'flushing merged rapid-fire batch',
      );
    }
    // 不 await：让定时器线程立即返回，submit 自己排队
    void this.executeKiroTask(
      buf.anchor,
      merged,
      buf.cwd,
      buf.mediaPaths,
      buf.perChatIdleMin,
    ).catch((e) => this.log.error({ err: e, chatId }, 'flush merge buffer execute failed'));
  }

  /**
   * 真正把任务丢到 ChatPipeline 跑 Kiro 的实现（不含 rapid-fire 合并）。
   * - 在 ChatPipeline 里跑（自动 preempt）
   * - 用 RunCardController 流式刷新卡片（每个工具独立 panel）
   * - mediaPaths 非空时，把绝对路径作为前缀加到 prompt 前面
   * - perChatIdleMin 控制本次 idle watchdog 阈值
   */
  private async executeKiroTask(
    msg: IncomingMessage,
    prompt: string,
    cwd: string,
    mediaPaths: string[] = [],
    perChatIdleMin?: number,
  ): Promise<void> {
    const pipeline = this.getPipeline(msg.chatId);
    const taskId = `${msg.eventId || msg.messageId}-${Date.now().toString(36)}`;

    // 拼接 prompt：[系统前缀] + 媒体路径 + 用户文本
    // 系统前缀用于约束 kiro-cli 的工具偏好，避免它默认想 npm install 卡死
    const systemPrefix = this.config.kiro.systemPromptPrefix;
    const userPrompt = mediaPaths.length
      ? mediaPaths.map((p) => `@${p}`).join(' ') + (prompt ? '\n\n' + prompt : '')
      : prompt;
    const finalPrompt = systemPrefix ? `${systemPrefix}\n\n---\n\n${userPrompt}` : userPrompt;

    const idleMin = this.effectiveIdleMinutes(perChatIdleMin);
    const idleTimeoutMs = idleMin > 0 ? idleMin * 60 * 1000 : 0;

    this.log.debug(
      {
        taskId,
        chatId: msg.chatId,
        cwd,
        promptLen: finalPrompt.length,
        promptHead: finalPrompt.slice(0, 120),
        mediaCount: mediaPaths.length,
        idleMin,
      },
      'executeKiroTask start',
    );

    await pipeline.submit({
      id: taskId,
      run: async (signal) => {
        const ctrlOpts: ConstructorParameters<typeof RunCardController>[0] = {
          lark: this.lark,
          chatId: msg.chatId,
          replyToMessageId: msg.messageId,
          intervalMs: this.config.preferences.cardUpdateIntervalMs,
          logger: this.log,
        };
        if (idleMin > 0) ctrlOpts.idleTimeoutMinutes = idleMin;
        const ctrl = new RunCardController(ctrlOpts);
        try {
          await ctrl.open();
        } catch (e) {
          this.log.error({ err: e }, 'failed to open card; aborting task');
          return;
        }

        // 注册到 active-cards 注册表：daemon 异常退出时下次启动可以认领并 finalize
        const cardMessageId = ctrl.getMessageId();
        if (this.activeCards && cardMessageId) {
          await this.activeCards
            .add({
              chatId: msg.chatId,
              messageId: cardMessageId,
              taskId,
              startedAt: Date.now(),
              replyToMessageId: msg.messageId,
            })
            .catch((e) => {
              // 持久化失败不影响主流程；只是失去崩溃恢复能力
              this.log.warn({ err: e, taskId }, 'active-cards add failed (non-fatal)');
            });
        }

        try {
          const resumeId = await this.sessions.getKiroSession(msg.chatId, cwd);

          const runOpts: Parameters<typeof runKiro>[0] = {
            prompt: finalPrompt,
            cwd,
            binPath: this.config.kiro.binPath,
            trustedTools: this.config.kiro.trustedTools,
            timeoutMs: this.config.kiro.timeoutMs,
            idleTimeoutMs,
            signal,
            onChunk: (text) => ctrl.feed(text),
            // 把飞书上下文注入子进程，让 kiro-cli 用 lark-cli 时不用反向搜 chat_id
            extraEnv: {
              LARK_KIRO_CHAT_ID: msg.chatId,
              LARK_KIRO_CHAT_TYPE: msg.chatType,
              LARK_KIRO_SENDER_OPEN_ID: msg.senderOpenId,
            },
          };
          if (resumeId !== undefined) runOpts.resumeId = resumeId;
          if (this.config.kiro.model !== undefined) runOpts.model = this.config.kiro.model;
          if (this.config.kiro.agent !== undefined) runOpts.agent = this.config.kiro.agent;

          let result: Awaited<ReturnType<typeof runKiro>>;
          try {
            result = await runKiro(runOpts);
          } catch (e) {
            await ctrl.finalize('error', (e as Error).message);
            return;
          }

          if (result.aborted) {
            await ctrl.finalize('interrupted');
            return;
          }
          if (result.idleTimedOut) {
            await ctrl.finalize('idle_timeout');
            return;
          }
          if (result.timedOut) {
            // 总超时：保留全部已产出的 blocks（不当 error 处理），用 'timeout' 终态。
            // 用户可以点卡片底部的"继续未完成部分"按钮触发续接。
            await ctrl.finalize('timeout');
            return;
          }
          if (result.exitCode !== 0) {
            await ctrl.finalize('error', `kiro-cli 退出码 ${result.exitCode}`);
            return;
          }

          // 成功：保存新 sessionId 用于续接
          if (result.newSessionId && result.newSessionId !== resumeId) {
            await this.sessions.setKiroSession(msg.chatId, cwd, result.newSessionId);
          }
          await ctrl.finalize('done');
        } finally {
          // 任务终结（任何路径）后从注册表移除；下次启动不会被当孤儿恢复
          if (this.activeCards && cardMessageId) {
            await this.activeCards.remove(msg.chatId, cardMessageId).catch((e) => {
              this.log.warn({ err: e, taskId }, 'active-cards remove failed (non-fatal)');
            });
          }
        }
      },
    });
  }
}

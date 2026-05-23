/**
 * 流式卡片渲染器
 *
 * 一次任务一个 CardRenderer。生命周期：
 *   open() → 发出"⏳ 思考中"的初始卡片，记下 messageId
 *   appendText(chunk) → 累积"真正回复"文本，节流后 patchCard 更新
 *   appendTrace(line) → 累积"工具调用 trace"，跟正文分开存
 *   finalize(state) → 切到终态（done/aborted/timedout/error），刷新一次
 *
 * 设计要点：
 *   - 区分 body（LLM 真正回复）和 traces（工具调用摘要）：
 *     传给 buildCard 时 trace 放折叠面板，不混入正文
 *   - debounce 节流：cardUpdateIntervalMs 内合并所有更新一次 patch
 *   - finalize 时立即取消 debounce，立刻发终态
 */
import type { Logger } from 'pino';
import type { LarkClient } from '../lark/client.js';
import { Debouncer } from '../lib/debounce.js';
import { buildCard, truncateForCard, type CardContext, type CardState } from './schema.js';

export interface CardRendererOptions {
  lark: LarkClient;
  chatId: string;
  /** 用于把卡片作为对原消息的 reply（更友好，挂在用户消息下面） */
  replyToMessageId?: string;
  /** 卡片更新的最小间隔（毫秒） */
  intervalMs: number;
  logger: Logger;
  ctx: CardContext;
}

export class CardRenderer {
  private readonly lark: LarkClient;
  private readonly chatId: string;
  private readonly replyToMessageId?: string;
  private readonly debouncer: Debouncer;
  private readonly log: Logger;
  private ctx: CardContext;

  private messageId: string | null = null;
  /** LLM 的真正回复文本（去掉 trace） */
  private accText = '';
  /** 工具调用 trace 摘要（按出现顺序） */
  private traces: string[] = [];
  private currentState: CardState = 'pending';
  private closed = false;

  constructor(opts: CardRendererOptions) {
    this.lark = opts.lark;
    this.chatId = opts.chatId;
    if (opts.replyToMessageId !== undefined) {
      this.replyToMessageId = opts.replyToMessageId;
    }
    this.debouncer = new Debouncer(opts.intervalMs);
    this.log = opts.logger.child({ module: 'card-renderer' });
    this.ctx = opts.ctx;
  }

  /** 发出初始卡片。必须在 appendText 之前调用一次。 */
  async open(initialState: CardState = 'pending', initialText = ''): Promise<void> {
    this.currentState = initialState;
    this.accText = initialText;
    const card = buildCard(
      initialState,
      truncateForCard(this.accText),
      this.ctx,
      this.traces,
    );
    if (this.replyToMessageId) {
      this.messageId = await this.lark.replyCard(this.replyToMessageId, card);
    } else {
      this.messageId = await this.lark.sendCard(this.chatId, card);
    }
    this.log.debug({ messageId: this.messageId, state: initialState }, 'card opened');
  }

  /** 追加正文文本（LLM 真正的回复），触发节流更新。 */
  appendText(chunk: string): void {
    if (this.closed) return;
    this.accText += chunk;
    if (this.currentState === 'pending') {
      this.currentState = 'streaming';
    }
    this.debouncer.schedule(async () => {
      await this.flush();
    });
  }

  /** 追加一条工具调用 trace 摘要（如 "📖 读取 SKILL.md"）。 */
  appendTrace(line: string): void {
    if (this.closed) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    this.traces.push(trimmed);
    if (this.currentState === 'pending') {
      this.currentState = 'streaming';
    }
    this.debouncer.schedule(async () => {
      await this.flush();
    });
  }

  /** 把当前累积状态立即 patch 到飞书。 */
  private async flush(): Promise<void> {
    if (!this.messageId || this.closed) return;
    const card = buildCard(
      this.currentState,
      truncateForCard(this.accText),
      this.ctx,
      this.traces,
    );
    try {
      await this.lark.patchCard(this.messageId, card);
    } catch (e) {
      this.log.warn({ err: e }, 'patchCard failed; will retry on next chunk');
    }
  }

  /**
   * 切到终态并最后更新一次。
   * @param state 终态：done/aborted/timedout/error
   * @param finalText 如果传入，覆盖现有累积文本（比如错误信息）
   */
  async finalize(state: CardState, finalText?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.debouncer.cancel();
    if (finalText !== undefined) this.accText = finalText;
    this.currentState = state;
    if (!this.messageId) {
      // 罕见情况：open 都没成功，直接 sendText 兜底
      try {
        await this.lark.sendText(this.chatId, this.accText.slice(0, 4000));
      } catch (e) {
        this.log.error({ err: e }, 'fallback sendText failed');
      }
      return;
    }
    const card = buildCard(
      state,
      truncateForCard(this.accText),
      this.ctx,
      this.traces,
    );
    try {
      await this.lark.patchCard(this.messageId, card);
    } catch (e) {
      this.log.error({ err: e }, 'finalize patchCard failed');
    }
  }

  /** 中途切换上下文（比如 /cd 之后 cwd 变了） */
  updateContext(ctx: Partial<CardContext>): void {
    this.ctx = { ...this.ctx, ...ctx };
  }
}

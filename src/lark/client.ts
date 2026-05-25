/**
 * 飞书 SDK 封装
 *
 * 提供两个能力：
 *   1. WebSocket 长连接事件监听（订阅 im.message.receive_v1 + card.action.trigger）
 *   2. 飞书 OpenAPI 调用：发消息、发卡片、更新卡片、查机器人 open_id
 *
 * 与业务层之间通过 onMessage / onCardAction 回调解耦。
 *
 * 日志：把 SDK 内部 logger 通过 createSdkLoggerAdapter 接管到 pino，
 * 终端输出统一带 `module=lark-sdk` 字段，不再混格式。
 */
import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from 'pino';
import { parseIncomingMessage } from './parse.js';
import { parseCardAction } from './cardAction.js';
import { createSdkLoggerAdapter } from '../lib/logger.js';
import type { IncomingMessage, CardActionEvent } from './types.js';

export interface LarkClientOptions {
  appId: string;
  appSecret: string;
  logger: Logger;
}

export class LarkClient {
  readonly appId: string;
  private readonly appSecret: string;
  private readonly log: Logger;
  private readonly sdkLogger!: ReturnType<typeof createSdkLoggerAdapter>;
  readonly api: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private botOpenIdCache: string | null = null;
  /** WebSocket 当前是否在连接状态。`/selftest` 用。*/
  private wsConnectedFlag = false;

  constructor(opts: LarkClientOptions) {
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
    this.log = opts.logger.child({ module: 'lark-client' });
    // 把 pino logger 包成 SDK 期望的 Logger 接口（统一终端输出格式）
    const sdkLogger = createSdkLoggerAdapter(opts.logger);
    this.api = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      disableTokenCache: false,
      // SDK trace 级别在 pino 那边默认不显示；噪声会被适配器自动降级
      loggerLevel: lark.LoggerLevel.trace,
      logger: sdkLogger,
    });
    this.sdkLogger = sdkLogger;
  }

  /**
   * 启动 WebSocket 长连接，注册事件 handler：
   *   - im.message.receive_v1：用户发的消息
   *   - card.action.trigger：用户点了卡片上的按钮
   */
  async startEventLoop(handlers: {
    onMessage: (msg: IncomingMessage) => void | Promise<void>;
    onCardAction?: (evt: CardActionEvent) => void | Promise<void>;
    onReady?: () => void;
    onReconnected?: () => void;
  }): Promise<void> {
    const wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      // 同样用 trace 级别，让 SDK 把所有日志都喂过来；pino 那边按 LARK_KIRO_LOG_LEVEL 过滤
      loggerLevel: lark.LoggerLevel.trace,
      logger: this.sdkLogger,
      onReady: () => {
        this.wsConnectedFlag = true;
        this.log.info('lark websocket connected');
        handlers.onReady?.();
      },
      onReconnecting: () => {
        this.wsConnectedFlag = false;
        this.log.warn('lark websocket reconnecting');
      },
      onReconnected: () => {
        this.wsConnectedFlag = true;
        this.log.info('lark websocket reconnected');
        handlers.onReconnected?.();
      },
      onError: (err) => {
        this.wsConnectedFlag = false;
        this.log.error({ err }, 'lark websocket error');
      },
    });

    // EventDispatcher 也注入同一个适配器，统一 SDK 内部日志格式
    const dispatcher = new lark.EventDispatcher({
      loggerLevel: lark.LoggerLevel.trace,
      logger: this.sdkLogger,
    }).register({
      'im.message.receive_v1': async (data) => {
        // 关键：立刻返回 ack 给飞书；实际处理放后台。
        // 飞书事件订阅是 at-least-once，handler 不在几秒内返回会触发重推，
        // 而 Kiro 跑一次往往要 5–60 秒，必须异步处理。
        try {
          const msg = parseIncomingMessage(data as Parameters<typeof parseIncomingMessage>[0]);
          this.log.info(
            {
              event: 'enter',
              eventId: msg.eventId,
              chatId: msg.chatId,
              senderId: msg.senderOpenId,
              chatType: msg.chatType,
              messageType: msg.messageType,
            },
            'incoming message',
          );
          // 异步 fire-and-forget；onMessage 内部已经做 try/catch 不会泄露异常
          Promise.resolve(handlers.onMessage(msg)).catch((e) => {
            this.log.error({ err: e }, 'onMessage handler threw');
          });
        } catch (e) {
          this.log.error({ err: e }, 'event parse failed');
        }
        return { code: 0 };
      },
      'card.action.trigger': async (data: unknown) => {
        // 用户点了卡片按钮。同样 ack 立返、异步处理。
        try {
          const evt = parseCardAction(data);
          if (!evt) {
            this.log.debug({ raw: data }, 'card.action.trigger: cannot parse, skip');
            return { code: 0 };
          }
          this.log.info(
            {
              event: 'card-action',
              messageId: evt.messageId,
              chatId: evt.chatId,
              senderId: evt.senderOpenId,
              valueKeys: Object.keys(evt.value),
            },
            'card action',
          );
          if (handlers.onCardAction) {
            Promise.resolve(handlers.onCardAction(evt)).catch((e) => {
              this.log.error({ err: e }, 'onCardAction handler threw');
            });
          }
        } catch (e) {
          this.log.error({ err: e }, 'card action parse failed');
        }
        return { code: 0 };
      },
    });

    await wsClient.start({ eventDispatcher: dispatcher });
    this.wsClient = wsClient;
  }

  close(): void {
    this.wsClient?.close();
    this.wsClient = null;
  }

  /**
   * 查询当前机器人在租户里的 open_id（用来识别 @bot）。
   * 应用启动时调用一次后缓存。
   */
  async getBotOpenId(): Promise<string> {
    if (this.botOpenIdCache) return this.botOpenIdCache;
    // 调 bot/v3/info 接口拿 app_id 关联的 bot 信息
    // SDK 路径：client.bot.info.get / client.application... 因版本而异；
    // 实践里最稳的方式是听到第一条 mention 时学习一下。这里先返回空字符串，
    // 调用方应在收到带 @bot 的消息时通过 mentions 学习并缓存。
    return '';
  }

  /** 业务侧主动设置 botOpenId（一般从配置或第一次 @bot 学习而来）。 */
  setBotOpenId(openId: string): void {
    this.botOpenIdCache = openId;
  }

  /**
   * 当前 WebSocket 是否处于连接状态（供 /selftest 等命令查）。
   */
  isWsConnected(): boolean {
    return this.wsConnectedFlag;
  }

  /**
   * 发送一张飞书卡片（v2 协议）。
   * 返回卡片所在消息的 message_id，后续用 patchCard 更新。
   */
  async sendCard(chatId: string, cardJson: object): Promise<string> {
    const resp = await this.api.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(cardJson),
      },
    });
    const messageId = resp.data?.message_id;
    if (!messageId) {
      throw new Error(`sendCard failed, no message_id in response: ${JSON.stringify(resp)}`);
    }
    return messageId;
  }

  /**
   * 回复一条消息（reply 卡片，让卡片挂在用户消息下面）。
   */
  async replyCard(messageId: string, cardJson: object): Promise<string> {
    const resp = await this.api.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(cardJson),
      },
    });
    const newMsgId = resp.data?.message_id;
    if (!newMsgId) {
      throw new Error(`replyCard failed, no message_id in response: ${JSON.stringify(resp)}`);
    }
    return newMsgId;
  }

  /**
   * 用 patch 接口整体替换卡片内容。
   * 飞书消息卡片支持通过 `im/v1/messages/:message_id` PATCH 来更新内容，
   * 内容必须是合法的卡片 JSON 字符串。
   */
  async patchCard(messageId: string, cardJson: object): Promise<void> {
    await this.api.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(cardJson) },
    });
  }

  /** 发送纯文本消息（错误兜底用） */
  async sendText(chatId: string, text: string): Promise<string> {
    const resp = await this.api.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    const messageId = resp.data?.message_id;
    if (!messageId) {
      throw new Error(`sendText failed, no message_id in response: ${JSON.stringify(resp)}`);
    }
    return messageId;
  }
}

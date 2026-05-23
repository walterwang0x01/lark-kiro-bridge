/**
 * 飞书 card.action.trigger 事件解析
 *
 * 飞书 v2 卡片回调结构（节选自官方文档）：
 *   {
 *     "schema": "2.0",
 *     "header": { "event_type": "card.action.trigger", ... },
 *     "event": {
 *       "operator": { "open_id": "...", "user_id": "...", "name": "..." },
 *       "token": "c-xxxxxxxx",                   // 30 分钟内可更新原卡片，最多 2 次
 *       "action": {
 *         "tag": "button",
 *         "value": { ... }                      // 按钮 behaviors 里 callback.value
 *       },
 *       "host": "im_message",
 *       "context": {
 *         "open_message_id": "om_xxx",
 *         "open_chat_id":    "oc_xxx"
 *       }
 *     }
 *   }
 *
 * 真实 SDK 推过来的字段名可能略有差异（snake/camel），本函数尽量兼容。
 */
import type { CardActionEvent } from './types.js';

interface RawAction {
  tag?: string;
  value?: unknown;
  name?: string;
  option?: string;
}

interface RawOperator {
  open_id?: string;
  openId?: string;
  user_id?: string;
  userId?: string;
  name?: string;
}

interface RawContext {
  open_message_id?: string;
  open_chat_id?: string;
}

interface RawCardAction {
  schema?: string;
  header?: { event_type?: string };
  event?: {
    operator?: RawOperator;
    token?: string;
    action?: RawAction;
    context?: RawContext;
    open_message_id?: string;
    open_chat_id?: string;
  };
  // 兜底：旧版可能直接平铺
  operator?: RawOperator;
  token?: string;
  action?: RawAction;
  context?: RawContext;
  open_message_id?: string;
  open_chat_id?: string;
}

/**
 * 把 SDK 推来的原始 data 解析成业务层 CardActionEvent。
 * 解析失败返回 null（调用方会丢弃这条事件）。
 */
export function parseCardAction(raw: unknown): CardActionEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawCardAction;

  // event 嵌套结构优先；旧版/平铺结构兜底
  const ev = r.event ?? r;
  const op = (ev.operator ?? r.operator ?? {}) as RawOperator;
  const action = (ev.action ?? r.action ?? {}) as RawAction;
  const ctx = (ev.context ?? {}) as RawContext;

  const messageId = ctx.open_message_id ?? ev.open_message_id ?? r.open_message_id ?? '';
  const chatId = ctx.open_chat_id ?? ev.open_chat_id ?? r.open_chat_id ?? '';
  const senderOpenId = op.open_id ?? op.openId ?? '';

  if (!messageId || !chatId || !senderOpenId) return null;

  // value 必须是 object；不是的话给个空对象，让上层走"未知按钮"分支
  let value: Record<string, unknown> = {};
  if (action.value && typeof action.value === 'object' && !Array.isArray(action.value)) {
    value = action.value as Record<string, unknown>;
  }

  const result: CardActionEvent = {
    messageId,
    chatId,
    senderOpenId,
    value,
    receivedAt: Date.now(),
  };
  const token = ev.token ?? r.token;
  if (token !== undefined) result.token = token;
  return result;
}

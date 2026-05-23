/**
 * 飞书消息卡片 (interactive card v2) 构造器
 *
 * 视觉设计原则（v0.3）：
 *   - header 紧凑：状态信号靠模板色（绿/蓝/红）传达，title 简短不冗余
 *   - 正文 = LLM 回复本体，trace 摘要折叠到顶部 collapsible_panel，默认关
 *   - 不显示 cwd（信息密度低、占位长），用户要看路径用 /status /pwd
 *   - 工作区名只在显式命名时才显示
 *
 * 卡片状态：
 *   pending   → header "⏳ 思考中" 蓝色
 *   streaming → header "💬 回复中" 蓝色
 *   done      → header "Kiro" 绿色（最终态最纯净）
 *   aborted   → header "已中止" 橙色
 *   timedout  → header "超时" 红色
 *   error     → header "出错" 红色
 *
 * 状态切换由 CardRenderer.update(state, text?, traces?) 触发。
 */
export type CardState = 'pending' | 'streaming' | 'done' | 'aborted' | 'timedout' | 'error';

export interface CardContext {
  cwd: string;
  workspaceName?: string;
  /**
   * 是否在卡片底部显示完整 cwd footer（默认 false，极简风）。
   * /status /pwd 这类用户主动询问的命令在正文里展示路径，不靠 footer。
   */
  showFooter?: boolean;
  /** 会话指示，比如 "🆕 新会话" 或 "↪️ a4f3b2…" */
  sessionStatus?: string;
}

const HEADER_TEMPLATES: Record<CardState, { title: string; template: string }> = {
  // pending/streaming 用蓝色，做出"进行中"的视觉信号
  pending: { title: '⏳ 思考中', template: 'blue' },
  streaming: { title: '💬 回复中', template: 'blue' },
  // 完成态：标题极简就一个 "Kiro"，靠绿色模板色和 ✅ 头像传达成功
  done: { title: 'Kiro', template: 'green' },
  aborted: { title: '已中止', template: 'orange' },
  timedout: { title: '超时', template: 'red' },
  error: { title: '出错', template: 'red' },
};

/**
 * 构造一张完整的卡片 JSON。
 *
 * @param state    当前卡片状态
 * @param body     卡片正文（LLM 真正回复的 markdown）
 * @param ctx      上下文（cwd、工作区名）
 * @param traces   工具调用 trace 摘要（如"📖 读取 x.md"），会折叠展示
 */
export function buildCard(
  state: CardState,
  body: string,
  ctx: CardContext,
  traces?: string[],
): object {
  const header = HEADER_TEMPLATES[state];
  const elements: object[] = [];

  // 顶部 trace 折叠面板：streaming 时默认展开（让用户看到 Kiro 在干活），
  // done 时默认折叠（不喧宾夺主）
  if (traces && traces.length > 0) {
    const isProgressing = state === 'pending' || state === 'streaming';
    elements.push({
      tag: 'collapsible_panel',
      expanded: isProgressing,
      vertical_spacing: 'small',
      padding: '4px 8px',
      header: {
        title: {
          tag: 'markdown',
          content: `<font color='grey'>${
            isProgressing
              ? `⚙️ 工具调用 · ${traces.length} 步`
              : `工具调用 · ${traces.length} 步（点击查看）`
          }</font>`,
        },
        vertical_align: 'center',
        icon: {
          tag: 'standard_icon',
          token: 'down-small-ccm_outlined',
          size: '12px 12px',
        },
        icon_position: 'follow_text',
        icon_expanded_angle: -180,
      },
      elements: traces.map((t) => ({
        tag: 'markdown',
        content: `<font color='grey'>${t}</font>`,
      })),
    });
  }

  // 正文。空字符串时给个占位，避免飞书拒绝空卡片
  const bodyText =
    body.trim() ||
    (state === 'pending' || state === 'streaming'
      ? "<font color='grey'>等待响应…</font>"
      : "<font color='grey'>无输出</font>");
  elements.push({
    tag: 'markdown',
    content: bodyText,
  });

  // 底部 footer：默认隐藏。仅在 ctx.showFooter === true 时显式渲染（运维/调试场景）
  if (ctx.showFooter === true) {
    const segs: string[] = [];
    if (ctx.workspaceName) segs.push(`🗂️ ${ctx.workspaceName}`);
    if (ctx.sessionStatus) segs.push(ctx.sessionStatus);
    if (segs.length) {
      elements.push({
        tag: 'markdown',
        content: `<font color='grey'>${segs.join(' · ')}</font>`,
      });
    }
  }

  // header subtitle：默认不显示。
  const headerObj: Record<string, unknown> = {
    title: { tag: 'plain_text', content: header.title },
    template: header.template,
  };
  if (ctx.showFooter === true) {
    const subtitleSegs: string[] = [];
    if (ctx.workspaceName) subtitleSegs.push(`🗂️ ${ctx.workspaceName}`);
    if (ctx.sessionStatus) subtitleSegs.push(ctx.sessionStatus);
    const subtitle = subtitleSegs.join(' · ');
    if (subtitle) {
      headerObj['subtitle'] = { tag: 'plain_text', content: subtitle };
    }
  }

  return {
    schema: '2.0',
    header: headerObj,
    body: { elements },
  };
}

/**
 * 把流式累积的文本截到飞书卡片可承载的长度。
 * 飞书卡片 element 内容长度上限大约 30k 字节，留点余量截到 20k。
 */
export function truncateForCard(text: string, maxBytes = 20_000): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.byteLength <= maxBytes) return text;
  const cut = buf.subarray(0, maxBytes).toString('utf-8');
  return cut + "\n\n<font color='grey'>…内容超出卡片上限，已截断</font>";
}

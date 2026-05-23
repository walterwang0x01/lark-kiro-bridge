/**
 * 业务卡片构造器（v2 schema）
 *
 * 把"业务命令的回复卡片"按结构化布局重做，跟纯文本 Markdown 的 done 卡片区分开。
 * 这些卡片只在用户主动调命令（/model /help /ws list /status）时呈现，正常对话回复
 * 仍然走 schema.ts 里的 simple done 卡片。
 *
 * 设计原则：
 *   - 用 column_set 表格化对齐，不用 markdown 里堆 ` · `
 *   - 关键操作做成可点 button（behaviors:[{type:'callback'}]) ；二级动作放折叠面板
 *   - 视觉权重：当前选中 ✅、推荐组、其他组分隔
 *   - 按钮 value 统一带 { action: 'xxx', ... }，dispatcher 路由
 */
import type { ModelInfo, ModelListResult } from '../kiro/models.js';

export type ButtonValue = Record<string, unknown>;

/** 标题 + 模板色 + 可选 subtitle */
export interface CardHeader {
  title: string;
  template:
    | 'blue'
    | 'wathet'
    | 'turquoise'
    | 'green'
    | 'yellow'
    | 'orange'
    | 'red'
    | 'carmine'
    | 'violet'
    | 'purple'
    | 'indigo'
    | 'grey';
  subtitle?: string;
  ud_icon?: string;
}

function buildHeader(h: CardHeader): object {
  const out: Record<string, unknown> = {
    title: { tag: 'plain_text', content: h.title },
    template: h.template,
  };
  if (h.subtitle) out['subtitle'] = { tag: 'plain_text', content: h.subtitle };
  return out;
}

/**
 * 构造一个 button 元素（v2）
 *
 * type:
 *   - default       默认黑字带边框
 *   - primary       蓝字带边框
 *   - primary_filled 蓝底白字，最显眼
 *   - text          纯文字按钮，无边框
 *   - danger_text   红字无边框
 */
export function btn(opts: {
  text: string;
  value: ButtonValue;
  type?:
    | 'default'
    | 'primary'
    | 'primary_filled'
    | 'text'
    | 'primary_text'
    | 'danger'
    | 'danger_text'
    | 'danger_filled';
  size?: 'tiny' | 'small' | 'medium' | 'large';
  width?: 'default' | 'fill' | string;
  hoverTip?: string;
  confirm?: { title: string; text: string };
}): object {
  const out: Record<string, unknown> = {
    tag: 'button',
    text: { tag: 'plain_text', content: opts.text },
    type: opts.type ?? 'default',
    size: opts.size ?? 'small',
    width: opts.width ?? 'default',
    behaviors: [{ type: 'callback', value: opts.value }],
  };
  if (opts.hoverTip) {
    out['hover_tips'] = { tag: 'plain_text', content: opts.hoverTip };
  }
  if (opts.confirm) {
    out['confirm'] = {
      title: { tag: 'plain_text', content: opts.confirm.title },
      text: { tag: 'plain_text', content: opts.confirm.text },
    };
  }
  return out;
}

function md(content: string, textAlign: 'left' | 'center' | 'right' = 'left'): object {
  return { tag: 'markdown', content, text_align: textAlign };
}

function hr(): object {
  return { tag: 'hr' };
}

interface ColumnOpts {
  weight?: number;
  width?: 'auto' | 'weighted' | string;
  vAlign?: 'top' | 'center' | 'bottom';
  elements: object[];
}

function column(opts: ColumnOpts): object {
  return {
    tag: 'column',
    width: opts.width ?? 'weighted',
    weight: opts.weight ?? 1,
    vertical_align: opts.vAlign ?? 'center',
    elements: opts.elements,
  };
}

interface ColumnSetOpts {
  flexMode?: 'none' | 'stretch' | 'flow' | 'bisect' | 'trisect';
  background?: string;
  horizontalSpacing?: 'default' | 'small' | 'large' | string;
  columns: object[];
}

function columnSet(opts: ColumnSetOpts): object {
  return {
    tag: 'column_set',
    flex_mode: opts.flexMode ?? 'none',
    background_style: opts.background ?? 'default',
    horizontal_spacing: opts.horizontalSpacing ?? 'default',
    columns: opts.columns,
  };
}

// ----- 业务卡片 -----

/**
 * 模型选择卡片
 *
 * 视觉策略：
 *   - 推荐组（auto + 主力 3 个）默认展开
 *   - 其他模型（实验性 + 旧版）放进一个默认折叠的 collapsible_panel
 *   - 行间距压到 small (4px)，13 个模型时折叠后视觉占位 ~200px（vs 全展开 600px）
 *   - 名字短化（去 claude- 前缀），第三列直接显示 "/m xxx" 命令
 */
export function buildModelPickerCard(opts: {
  current: string;
  list: ModelListResult;
}): object {
  const { current, list } = opts;
  const groups = groupModels(list.models);
  const elements: object[] = [];

  // 渲染单行模型
  const renderModelRow = (m: ModelInfo): object => {
    const isCurrent = m.name === current;
    const ctxLabel =
      m.contextWindow >= 1_000_000
        ? '1M'
        : m.contextWindow >= 1000
          ? `${Math.round(m.contextWindow / 1000)}K`
          : `${m.contextWindow}`;
    const rateLabel = `${m.rateMultiplier}×`;
    const shortName = m.name.replace(/^claude-/, '');
    const namePart = isCurrent
      ? `**✓ ${shortName}**`
      : `\u3000${shortName}`;
    return columnSet({
      flexMode: 'none',
      horizontalSpacing: 'small',
      columns: [
        column({ weight: 5, elements: [md(namePart)] }),
        column({
          weight: 3,
          elements: [
            md(`<font color='grey'>${rateLabel} · ${ctxLabel}</font>`, 'right'),
          ],
        }),
        column({
          weight: 2,
          vAlign: 'center',
          elements: [
            isCurrent
              ? md(`<font color='green'>**当前**</font>`, 'right')
              : btn({
                  text: '选用',
                  type: 'primary',
                  size: 'tiny',
                  value: { action: 'model.set', name: m.name },
                  hoverTip: m.description || m.name,
                }),
          ],
        }),
      ],
    });
  };

  // 推荐组：直接展示
  for (const m of groups.recommended) {
    elements.push(renderModelRow(m));
  }

  // 其他模型合并到一个折叠面板
  const otherModels = [...groups.experimental, ...groups.legacy];
  if (otherModels.length > 0) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      vertical_spacing: 'small',
      padding: '4px 8px',
      header: {
        title: {
          tag: 'markdown',
          content: `<font color='grey'>展开其他 ${otherModels.length} 个模型（实验性 / 第三方 / 旧版）</font>`,
        },
        vertical_align: 'center',
        icon: {
          tag: 'standard_icon',
          token: 'down-small-ccm_outlined',
          size: '14px 14px',
        },
        icon_position: 'follow_text',
        icon_expanded_angle: -180,
      },
      elements: otherModels.map((m) => renderModelRow(m)),
    });
  }

  elements.push(
    columnSet({
      flexMode: 'flow',
      horizontalSpacing: 'small',
      columns: [
        column({
          width: 'auto',
          elements: [
            btn({
              text: '↺ 恢复默认',
              type: 'default',
              size: 'tiny',
              value: { action: 'model.reset' },
              hoverTip: '清除模型覆盖，回归 kiro-cli 默认（auto）',
            }),
          ],
        }),
        column({
          width: 'auto',
          elements: [
            btn({
              text: '🔄 刷新',
              type: 'default',
              size: 'tiny',
              value: { action: 'model.refresh' },
              hoverTip: '清缓存重新查询模型列表',
            }),
          ],
        }),
      ],
    }),
  );

  return {
    schema: '2.0',
    header: buildHeader({
      title: '🎛️ 选择模型',
      template: 'blue',
      subtitle: `当前 · ${current.replace(/^claude-/, '')}`,
    }),
    body: { elements },
  };
}

/**
 * 模型分组：
 *   - recommended：auto + 各家最新主力 + 最便宜的 haiku
 *   - experimental：preview / 第三方
 *   - legacy：旧版本
 */
function groupModels(models: ModelInfo[]): {
  recommended: ModelInfo[];
  experimental: ModelInfo[];
  legacy: ModelInfo[];
} {
  const recommended: ModelInfo[] = [];
  const experimental: ModelInfo[] = [];
  const legacy: ModelInfo[] = [];

  // 启发式：先按 name 模式归类
  for (const m of models) {
    const name = m.name.toLowerCase();
    const desc = (m.description || '').toLowerCase();
    if (name === 'auto') {
      recommended.unshift(m); // auto 永远第一
      continue;
    }
    if (desc.includes('experimental') || desc.includes('preview')) {
      experimental.push(m);
      continue;
    }
    // 第三方厂商默认归实验性（除了 GLM 这种主力）
    if (
      name.startsWith('deepseek') ||
      name.startsWith('minimax') ||
      name.startsWith('glm') ||
      name.startsWith('qwen')
    ) {
      experimental.push(m);
      continue;
    }
    // claude 系列：sonnet-4.6 / opus-4.6 / haiku-4.5 是当前主力，其余视作 legacy
    if (
      name === 'claude-sonnet-4.6' ||
      name === 'claude-opus-4.6' ||
      name === 'claude-haiku-4.5'
    ) {
      recommended.push(m);
      continue;
    }
    legacy.push(m);
  }

  return { recommended, experimental, legacy };
}

/**
 * /help 卡片
 *
 * 视觉策略：
 *   - 默认只展示「会话」3 条核心命令
 *   - 「工作目录」和「运维」放进折叠面板，需要时再展开
 *   - 顶部一句简短介绍
 */
export function buildHelpCard(): object {
  const sec = (items: Array<[string, string]>): object[] =>
    items.map(([cmd, desc]) =>
      columnSet({
        flexMode: 'none',
        horizontalSpacing: 'small',
        columns: [
          column({ weight: 3, elements: [md(`\`${cmd}\``)] }),
          column({
            weight: 5,
            elements: [md(`<font color='grey'>${desc}</font>`)],
          }),
        ],
      }),
    );

  const collapsed = (title: string, items: Array<[string, string]>): object => ({
    tag: 'collapsible_panel',
    expanded: false,
    vertical_spacing: 'small',
    padding: '4px 8px',
    header: {
      title: {
        tag: 'markdown',
        content: `<font color='grey'>${title}</font>`,
      },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '14px 14px',
      },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    elements: sec(items),
  });

  const elements: object[] = [
    md('在飞书里调用本地 Kiro CLI，每个对话独立 session。'),
    ...sec([
      ['/new', '重置当前会话'],
      ['/status', '查看 cwd / session / watchdog'],
      ['/stop', '停止正在跑的任务'],
      ['/model · /m', '查看 / 切换模型'],
    ]),
    collapsed('展开：工作目录 & 工作区', [
      ['/pwd', '查看当前目录'],
      ['/cd <path>', '切换目录（白名单内）'],
      ['/ws list', '列出命名工作区'],
      ['/ws save <name>', '把当前 cwd 存为工作区'],
      ['/ws use <name>', '切到命名工作区'],
    ]),
    collapsed('展开：运维', [
      ['/timeout [N|off]', 'idle watchdog 阈值'],
      ['/reconnect', '重连飞书 WebSocket'],
      ['/doctor [描述]', '看日志自诊断'],
    ]),
    hr(),
    columnSet({
      flexMode: 'flow',
      horizontalSpacing: 'small',
      columns: [
        column({
          width: 'auto',
          elements: [
            btn({
              text: '📊 状态',
              type: 'default',
              size: 'tiny',
              value: { action: 'session.status' },
            }),
          ],
        }),
        column({
          width: 'auto',
          elements: [
            btn({
              text: '🎛️ 模型',
              type: 'default',
              size: 'tiny',
              value: { action: 'model.show' },
            }),
          ],
        }),
        column({
          width: 'auto',
          elements: [
            btn({
              text: '🗂️ 工作区',
              type: 'default',
              size: 'tiny',
              value: { action: 'ws.list' },
            }),
          ],
        }),
        column({
          width: 'auto',
          elements: [
            btn({
              text: '🔄 重置会话',
              type: 'default',
              size: 'tiny',
              value: { action: 'session.new' },
              confirm: {
                title: '重置会话',
                text: '将清空当前 cwd 下的 Kiro 会话历史。下条消息会新建 session。',
              },
            }),
          ],
        }),
      ],
    }),
  ];
  return {
    schema: '2.0',
    header: buildHeader({ title: '📖 命令帮助', template: 'blue' }),
    body: { elements },
  };
}

/**
 * 命名工作区列表卡片
 *
 * 每行：[名字]   [短路径]  [使用按钮]
 */
export function buildWorkspaceListCard(opts: {
  workspaces: Record<string, string>;
  currentCwd: string;
}): object {
  const entries = Object.entries(opts.workspaces);
  const elements: object[] = [];

  if (entries.length === 0) {
    elements.push(
      md(
        '_当前没有命名工作区。_\n\n用 `/ws save <name>` 把当前目录存为工作区，方便后续 `/ws use <name>` 一键切换。',
      ),
    );
    return {
      schema: '2.0',
      header: buildHeader({ title: '🗂️ 命名工作区', template: 'blue' }),
      body: { elements },
    };
  }

  for (const [name, path] of entries) {
    const isCurrent = path === opts.currentCwd;
    const shortPath = shortenPath(path, 40);
    elements.push(
      columnSet({
        flexMode: 'none',
        horizontalSpacing: 'small',
        columns: [
          column({
            weight: 3,
            elements: [
              md(isCurrent ? `**✓ ${name}**` : `\u3000${name}`),
            ],
          }),
          column({
            weight: 4,
            elements: [
              md(
                `<font color='grey'>${shortPath}</font>`,
                'right',
              ),
            ],
          }),
          column({
            weight: 2,
            vAlign: 'center',
            elements: [
              isCurrent
                ? md(`<font color='green'>**当前**</font>`, 'right')
                : btn({
                    text: '切换',
                    type: 'primary',
                    size: 'tiny',
                    value: { action: 'ws.use', name },
                    hoverTip: path,
                  }),
            ],
          }),
        ],
      }),
    );
  }

  elements.push(hr());
  elements.push(
    md(
      '<font color="grey">💡 用 `/ws save <name>` 添加，`/ws remove <name>` 删除。</font>',
    ),
  );
  return {
    schema: '2.0',
    header: buildHeader({
      title: '🗂️ 命名工作区',
      template: 'blue',
      subtitle: `${entries.length} 个`,
    }),
    body: { elements },
  };
}

/**
 * /status 卡片
 *
 * 把 cwd / session / 工作区 / watchdog 用列表展示，附几个常用按钮。
 */
export function buildStatusCard(opts: {
  cwd: string;
  workspaceName?: string;
  kiroSessionId?: string;
  hasActiveTask: boolean;
  idleMinutes: number;
  isPerChatOverride: boolean;
}): object {
  const elements: object[] = [];
  const row = (label: string, val: string): object =>
    columnSet({
      flexMode: 'none',
      horizontalSpacing: 'small',
      columns: [
        column({
          weight: 2,
          elements: [md(`<font color='grey'>${label}</font>`)],
        }),
        column({ weight: 5, elements: [md(val)] }),
      ],
    });

  elements.push(row('当前目录', `\`${opts.cwd}\``));
  if (opts.workspaceName) {
    elements.push(row('工作区', `🗂️ \`${opts.workspaceName}\``));
  }
  elements.push(
    row(
      'Kiro session',
      opts.kiroSessionId
        ? `↪️ \`${opts.kiroSessionId.slice(0, 8)}…\``
        : '_未建立，下条消息会新建_',
    ),
  );
  elements.push(
    row('任务状态', opts.hasActiveTask ? '🟢 进行中' : '⚪ 空闲'),
  );
  elements.push(
    row(
      'Idle watchdog',
      opts.idleMinutes > 0
        ? `${opts.idleMinutes} 分钟${opts.isPerChatOverride ? '（per-chat 覆盖）' : ''}`
        : '关闭',
    ),
  );
  elements.push(hr());
  elements.push(
    columnSet({
      flexMode: 'flow',
      horizontalSpacing: 'small',
      columns: [
        column({
          width: 'auto',
          elements: [
            btn({
              text: '🔄 重置会话',
              type: 'default',
              size: 'tiny',
              value: { action: 'session.new' },
              confirm: {
                title: '重置会话',
                text: '将清空当前 cwd 下的 Kiro 会话历史。下条消息会新建 session。',
              },
            }),
          ],
        }),
        ...(opts.hasActiveTask
          ? [
              column({
                width: 'auto',
                elements: [
                  btn({
                    text: '⏹ 停止任务',
                    type: 'danger',
                    size: 'tiny',
                    value: { action: 'session.stop' },
                  }),
                ],
              }),
            ]
          : []),
        column({
          width: 'auto',
          elements: [
            btn({
              text: '🎛️ 模型',
              type: 'default',
              size: 'tiny',
              value: { action: 'model.show' },
            }),
          ],
        }),
        column({
          width: 'auto',
          elements: [
            btn({
              text: '🗂️ 工作区',
              type: 'default',
              size: 'tiny',
              value: { action: 'ws.list' },
            }),
          ],
        }),
      ],
    }),
  );

  return {
    schema: '2.0',
    header: buildHeader({
      title: '📊 当前状态',
      template: 'green',
      ...(opts.workspaceName ? { subtitle: `🗂️ ${opts.workspaceName}` } : {}),
    }),
    body: { elements },
  };
}

/**
 * 极简成功 / 错误卡片（命令操作回执用）
 * 比 schema.ts 的 done 卡片轻——只有一行 markdown，没有 footer 干扰。
 *
 * @param title 自定义标题；不传则按 state 用通用标题
 */
export function buildAckCard(opts: {
  state: 'done' | 'error' | 'aborted';
  body: string;
  title?: string;
}): object {
  const tmpl: Record<typeof opts.state, { title: string; template: CardHeader['template'] }> = {
    done: { title: '✅ 已完成', template: 'green' },
    error: { title: '❌ 出错', template: 'red' },
    aborted: { title: '⏹ 已中止', template: 'orange' },
  };
  const { template } = tmpl[opts.state];
  const title = opts.title ?? tmpl[opts.state].title;
  return {
    schema: '2.0',
    header: buildHeader({ title, template }),
    body: { elements: [md(opts.body)] },
  };
}

/**
 * 加载中占位卡片（命令型快速反馈）
 *
 * 命令处理中需要 spawn 子进程或调远程 API 时，先发这张卡让用户看到反馈，
 * 真正结果出来后用 patchCard 替换。
 */
export function buildLoadingCard(message = '处理中…', title = '⏳ 处理中'): object {
  return {
    schema: '2.0',
    header: buildHeader({ title, template: 'wathet' }),
    body: { elements: [md(message)] },
  };
}

// ----- 工具 -----

function shortenPath(p: string, maxLen: number): string {
  if (p.length <= maxLen) return p;
  // 保留最后两段
  const segs = p.split('/').filter(Boolean);
  if (segs.length <= 2) return '…' + p.slice(-(maxLen - 1));
  return '…/' + segs.slice(-2).join('/');
}

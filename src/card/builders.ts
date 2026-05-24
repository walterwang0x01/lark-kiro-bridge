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
export function buildModelPickerCard(opts: { current: string; list: ModelListResult }): object {
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
    const namePart = isCurrent ? `**✓ ${shortName}**` : `\u3000${shortName}`;
    return columnSet({
      flexMode: 'none',
      horizontalSpacing: 'small',
      columns: [
        column({ weight: 5, elements: [md(namePart)] }),
        column({
          weight: 3,
          elements: [md(`<font color='grey'>${rateLabel} · ${ctxLabel}</font>`, 'right')],
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
    if (name === 'claude-sonnet-4.6' || name === 'claude-opus-4.6' || name === 'claude-haiku-4.5') {
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
      ['/config', '查看 / 编辑访问控制 + 偏好（管理员）'],
      ['/steering', '管理 Kiro steering（指令文件）'],
      ['/cron', '管理定时任务'],
      ['/ps', '列出本机所有 bridge 进程'],
      ['/exit <id>', '停止指定进程（管理员）'],
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
            elements: [md(isCurrent ? `**✓ ${name}**` : `\u3000${name}`)],
          }),
          column({
            weight: 4,
            elements: [md(`<font color='grey'>${shortPath}</font>`, 'right')],
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
    md('<font color="grey">💡 用 `/ws save <name>` 添加，`/ws remove <name>` 删除。</font>'),
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
      opts.kiroSessionId ? `↪️ \`${opts.kiroSessionId.slice(0, 8)}…\`` : '_未建立，下条消息会新建_',
    ),
  );
  elements.push(row('任务状态', opts.hasActiveTask ? '🟢 进行中' : '⚪ 空闲'));
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

// ----- /config 卡片 -----

/**
 * /config 只读视图。展示访问控制 + 偏好的当前值，提供"编辑"按钮跳到表单卡片。
 *
 * 设计：默认是只读卡片，编辑入口收在右下角，避免普通用户误改。
 */
export function buildConfigViewCard(opts: {
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  requireMentionInGroup: boolean;
  idleTimeoutMinutes: number;
  cardUpdateIntervalMs: number;
  isAdmin: boolean;
}): object {
  const elements: object[] = [];

  const list = (xs: string[], emptyHint: string): string => {
    if (xs.length === 0) return `<font color='grey'>${emptyHint}</font>`;
    return xs.map((x) => `\`${x}\``).join('、');
  };

  const row = (label: string, value: string): object =>
    columnSet({
      flexMode: 'none',
      horizontalSpacing: 'small',
      columns: [
        column({ weight: 2, elements: [md(`<font color='grey'>${label}</font>`)] }),
        column({ weight: 5, elements: [md(value)] }),
      ],
    });

  elements.push(md('**🔐 访问控制**'));
  elements.push(row('允许的用户', list(opts.allowedUsers, '空 = 所有用户')));
  elements.push(row('允许的群', list(opts.allowedChats, '空 = 所有群（DM 永远豁免）')));
  elements.push(row('管理员', list(opts.admins, '空 = 所有用户都是 admin')));
  elements.push(hr());
  elements.push(md('**⚙️ 偏好**'));
  elements.push(row('群里需要 @bot', opts.requireMentionInGroup ? '✓ 是' : '× 否'));
  elements.push(
    row(
      'Idle watchdog（默认）',
      opts.idleTimeoutMinutes > 0 ? `${opts.idleTimeoutMinutes} 分钟` : '关闭',
    ),
  );
  elements.push(row('卡片更新间隔', `${opts.cardUpdateIntervalMs}ms`));
  elements.push(hr());

  // 编辑入口：只对 admin 显示
  if (opts.isAdmin) {
    elements.push(
      columnSet({
        flexMode: 'flow',
        horizontalSpacing: 'small',
        columns: [
          column({
            width: 'auto',
            elements: [
              btn({
                text: '✏️ 编辑配置',
                type: 'primary',
                size: 'tiny',
                value: { action: 'config.edit' },
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
                value: { action: 'config.show' },
              }),
            ],
          }),
        ],
      }),
    );
  } else {
    elements.push(md('<font color="grey">仅管理员可编辑配置</font>'));
  }

  return {
    schema: '2.0',
    header: buildHeader({ title: '⚙️ 当前配置', template: 'wathet' }),
    body: { elements },
  };
}

/**
 * /config 编辑表单。
 *
 * 交互：所有 input 以**逗号分隔**接收 open_id / chat_id 列表，
 * 复杂转义不在 IM 文本框里搞了——简单粗暴最实用。
 *
 * 提交动作 value = { action: 'config.submit' }
 * 表单 form_value 字段：
 *   - allowedUsers: 逗号分隔
 *   - allowedChats: 逗号分隔
 *   - admins: 逗号分隔
 *   - requireMentionInGroup: 'yes' | 'no'
 *   - idleTimeoutMinutes: 整数（0=关）
 */
export function buildConfigFormCard(opts: {
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  requireMentionInGroup: boolean;
  idleTimeoutMinutes: number;
}): object {
  const csv = (xs: string[]): string => xs.join(', ');

  const inputElement = (name: string, label: string, value: string, placeholder: string): object =>
    columnSet({
      flexMode: 'none',
      horizontalSpacing: 'small',
      columns: [
        column({ weight: 2, elements: [md(`<font color='grey'>${label}</font>`)] }),
        column({
          weight: 5,
          elements: [
            {
              tag: 'input',
              name,
              default_value: value,
              placeholder: { tag: 'plain_text', content: placeholder },
              width: 'fill',
            },
          ],
        }),
      ],
    });

  const radioElement = (name: string, label: string, current: 'yes' | 'no'): object =>
    columnSet({
      flexMode: 'none',
      horizontalSpacing: 'small',
      columns: [
        column({ weight: 2, elements: [md(`<font color='grey'>${label}</font>`)] }),
        column({
          weight: 5,
          elements: [
            {
              tag: 'select_static',
              name,
              initial_option: current,
              options: [
                { text: { tag: 'plain_text', content: '是' }, value: 'yes' },
                { text: { tag: 'plain_text', content: '否' }, value: 'no' },
              ],
              width: 'fill',
            },
          ],
        }),
      ],
    });

  const elements: object[] = [
    md('**🔐 访问控制** — 逗号分隔多个 ID。空 = 不限制。'),
    inputElement('allowedUsers', '允许的用户', csv(opts.allowedUsers), 'ou_xxx, ou_yyy'),
    inputElement(
      'allowedChats',
      '允许的群',
      csv(opts.allowedChats),
      'oc_xxx, oc_yyy（DM 永远豁免）',
    ),
    inputElement('admins', '管理员', csv(opts.admins), 'ou_xxx'),
    hr(),
    md('**⚙️ 偏好**'),
    radioElement('requireMentionInGroup', '群里要 @bot', opts.requireMentionInGroup ? 'yes' : 'no'),
    inputElement(
      'idleTimeoutMinutes',
      'Idle watchdog（分钟）',
      String(opts.idleTimeoutMinutes),
      '0 = 关闭',
    ),
    hr(),
    columnSet({
      flexMode: 'flow',
      horizontalSpacing: 'small',
      columns: [
        column({
          width: 'auto',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '💾 保存' },
              type: 'primary_filled',
              size: 'small',
              behaviors: [
                {
                  type: 'callback',
                  value: { action: 'config.submit' },
                },
              ],
              form_action_type: 'submit',
            },
          ],
        }),
        column({
          width: 'auto',
          elements: [
            btn({
              text: '取消',
              type: 'default',
              size: 'small',
              value: { action: 'config.show' },
            }),
          ],
        }),
        column({
          width: 'auto',
          elements: [
            md('<font color="grey">💡 找 open_id：发条消息后查 `~/.lark-kiro-bridge/logs/`</font>'),
          ],
        }),
      ],
    }),
  ];

  return {
    schema: '2.0',
    header: buildHeader({ title: '✏️ 编辑配置', template: 'blue' }),
    body: {
      elements: [
        {
          tag: 'form',
          name: 'config_form',
          elements,
        },
      ],
    },
  };
}

// ----- /ps 卡片 -----

/**
 * /ps 卡片：列出本机所有正在跑的 bridge 进程。
 *
 * 视觉策略：
 *   - 当前回复消息的进程标记 ★（这条消息从这个进程出来）
 *   - 每行展示 #N + 短 id + pid + 启动时间 + cwd
 *   - 每行带「停止」按钮（admin only）
 */
export function buildPsCard(opts: {
  processes: Array<{
    pid: number;
    shortId: string;
    appId: string;
    startedAt: number;
    cwd: string;
  }>;
  selfPid: number;
}): object {
  const { processes, selfPid } = opts;
  const elements: object[] = [];

  if (processes.length === 0) {
    elements.push(md('_当前主机没有 bridge 进程在跑。_'));
    return {
      schema: '2.0',
      header: buildHeader({ title: '🖥️ 主机进程', template: 'wathet' }),
      body: { elements },
    };
  }

  processes.forEach((p, i) => {
    const isSelf = p.pid === selfPid;
    const num = `#${i + 1}`;
    const started = new Date(p.startedAt).toLocaleString('zh-CN', {
      hour12: false,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const shortCwd = shortenPath(p.cwd, 35);
    const tag = isSelf ? '<font color="green">★ 当前</font>' : '';

    elements.push(
      columnSet({
        flexMode: 'none',
        horizontalSpacing: 'small',
        columns: [
          column({
            weight: 1,
            elements: [md(`<font color='grey'>${num}</font>`)],
          }),
          column({
            weight: 4,
            elements: [md(`\`${p.shortId}\` · pid \`${p.pid}\` ${tag}`.trim())],
          }),
          column({
            weight: 4,
            elements: [
              md(`<font color='grey'>${started}</font><br><font color='grey'>${shortCwd}</font>`),
            ],
          }),
          column({
            weight: 2,
            vAlign: 'center',
            elements: [
              btn({
                text: isSelf ? '退出' : '停止',
                type: isSelf ? 'default' : 'danger',
                size: 'tiny',
                value: { action: 'process.stop', target: p.shortId },
                hoverTip: isSelf
                  ? '优雅停止当前进程（机器人会停止响应）'
                  : `SIGTERM 进程 pid ${p.pid}`,
                confirm: {
                  title: isSelf ? '退出当前进程' : '停止进程',
                  text: isSelf
                    ? '将停止当前正在响应你的 bridge。如果有 daemon 守护，会自动重启。'
                    : `向 pid ${p.pid} 发 SIGTERM。该进程会优雅退出。`,
                },
              }),
            ],
          }),
        ],
      }),
    );
  });

  elements.push(hr());
  elements.push(
    md('<font color="grey">💡 多个进程跑同一个飞书 app 时，事件会被随机路由——只保留一个</font>'),
  );

  return {
    schema: '2.0',
    header: buildHeader({
      title: '🖥️ 主机进程',
      template: 'wathet',
      subtitle: `${processes.length} 个`,
    }),
    body: { elements },
  };
}

// ----- /steering（memory）卡片 -----

/**
 * /steering list 卡片：列出当前 scope 的所有 steering 文件。
 *
 * 视觉策略：
 *   - 每行：文件名 + inclusion + 大小 + [查看][编辑][删除] 按钮
 *   - header 显示 scope（global / project）
 *   - 底部一个「📝 新建」按钮
 */
export function buildMemoryListCard(opts: {
  scope: 'global' | 'project';
  cwd: string;
  files: Array<{ name: string; inclusion: string; size: number }>;
  isAdmin: boolean;
}): object {
  const elements: object[] = [];
  const scopeLabel =
    opts.scope === 'global' ? '全局（~/.kiro/steering/）' : `项目（${opts.cwd}/.kiro/steering/）`;
  elements.push(md(`<font color='grey'>位置：${scopeLabel}</font>`));

  if (opts.files.length === 0) {
    elements.push(
      md(
        `_这里还没有 steering 文件。_\n\n点 **📝 新建** 添加，或在终端 \`echo '...' > ${opts.scope === 'global' ? '~/.kiro/steering/foo.md' : '.kiro/steering/foo.md'}\` 创建。`,
      ),
    );
  } else {
    for (const f of opts.files) {
      const inclusionTag =
        f.inclusion === 'always'
          ? `<font color='green'>always</font>`
          : f.inclusion === 'manual'
            ? `<font color='grey'>manual</font>`
            : `<font color='orange'>${f.inclusion}</font>`;
      const sizeStr = f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`;
      elements.push(
        columnSet({
          flexMode: 'none',
          horizontalSpacing: 'small',
          columns: [
            column({
              weight: 5,
              elements: [
                md(`\`${f.name}\` · ${inclusionTag} · <font color='grey'>${sizeStr}</font>`),
              ],
            }),
            column({
              weight: 2,
              vAlign: 'center',
              elements: [
                btn({
                  text: '查看',
                  type: 'default',
                  size: 'tiny',
                  value: { action: 'steering.view', scope: opts.scope, name: f.name },
                }),
              ],
            }),
            ...(opts.isAdmin
              ? [
                  column({
                    weight: 2,
                    vAlign: 'center',
                    elements: [
                      btn({
                        text: '编辑',
                        type: 'primary',
                        size: 'tiny',
                        value: { action: 'steering.edit', scope: opts.scope, name: f.name },
                      }),
                    ],
                  }),
                  column({
                    weight: 2,
                    vAlign: 'center',
                    elements: [
                      btn({
                        text: '删除',
                        type: 'danger',
                        size: 'tiny',
                        value: { action: 'steering.rm', scope: opts.scope, name: f.name },
                        confirm: {
                          title: '删除 steering 文件',
                          text: `确认删除 ${f.name}？此操作不可撤销。`,
                        },
                      }),
                    ],
                  }),
                ]
              : []),
          ],
        }),
      );
    }
  }

  elements.push(hr());
  // 底部操作栏
  const footerCols: object[] = [];
  // scope 切换按钮
  footerCols.push(
    column({
      width: 'auto',
      elements: [
        btn({
          text: opts.scope === 'global' ? '↩ 切到项目' : '🌐 切到全局',
          type: 'default',
          size: 'tiny',
          value: {
            action: 'steering.list',
            scope: opts.scope === 'global' ? 'project' : 'global',
          },
        }),
      ],
    }),
  );
  if (opts.isAdmin) {
    footerCols.push(
      column({
        width: 'auto',
        elements: [
          btn({
            text: '📝 新建',
            type: 'primary',
            size: 'tiny',
            value: { action: 'steering.newPrompt', scope: opts.scope },
          }),
        ],
      }),
    );
  }
  footerCols.push(
    column({
      width: 'auto',
      elements: [
        btn({
          text: '🔄 刷新',
          type: 'default',
          size: 'tiny',
          value: { action: 'steering.list', scope: opts.scope },
        }),
      ],
    }),
  );
  elements.push(columnSet({ flexMode: 'flow', horizontalSpacing: 'small', columns: footerCols }));

  return {
    schema: '2.0',
    header: buildHeader({
      title: '🧠 Kiro Steering',
      template: 'wathet',
      subtitle: opts.scope === 'global' ? '全局' : '项目级',
    }),
    body: { elements },
  };
}

/**
 * /steering view 卡片：展示某个 steering 文件的内容。
 *
 * 设计：
 *   - 用 markdown code block 展示原始内容
 *   - 太长（>3000 字符）截短并提示
 *   - admin 看到「编辑」按钮
 */
export function buildMemoryViewCard(opts: {
  scope: 'global' | 'project';
  name: string;
  content: string;
  isAdmin: boolean;
}): object {
  const elements: object[] = [];
  const MAX_VIEW = 3000;
  const truncated = opts.content.length > MAX_VIEW;
  const shown = truncated ? opts.content.slice(0, MAX_VIEW) + '\n\n... [已截短]' : opts.content;

  elements.push(md(`\`\`\`markdown\n${shown}\n\`\`\``));
  if (truncated) {
    elements.push(
      md(
        `<font color='orange'>⚠️ 文件超过 3000 字符，已截短展示。完整内容请用本地编辑器打开：\`${opts.scope === 'global' ? '~/.kiro/steering/' : '.kiro/steering/'}${opts.name}\`</font>`,
      ),
    );
  }
  elements.push(hr());
  const buttons: object[] = [
    column({
      width: 'auto',
      elements: [
        btn({
          text: '↩ 返回列表',
          type: 'default',
          size: 'tiny',
          value: { action: 'steering.list', scope: opts.scope },
        }),
      ],
    }),
  ];
  if (opts.isAdmin && !truncated) {
    buttons.push(
      column({
        width: 'auto',
        elements: [
          btn({
            text: '✏️ 编辑',
            type: 'primary',
            size: 'tiny',
            value: { action: 'steering.edit', scope: opts.scope, name: opts.name },
          }),
        ],
      }),
    );
  }
  if (opts.isAdmin) {
    buttons.push(
      column({
        width: 'auto',
        elements: [
          btn({
            text: '🗑️ 删除',
            type: 'danger',
            size: 'tiny',
            value: { action: 'steering.rm', scope: opts.scope, name: opts.name },
            confirm: {
              title: '删除 steering 文件',
              text: `确认删除 ${opts.name}？此操作不可撤销。`,
            },
          }),
        ],
      }),
    );
  }
  elements.push(columnSet({ flexMode: 'flow', horizontalSpacing: 'small', columns: buttons }));

  return {
    schema: '2.0',
    header: buildHeader({
      title: `🧠 ${opts.name}`,
      template: 'wathet',
      subtitle: opts.scope === 'global' ? '全局 steering' : '项目 steering',
    }),
    body: { elements },
  };
}

/**
 * /steering edit/new 卡片：表单。
 *
 * 用 飞书 v2 的 input（multi-line）来支持长文本。
 *   - default_value: 现有内容（new 时空）
 *   - max_length: 5000（飞书 multi-line 上限保险值）
 *
 * 提交动作 value = { action: 'steering.submit', scope, name, isNew }
 */
export function buildMemoryEditFormCard(opts: {
  scope: 'global' | 'project';
  name: string;
  content: string;
  isNew: boolean;
}): object {
  const elements: object[] = [
    md(
      opts.isNew
        ? `**新建 steering 文件** \`${opts.name}\`（${opts.scope === 'global' ? '全局' : '项目'}）`
        : `**编辑** \`${opts.name}\`（${opts.scope === 'global' ? '全局' : '项目'}）`,
    ),
    md(
      '<font color="grey">💡 文件用 markdown 格式。可选 frontmatter 控制加载策略：`inclusion: always|manual|fileMatch`</font>',
    ),
    {
      tag: 'input',
      name: 'content',
      input_type: 'multiline',
      default_value: opts.content,
      placeholder: {
        tag: 'plain_text',
        content: '---\ninclusion: always\n---\n\n# 你的指令\n\n例如：写代码时注释用中文。',
      },
      rows: 15,
      max_length: 5000,
      width: 'fill',
    },
    hr(),
    columnSet({
      flexMode: 'flow',
      horizontalSpacing: 'small',
      columns: [
        column({
          width: 'auto',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '💾 保存' },
              type: 'primary_filled',
              size: 'small',
              behaviors: [
                {
                  type: 'callback',
                  value: {
                    action: 'steering.submit',
                    scope: opts.scope,
                    name: opts.name,
                    isNew: opts.isNew,
                  },
                },
              ],
              form_action_type: 'submit',
            },
          ],
        }),
        column({
          width: 'auto',
          elements: [
            btn({
              text: '取消',
              type: 'default',
              size: 'small',
              value: { action: 'steering.list', scope: opts.scope },
            }),
          ],
        }),
      ],
    }),
  ];

  return {
    schema: '2.0',
    header: buildHeader({
      title: opts.isNew ? '📝 新建 Steering' : '✏️ 编辑 Steering',
      template: 'blue',
    }),
    body: {
      elements: [
        {
          tag: 'form',
          name: 'steering_form',
          elements,
        },
      ],
    },
  };
}

/**
 * /steering new 入口卡片：先让用户输入文件名，再进入正式编辑表单。
 *
 * 这是为了避免 /steering new <name> 命令模式没用按钮触发——按钮没法带文本输入。
 * 流程：点「新建」按钮 → 这张卡片 → 输入文件名 + 内容 → 提交。
 */
export function buildMemoryNewFormCard(opts: { scope: 'global' | 'project' }): object {
  const elements: object[] = [
    md(`**新建 steering 文件**（${opts.scope === 'global' ? '全局' : '项目'}）`),
    md('<font color="grey">💡 文件名只允许字母、数字、`. _ -`，必须以 `.md` 结尾</font>'),
    columnSet({
      flexMode: 'none',
      horizontalSpacing: 'small',
      columns: [
        column({ weight: 2, elements: [md('<font color="grey">文件名</font>')] }),
        column({
          weight: 5,
          elements: [
            {
              tag: 'input',
              name: 'name',
              placeholder: { tag: 'plain_text', content: 'my-rules.md' },
              max_length: 64,
              width: 'fill',
            },
          ],
        }),
      ],
    }),
    md('<font color="grey">内容</font>'),
    {
      tag: 'input',
      name: 'content',
      input_type: 'multiline',
      placeholder: {
        tag: 'plain_text',
        content: '---\ninclusion: always\n---\n\n# 你的指令\n\n例如：写代码时注释用中文。',
      },
      rows: 12,
      max_length: 5000,
      width: 'fill',
    },
    hr(),
    columnSet({
      flexMode: 'flow',
      horizontalSpacing: 'small',
      columns: [
        column({
          width: 'auto',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '💾 创建' },
              type: 'primary_filled',
              size: 'small',
              behaviors: [
                {
                  type: 'callback',
                  value: {
                    action: 'steering.submit',
                    scope: opts.scope,
                    isNew: true,
                  },
                },
              ],
              form_action_type: 'submit',
            },
          ],
        }),
        column({
          width: 'auto',
          elements: [
            btn({
              text: '取消',
              type: 'default',
              size: 'small',
              value: { action: 'steering.list', scope: opts.scope },
            }),
          ],
        }),
      ],
    }),
  ];

  return {
    schema: '2.0',
    header: buildHeader({
      title: '📝 新建 Steering',
      template: 'blue',
      subtitle: opts.scope === 'global' ? '全局' : '项目级',
    }),
    body: {
      elements: [
        {
          tag: 'form',
          name: 'steering_new_form',
          elements,
        },
      ],
    },
  };
}

// ----- /cron 卡片 -----

/**
 * /cron list 卡片：列出当前 chat 的所有任务。
 *
 * 每行：[id 短] [描述/表达式] [下次触发] [操作按钮 暂停/恢复/删除/手动跑]
 */
export function buildCronListCard(opts: {
  tasks: Array<{
    id: string;
    expression: string;
    description: string;
    prompt: string;
    enabled: boolean;
    lastRunAt: number;
    nextRunAt: Date | null;
  }>;
  isAdmin: boolean;
}): object {
  const elements: object[] = [];

  if (opts.tasks.length === 0) {
    elements.push(md('_当前 chat 还没有定时任务。_\n\n用 `/cron add <表达式> <prompt>` 添加。'));
    elements.push(
      md(
        [
          '<font color="grey">表达式支持：</font>',
          '- 标准 cron：`0 9 * * *`',
          '- shorthand：`@daily` `@hourly` `@weekly`',
          '- 中文关键词：`每天9点` `每周一8点` `工作日10点` `周末10点`',
          '- 复杂自然语言：`/cron translate <你的描述>` 让 Kiro 翻译',
        ].join('\n'),
      ),
    );
    return {
      schema: '2.0',
      header: buildHeader({ title: '⏰ 定时任务', template: 'wathet' }),
      body: { elements },
    };
  }

  for (const t of opts.tasks) {
    const idShort = `\`${t.id.slice(0, 6)}\``;
    const desc = t.description || t.expression;
    const next = t.nextRunAt
      ? new Date(t.nextRunAt).toLocaleString('zh-CN', {
          hour12: false,
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';
    const enabledTag = t.enabled
      ? `<font color='green'>● 启用</font>`
      : `<font color='grey'>○ 暂停</font>`;
    const promptShort = t.prompt.length > 40 ? t.prompt.slice(0, 40) + '…' : t.prompt;
    elements.push(
      columnSet({
        flexMode: 'none',
        horizontalSpacing: 'small',
        columns: [
          column({
            weight: 5,
            elements: [md(`${idShort} ${enabledTag}<br><font color='grey'>${desc}</font>`)],
          }),
          column({
            weight: 4,
            elements: [
              md(
                `<font color='grey'>下次：${next}</font><br><font color='grey'>${promptShort}</font>`,
              ),
            ],
          }),
        ],
      }),
    );
    if (opts.isAdmin) {
      elements.push(
        columnSet({
          flexMode: 'flow',
          horizontalSpacing: 'small',
          columns: [
            column({
              width: 'auto',
              elements: [
                btn({
                  text: '▶ 手动跑',
                  type: 'default',
                  size: 'tiny',
                  value: { action: 'cron.run', id: t.id },
                }),
              ],
            }),
            column({
              width: 'auto',
              elements: [
                btn({
                  text: t.enabled ? '⏸ 暂停' : '▶ 恢复',
                  type: 'default',
                  size: 'tiny',
                  value: { action: t.enabled ? 'cron.pause' : 'cron.resume', id: t.id },
                }),
              ],
            }),
            column({
              width: 'auto',
              elements: [
                btn({
                  text: '🗑️ 删除',
                  type: 'danger',
                  size: 'tiny',
                  value: { action: 'cron.rm', id: t.id },
                  confirm: {
                    title: '删除定时任务',
                    text: `确认删除 \`${t.id.slice(0, 6)}\`？此操作不可撤销。`,
                  },
                }),
              ],
            }),
          ],
        }),
      );
    }
    elements.push(hr());
  }

  return {
    schema: '2.0',
    header: buildHeader({
      title: '⏰ 定时任务',
      template: 'wathet',
      subtitle: `${opts.tasks.length} 个`,
    }),
    body: { elements },
  };
}

/**
 * 自然语言翻译确认卡片。
 *
 * 当用户输入的表达式不是 cron / shorthand / 关键词预设时，
 * 弹这张卡片问：「让 Kiro 翻译吗？」
 */
export function buildCronTranslateConfirmCard(opts: { raw: string; prompt: string }): object {
  return {
    schema: '2.0',
    header: buildHeader({ title: '🤔 不识别的表达式', template: 'orange' }),
    body: {
      elements: [
        md(`你输入的：\`${opts.raw}\``),
        md(
          [
            '这看起来像自然语言，但不在内置预设里。',
            '',
            '**可以让 Kiro 帮你翻译成 cron 表达式吗？**',
            '（会跑一次 Kiro 来分析；翻译完会再问你确认）',
          ].join('\n'),
        ),
        hr(),
        columnSet({
          flexMode: 'flow',
          horizontalSpacing: 'small',
          columns: [
            column({
              width: 'auto',
              elements: [
                btn({
                  text: '✅ 让 Kiro 翻译',
                  type: 'primary',
                  size: 'small',
                  value: { action: 'cron.translateConfirm', raw: opts.raw, prompt: opts.prompt },
                }),
              ],
            }),
            column({
              width: 'auto',
              elements: [
                btn({
                  text: '查看支持的格式',
                  type: 'default',
                  size: 'small',
                  value: { action: 'cron.list' },
                }),
              ],
            }),
          ],
        }),
      ],
    },
  };
}

/**
 * Kiro 翻译完成后的二次确认卡片。
 */
export function buildCronTranslatedConfirmCard(opts: {
  raw: string;
  expression: string;
  description: string;
  nextRun: string;
  prompt: string;
}): object {
  return {
    schema: '2.0',
    header: buildHeader({ title: '✅ 翻译结果', template: 'green' }),
    body: {
      elements: [
        md(`原文：\`${opts.raw}\``),
        md(`Cron 表达式：**\`${opts.expression}\`**`),
        md(`含义：${opts.description}`),
        md(`下次触发：\`${opts.nextRun}\``),
        hr(),
        md(`Prompt：${opts.prompt.length > 100 ? opts.prompt.slice(0, 100) + '…' : opts.prompt}`),
        hr(),
        columnSet({
          flexMode: 'flow',
          horizontalSpacing: 'small',
          columns: [
            column({
              width: 'auto',
              elements: [
                btn({
                  text: '✅ 创建任务',
                  type: 'primary_filled',
                  size: 'small',
                  value: {
                    action: 'cron.createConfirmed',
                    expression: opts.expression,
                    description: opts.description,
                    prompt: opts.prompt,
                  },
                }),
              ],
            }),
            column({
              width: 'auto',
              elements: [
                btn({
                  text: '取消',
                  type: 'default',
                  size: 'small',
                  value: { action: 'cron.list' },
                }),
              ],
            }),
          ],
        }),
      ],
    },
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

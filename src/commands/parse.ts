/**
 * 斜杠命令解析
 *
 * 支持的命令：
 *   /new, /reset           重置当前会话
 *   /cd <path>             切换工作目录
 *   /pwd                   查看当前目录
 *   /ws list               列出所有命名工作区
 *   /ws save <name>        把当前 cwd 存为命名工作区
 *   /ws use <name>         切换到命名工作区
 *   /ws remove <name>      删除命名工作区
 *   /status                查看会话状态
 *   /stop                  停止当前任务
 *   /timeout <N|off|default>  调整当前 chat 的 idle watchdog（分钟）
 *   /reconnect             重连 WebSocket
 *   /doctor [描述]          收集近期日志，让 Kiro 自己诊断
 *   /model                 列出可用模型 + 当前选中
 *   /model <name>          切换模型并写入 config.json（auto/default 表示清除覆盖）
 *   /help                  帮助
 *
 * kiro-cli 其他内置 TUI 命令（/agent /tools /compact /login /logout /session）
 *   在非交互模式下 kiro-cli 不识别，会被 LLM 当成普通问题"假装"回答。
 *   桥接器拦下来给一个明确的提示，避免误导用户。
 *
 * 不识别的 /xxx 命令会被原样转发给 Kiro（让用户自己定义）。
 */
export type ParsedCommand =
  | { kind: 'new' }
  | { kind: 'cd'; path: string }
  | { kind: 'pwd' }
  | { kind: 'ws-list' }
  | { kind: 'ws-save'; name: string }
  | { kind: 'ws-use'; name: string }
  | { kind: 'ws-remove'; name: string }
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'timeout'; mode: 'set'; minutes: number }
  | { kind: 'timeout'; mode: 'off' }
  | { kind: 'timeout'; mode: 'default' }
  | { kind: 'timeout'; mode: 'show' }
  | { kind: 'reconnect' }
  | { kind: 'doctor'; description: string }
  | { kind: 'selftest' }
  | { kind: 'config'; mode: 'show' }
  | { kind: 'ps' }
  | { kind: 'exit'; target: string }
  | { kind: 'memory'; mode: 'list'; scope: 'global' | 'project' }
  | { kind: 'memory'; mode: 'view'; scope: 'global' | 'project'; name: string }
  | { kind: 'memory'; mode: 'edit'; scope: 'global' | 'project'; name: string }
  | { kind: 'memory'; mode: 'new'; scope: 'global' | 'project'; name: string }
  | { kind: 'memory'; mode: 'rm'; scope: 'global' | 'project'; name: string }
  | { kind: 'cron'; mode: 'list' }
  | { kind: 'cron'; mode: 'add'; expression: string; prompt: string }
  | { kind: 'cron'; mode: 'rm'; id: string }
  | { kind: 'cron'; mode: 'pause'; id: string }
  | { kind: 'cron'; mode: 'resume'; id: string }
  | { kind: 'cron'; mode: 'run'; id: string }
  | { kind: 'cron'; mode: 'next'; id: string }
  | { kind: 'cron'; mode: 'translate'; raw: string }
  | { kind: 'schedule'; mode: 'new' }
  | { kind: 'model'; mode: 'show' }
  | { kind: 'model'; mode: 'set'; name: string }
  | { kind: 'model'; mode: 'reset' }
  | { kind: 'help' }
  | { kind: 'kiro-internal'; name: string }
  | { kind: 'unknown'; raw: string };

/**
 * kiro-cli 内置命令名（不含开头的 /）。
 * 这些在 --no-interactive 模式下不会被 kiro-cli 识别，需要桥接器主动拦截。
 * 注意：/model 已升级成桥接器自己的命令，不在这里。
 */
const KIRO_INTERNAL_COMMANDS = new Set([
  'agent',
  'tools',
  'compact',
  'login',
  'logout',
  'session',
  'sessions',
  'clear',
  'usage',
  'cost',
  'profile',
]);

/**
 * 命令名容错表：常见 typo / 别名 / 缩写 → 标准命令名。
 * 用户在 IM 里打字快、容易漏字母，这里宽容处理一下，体感会好很多。
 */
const COMMAND_ALIASES: Record<string, string> = {
  // /model 系列
  m: 'model',
  mod: 'model',
  mode: 'model',
  modle: 'model',
  models: 'model',
  // /help 系列
  h: 'help',
  '?': 'help',
  // /status 系列
  s: 'status',
  stat: 'status',
  // /new 系列
  reset: 'new',
  clear: 'new', // 注意：覆盖 KIRO_INTERNAL_COMMANDS 里的 clear
  // /stop 系列
  abort: 'stop',
  cancel: 'stop',
  // /pwd 系列
  cwd: 'pwd',
  // /reconnect
  reconect: 'reconnect',
  rc: 'reconnect',
  // /timeout
  to: 'timeout',
};

function normalizeCommandHead(head: string): string {
  const lower = head.toLowerCase();
  return COMMAND_ALIASES[lower] ?? lower;
}

/**
 * 尝试解析为命令。返回 null 表示不是命令（普通消息丢给 Kiro）。
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const rest = trimmed.slice(1);
  const [headRaw, ...tailParts] = rest.split(/\s+/);
  const tail = tailParts.join(' ').trim();

  // 命令名容错：常见 typo / 别名 → 标准名
  const head = normalizeCommandHead(headRaw ?? '');

  switch (head) {
    case 'new':
    case 'reset':
      return { kind: 'new' };
    case 'cd':
      if (!tail) return { kind: 'unknown', raw: trimmed };
      return { kind: 'cd', path: tail };
    case 'pwd':
      return { kind: 'pwd' };
    case 'status':
      return { kind: 'status' };
    case 'stop':
      return { kind: 'stop' };
    case 'reconnect':
      return { kind: 'reconnect' };
    case 'doctor':
      return { kind: 'doctor', description: tail };
    case 'selftest':
    case 'check':
      return { kind: 'selftest' };
    case 'config':
    case 'cfg':
    case 'settings':
      return { kind: 'config', mode: 'show' };
    case 'ps':
      return { kind: 'ps' };
    case 'exit':
    case 'kill': {
      if (!tail) return { kind: 'unknown', raw: trimmed };
      return { kind: 'exit', target: tail };
    }
    case 'steering':
    case 'memory':
    case 'mem': {
      // 解析 [--global] [子命令] [文件名]
      // 支持顺序：/steering [--global] [list|view|edit|new|rm] [name]
      const tokens = tail.split(/\s+/).filter(Boolean);
      let scope: 'global' | 'project' = 'project';
      const remaining: string[] = [];
      for (const t of tokens) {
        if (t === '--global' || t === '-g') {
          scope = 'global';
        } else {
          remaining.push(t);
        }
      }
      // 没有子命令 → list
      if (remaining.length === 0) {
        return { kind: 'memory', mode: 'list', scope };
      }
      const sub = remaining[0]?.toLowerCase() ?? '';
      const arg = remaining.slice(1).join(' ').trim();
      // /steering <name>（无子命令）→ 视作 view（看内容）
      if (
        sub !== 'list' &&
        sub !== 'view' &&
        sub !== 'cat' &&
        sub !== 'show' &&
        sub !== 'edit' &&
        sub !== 'new' &&
        sub !== 'create' &&
        sub !== 'rm' &&
        sub !== 'remove' &&
        sub !== 'delete'
      ) {
        return { kind: 'memory', mode: 'view', scope, name: remaining.join(' ') };
      }
      switch (sub) {
        case 'list':
          return { kind: 'memory', mode: 'list', scope };
        case 'view':
        case 'cat':
        case 'show':
          if (!arg) return { kind: 'unknown', raw: trimmed };
          return { kind: 'memory', mode: 'view', scope, name: arg };
        case 'edit':
          if (!arg) return { kind: 'unknown', raw: trimmed };
          return { kind: 'memory', mode: 'edit', scope, name: arg };
        case 'new':
        case 'create':
          if (!arg) return { kind: 'unknown', raw: trimmed };
          return { kind: 'memory', mode: 'new', scope, name: arg };
        case 'rm':
        case 'remove':
        case 'delete':
          if (!arg) return { kind: 'unknown', raw: trimmed };
          return { kind: 'memory', mode: 'rm', scope, name: arg };
        default:
          return { kind: 'unknown', raw: trimmed };
      }
    }
    case 'cron':
    case 'schedule': {
      // /cron                    → list
      // /cron list               → list
      // /cron add <expr> <prompt>
      // /cron rm <id>
      // /cron pause <id>
      // /cron resume <id>
      // /cron run <id>           手动立即跑一次
      // /cron next <id>          看下次触发
      // /cron translate <raw>    让 Kiro 翻译自然语言（卡片确认后才会调）
      //
      // /schedule 是 cron 的别名，但额外支持 /schedule new 弹可视化表单（小白入口）。
      // 当 head === 'schedule' 且 sub === 'new' 时走新表单分支。
      if (head === 'schedule') {
        const firstTok = (tail.split(/\s+/)[0] ?? '').toLowerCase();
        if (firstTok === 'new') {
          return { kind: 'schedule', mode: 'new' };
        }
      }
      if (!tail) return { kind: 'cron', mode: 'list' };
      const tokens = tail.split(/\s+/);
      const sub = (tokens[0] ?? '').toLowerCase();
      const restRaw = tail.slice((tokens[0] ?? '').length).trim();

      switch (sub) {
        case 'list':
        case 'ls':
          return { kind: 'cron', mode: 'list' };
        case 'add':
        case 'create':
        case 'new': {
          // /cron add <expr> <prompt>
          // expr 可能是单 token（cron / shorthand）或带空格的中文关键词。
          // 策略：如果 restRaw 第一个 token 是 cron 5 段（5 个空格分隔的 *|0-9|,|-|/|_）
          //       就把前 5 个 token 当 expr，其余当 prompt
          //       否则把第一个 token 当 expr（shorthand / 中文）
          if (!restRaw) return { kind: 'unknown', raw: trimmed };
          // 检查是否 5 段 cron（每段都是 cron 字符）
          const parts = restRaw.split(/\s+/);
          const cronCharRe = /^[\d*\-,/]+$/;
          if (parts.length >= 6 && parts.slice(0, 5).every((p) => cronCharRe.test(p))) {
            const expression = parts.slice(0, 5).join(' ');
            const prompt = parts.slice(5).join(' ').trim();
            if (!prompt) return { kind: 'unknown', raw: trimmed };
            return { kind: 'cron', mode: 'add', expression, prompt };
          }
          // 单 token expr
          const expression = parts[0] ?? '';
          const prompt = parts.slice(1).join(' ').trim();
          if (!expression || !prompt) return { kind: 'unknown', raw: trimmed };
          return { kind: 'cron', mode: 'add', expression, prompt };
        }
        case 'rm':
        case 'delete':
        case 'del':
        case 'remove': {
          if (!restRaw) return { kind: 'unknown', raw: trimmed };
          return { kind: 'cron', mode: 'rm', id: restRaw };
        }
        case 'pause': {
          if (!restRaw) return { kind: 'unknown', raw: trimmed };
          return { kind: 'cron', mode: 'pause', id: restRaw };
        }
        case 'resume': {
          if (!restRaw) return { kind: 'unknown', raw: trimmed };
          return { kind: 'cron', mode: 'resume', id: restRaw };
        }
        case 'run':
        case 'fire': {
          if (!restRaw) return { kind: 'unknown', raw: trimmed };
          return { kind: 'cron', mode: 'run', id: restRaw };
        }
        case 'next': {
          if (!restRaw) return { kind: 'unknown', raw: trimmed };
          return { kind: 'cron', mode: 'next', id: restRaw };
        }
        case 'translate':
        case 'parse': {
          // 让 Kiro 翻译自然语言（dispatcher 拿到后弹卡片确认）
          if (!restRaw) return { kind: 'unknown', raw: trimmed };
          return { kind: 'cron', mode: 'translate', raw: restRaw };
        }
        default:
          return { kind: 'unknown', raw: trimmed };
      }
    }
    case 'model': {
      if (!tail) return { kind: 'model', mode: 'show' };
      const lower = tail.toLowerCase();
      if (lower === 'auto' || lower === 'default' || lower === 'reset')
        return { kind: 'model', mode: 'reset' };
      // 模型名只允许字母数字 + - + .
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(tail)) {
        return { kind: 'unknown', raw: trimmed };
      }
      return { kind: 'model', mode: 'set', name: tail };
    }
    case 'timeout': {
      if (!tail) return { kind: 'timeout', mode: 'show' };
      const lower = tail.toLowerCase();
      if (lower === 'off' || lower === '0' || lower === 'disable')
        return { kind: 'timeout', mode: 'off' };
      if (lower === 'default' || lower === 'reset') return { kind: 'timeout', mode: 'default' };
      const n = Number(lower);
      if (Number.isFinite(n) && n > 0 && n <= 600) {
        return { kind: 'timeout', mode: 'set', minutes: Math.floor(n) };
      }
      return { kind: 'unknown', raw: trimmed };
    }
    case 'help':
      return { kind: 'help' };
    case 'ws': {
      const [sub, ...nameParts] = tail.split(/\s+/);
      const name = nameParts.join(' ').trim();
      if (sub === 'list' || sub === '' || sub === undefined) return { kind: 'ws-list' };
      if (sub === 'save' && name) return { kind: 'ws-save', name };
      if (sub === 'use' && name) return { kind: 'ws-use', name };
      if ((sub === 'remove' || sub === 'rm' || sub === 'delete') && name) {
        return { kind: 'ws-remove', name };
      }
      return { kind: 'unknown', raw: trimmed };
    }
    default:
      if (head && KIRO_INTERNAL_COMMANDS.has(head)) {
        return { kind: 'kiro-internal', name: head };
      }
      return { kind: 'unknown', raw: trimmed };
  }
}

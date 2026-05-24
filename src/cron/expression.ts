/**
 * Cron 表达式解析与规范化
 *
 * 接受三种输入，按优先级匹配：
 *   1. 标准 cron 5 段：`0 9 * * *`
 *   2. 标准 shorthand：@daily / @hourly / @weekly / @monthly / @yearly / @midnight
 *   3. 中文关键词预设：`每天9点` / `每周一8点` / `每小时` / `工作日10点`
 *
 * 不匹配以上 → 返回 { kind: 'unknown' }，由调用方决定要不要让 LLM 翻译。
 *
 * 参考：
 *   - cc-connect 只接受 cron 5 段，自然语言外包给 agent
 *   - GitHub Actions 也只接受 cron + shorthand
 *   - 我们做了关键词预设兜底常见场景，复杂的让 Kiro 翻译
 */
import { Cron } from 'croner';

export type ExpressionParseResult =
  | { kind: 'cron'; expression: string; description: string }
  | { kind: 'unknown'; raw: string };

/**
 * 标准 shorthand → cron 5 段映射。
 * 跟 GitHub Actions / Linux crontab 保持一致。
 */
const SHORTHAND_MAP: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

/**
 * 中文关键词预设。键是清洗后（去空格、小写、删除"点钟"等）的输入；
 * 值是 cron 5 段 + 描述。
 *
 * 设计取舍：只覆盖最常见的 ~15 个模式。复杂的让 Kiro 翻译。
 */
const CHINESE_PRESETS: Array<{ pattern: RegExp; cron: string; desc: string }> = [
  // 每天 N 点 / 每天N点 / 每天早上N点 / 每天上午N点 / 每天下午N点
  {
    pattern: /^每天(早上|上午|下午|晚上)?(\d{1,2})点(整|半)?$/,
    cron: '__DAY_HOUR__',
    desc: '每天 N 点',
  },
  // 每小时
  { pattern: /^每小时$/, cron: '0 * * * *', desc: '每小时（整点）' },
  // 每分钟（一般是测试用）
  { pattern: /^每分钟$/, cron: '* * * * *', desc: '每分钟' },
  // 每周 N 早上 N 点
  {
    pattern: /^每周(一|二|三|四|五|六|日|天)(早上|上午|下午|晚上)?(\d{1,2})点$/,
    cron: '__WEEK_HOUR__',
    desc: '每周 X N 点',
  },
  // 工作日 N 点
  {
    pattern: /^工作日(早上|上午|下午|晚上)?(\d{1,2})点$/,
    cron: '__WEEKDAY_HOUR__',
    desc: '工作日（周一到周五）N 点',
  },
  // 周末 N 点
  { pattern: /^周末(\d{1,2})点$/, cron: '__WEEKEND_HOUR__', desc: '周末 N 点' },
  // 每月 N 号 N 点
  {
    pattern: /^每月(\d{1,2})号(\d{1,2})点$/,
    cron: '__MONTH_DAY_HOUR__',
    desc: '每月 N 号 N 点',
  },
];

/** 中文星期 → cron weekday（0=周日） */
const WEEKDAY_MAP: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

/**
 * 把"早上/下午"等加到小时上做合理化：
 *   - 早上/上午：原样（默认 24h）
 *   - 下午/晚上：< 12 时加 12（"下午 3 点" → 15）
 */
function adjustHour(hour: number, period: string): number {
  if ((period === '下午' || period === '晚上') && hour < 12) return hour + 12;
  return hour;
}

/**
 * 主入口：解析输入字符串。
 *
 * 接受顺序：cron 5 段 → @shorthand → 中文关键词 → unknown
 */
export function parseExpression(input: string): ExpressionParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { kind: 'unknown', raw: input };

  // 1. 标准 cron 5 段：用 croner 自身校验最稳
  if (trimmed.split(/\s+/).length === 5) {
    try {
      const c = new Cron(trimmed, { paused: true });
      const next = c.nextRun();
      c.stop();
      if (next) {
        return { kind: 'cron', expression: trimmed, description: trimmed };
      }
    } catch {
      // 不是合法 cron，往下走
    }
  }

  // 2. shorthand（先小写）
  const lower = trimmed.toLowerCase();
  if (lower in SHORTHAND_MAP) {
    return {
      kind: 'cron',
      expression: SHORTHAND_MAP[lower] as string,
      description: lower,
    };
  }

  // 3. 中文关键词
  // 先清洗：去空格、把"上"前面的0去掉等
  const cleaned = trimmed.replace(/\s+/g, '').replace(/钟/g, '');
  for (const preset of CHINESE_PRESETS) {
    const m = cleaned.match(preset.pattern);
    if (!m) continue;

    if (preset.cron.startsWith('__')) {
      // 模板 cron，需要参数填充
      switch (preset.cron) {
        case '__DAY_HOUR__': {
          const period = m[1] ?? '';
          const hour = adjustHour(Number(m[2]), period);
          if (hour < 0 || hour > 23) return { kind: 'unknown', raw: input };
          return {
            kind: 'cron',
            expression: `0 ${hour} * * *`,
            description: `每天 ${hour}:00`,
          };
        }
        case '__WEEK_HOUR__': {
          const day = WEEKDAY_MAP[m[1] ?? ''];
          const period = m[2] ?? '';
          const hour = adjustHour(Number(m[3]), period);
          if (day === undefined || hour < 0 || hour > 23) return { kind: 'unknown', raw: input };
          return {
            kind: 'cron',
            expression: `0 ${hour} * * ${day}`,
            description: `每周${m[1]} ${hour}:00`,
          };
        }
        case '__WEEKDAY_HOUR__': {
          const period = m[1] ?? '';
          const hour = adjustHour(Number(m[2]), period);
          if (hour < 0 || hour > 23) return { kind: 'unknown', raw: input };
          return {
            kind: 'cron',
            expression: `0 ${hour} * * 1-5`,
            description: `工作日 ${hour}:00`,
          };
        }
        case '__WEEKEND_HOUR__': {
          const hour = Number(m[1]);
          if (hour < 0 || hour > 23) return { kind: 'unknown', raw: input };
          return {
            kind: 'cron',
            expression: `0 ${hour} * * 0,6`,
            description: `周末 ${hour}:00`,
          };
        }
        case '__MONTH_DAY_HOUR__': {
          const day = Number(m[1]);
          const hour = Number(m[2]);
          if (day < 1 || day > 31 || hour < 0 || hour > 23) {
            return { kind: 'unknown', raw: input };
          }
          return {
            kind: 'cron',
            expression: `0 ${hour} ${day} * *`,
            description: `每月 ${day} 号 ${hour}:00`,
          };
        }
      }
    } else {
      return { kind: 'cron', expression: preset.cron, description: preset.desc };
    }
  }

  return { kind: 'unknown', raw: input };
}

/**
 * 给一个合法 cron 表达式，算下次触发时间。
 * 失败返回 null。
 */
export function nextRun(expression: string): Date | null {
  try {
    const c = new Cron(expression, { paused: true });
    const next = c.nextRun();
    c.stop();
    return next ?? null;
  } catch {
    return null;
  }
}

/**
 * 把 Date 渲染成本地时区可读字符串。
 * 例：2026-05-24 09:00:00 (周日)
 */
export function formatNextRun(date: Date | null): string {
  if (!date) return '（无）';
  const pad = (n: number) => String(n).padStart(2, '0');
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} (${weekdays[date.getDay()]})`;
}

// Cron 表达式解析单元测试：标准 cron / shorthand / 中文关键词 / 不识别
import { describe, it, expect } from 'vitest';
import { parseExpression, nextRun, formatNextRun } from './expression.js';

describe('parseExpression — 标准 cron', () => {
  it('每天 9 点', () => {
    const r = parseExpression('0 9 * * *');
    expect(r.kind).toBe('cron');
    if (r.kind === 'cron') expect(r.expression).toBe('0 9 * * *');
  });

  it('每分钟', () => {
    const r = parseExpression('* * * * *');
    expect(r.kind).toBe('cron');
  });

  it('范围 + 列表', () => {
    const r = parseExpression('0 9-18 * * 1-5');
    expect(r.kind).toBe('cron');
  });

  it('非法 cron 拒绝', () => {
    expect(parseExpression('99 99 * * *').kind).toBe('unknown');
    expect(parseExpression('not a cron').kind).toBe('unknown');
  });

  it('段数错（4 段）→ 不识别', () => {
    expect(parseExpression('0 9 * *').kind).toBe('unknown');
  });
});

describe('parseExpression — shorthand', () => {
  it('@daily → 0 0 * * *', () => {
    const r = parseExpression('@daily');
    expect(r.kind).toBe('cron');
    if (r.kind === 'cron') expect(r.expression).toBe('0 0 * * *');
  });

  it('@hourly', () => {
    const r = parseExpression('@hourly');
    expect(r.kind).toBe('cron');
    if (r.kind === 'cron') expect(r.expression).toBe('0 * * * *');
  });

  it('@weekly', () => {
    const r = parseExpression('@weekly');
    if (r.kind === 'cron') expect(r.expression).toBe('0 0 * * 0');
  });

  it('@yearly', () => {
    const r = parseExpression('@yearly');
    if (r.kind === 'cron') expect(r.expression).toBe('0 0 1 1 *');
  });

  it('大小写不敏感', () => {
    expect(parseExpression('@DAILY').kind).toBe('cron');
  });
});

describe('parseExpression — 中文关键词', () => {
  it('每天9点', () => {
    const r = parseExpression('每天9点');
    expect(r.kind).toBe('cron');
    if (r.kind === 'cron') expect(r.expression).toBe('0 9 * * *');
  });

  it('每天早上9点', () => {
    const r = parseExpression('每天早上9点');
    if (r.kind === 'cron') expect(r.expression).toBe('0 9 * * *');
  });

  it('每天下午3点 → 15:00', () => {
    const r = parseExpression('每天下午3点');
    if (r.kind === 'cron') expect(r.expression).toBe('0 15 * * *');
  });

  it('每天晚上8点 → 20:00', () => {
    const r = parseExpression('每天晚上8点');
    if (r.kind === 'cron') expect(r.expression).toBe('0 20 * * *');
  });

  it('每小时', () => {
    const r = parseExpression('每小时');
    if (r.kind === 'cron') expect(r.expression).toBe('0 * * * *');
  });

  it('每周一8点', () => {
    const r = parseExpression('每周一8点');
    if (r.kind === 'cron') expect(r.expression).toBe('0 8 * * 1');
  });

  it('每周日10点', () => {
    const r = parseExpression('每周日10点');
    if (r.kind === 'cron') expect(r.expression).toBe('0 10 * * 0');
  });

  it('工作日10点', () => {
    const r = parseExpression('工作日10点');
    if (r.kind === 'cron') expect(r.expression).toBe('0 10 * * 1-5');
  });

  it('周末10点', () => {
    const r = parseExpression('周末10点');
    if (r.kind === 'cron') expect(r.expression).toBe('0 10 * * 0,6');
  });

  it('每月15号9点', () => {
    const r = parseExpression('每月15号9点');
    if (r.kind === 'cron') expect(r.expression).toBe('0 9 15 * *');
  });

  it('小时超范围拒绝', () => {
    expect(parseExpression('每天25点').kind).toBe('unknown');
  });

  it('"早上 9 点"（含空格）也能解析', () => {
    const r = parseExpression('每天 早上 9 点');
    expect(r.kind).toBe('cron');
  });
});

describe('parseExpression — 真自然语言（应该 unknown）', () => {
  it('"每天早上 9 点开会前总结"超过预设范围', () => {
    expect(parseExpression('每天早上9点开会前总结').kind).toBe('unknown');
  });

  it('英文自然语言', () => {
    expect(parseExpression('every day at 9am').kind).toBe('unknown');
  });

  it('空字符串', () => {
    expect(parseExpression('').kind).toBe('unknown');
  });
});

describe('nextRun + formatNextRun', () => {
  it('合法 cron 能算下次触发', () => {
    const next = nextRun('0 9 * * *');
    expect(next).toBeInstanceOf(Date);
    expect(next!.getHours()).toBe(9);
  });

  it('非法 cron 返回 null', () => {
    expect(nextRun('not a cron')).toBeNull();
  });

  it('formatNextRun null → "（无）"', () => {
    expect(formatNextRun(null)).toBe('（无）');
  });

  it('formatNextRun 含日期 + 星期', () => {
    const d = new Date(2026, 4, 24, 9, 0, 0); // 2026-05-24 09:00:00（周日）
    const s = formatNextRun(d);
    expect(s).toContain('2026-05-24');
    expect(s).toContain('09:00:00');
    expect(s).toContain('周日');
  });
});

/**
 * `/selftest` 命令的卡片渲染
 *
 * 设计：纯展示卡片，不带交互按钮（避免引入又一轮飞书 form 兼容性问题）。
 *   - 头部：summary 行（"全部 OK" / "X warn / Y fail"）
 *   - 表格行：每项编号 + 名称 + 等级图标 + detail
 *   - 底部：用时 + 一句"问题排查"提示
 */
import type { CheckResult, SelftestReport } from '../lib/selftest.js';

const LEVEL_ICON: Record<CheckResult['level'], string> = {
  ok: '✅',
  warn: '⚠️',
  fail: '❌',
  skip: '⏭️',
};

function md(content: string): object {
  return { tag: 'markdown', content };
}

function hr(): object {
  return { tag: 'hr' };
}

/** 单行：[图标 编号. 名称]    detail（小字灰色）*/
function row(r: CheckResult): object {
  const icon = LEVEL_ICON[r.level];
  const id = String(r.id).padStart(1, ' ');
  // 整行用 markdown，让飞书自己处理换行；颜色按等级区分
  const detailColor = r.level === 'fail' ? 'red' : r.level === 'warn' ? 'orange' : 'grey';
  return md(`${icon} **${id}. ${r.name}** — <font color='${detailColor}'>${r.detail}</font>`);
}

export function buildSelftestCard(report: SelftestReport): object {
  const { results, summary, durationMs } = report;
  const elements: object[] = [];

  // 头部 summary
  let summaryLine: string;
  if (summary.fail > 0) {
    summaryLine =
      `<font color='red'>**${summary.fail} 项失败**</font>` +
      (summary.warn > 0 ? ` · <font color='orange'>${summary.warn} 项警告</font>` : '') +
      ` · ${summary.ok} 项 OK`;
  } else if (summary.warn > 0) {
    summaryLine = `<font color='orange'>**${summary.warn} 项警告**</font> · ${summary.ok} 项 OK`;
  } else {
    summaryLine = `<font color='green'>**全部 ${summary.ok} 项 OK**</font>`;
  }

  elements.push(md(`🔍 **lark-kiro-bridge 自检** — ${summaryLine}`));
  elements.push(hr());

  for (const r of results) {
    elements.push(row(r));
  }

  elements.push(hr());

  // 底部：问题排查指引（按等级分别给）
  const tips: string[] = [`<font color='grey'>用时 ${durationMs}ms</font>`];
  if (summary.fail > 0) {
    tips.push('<font color="grey">💡 失败项请按 detail 修复后再跑 `/selftest`。常见：</font>');
    tips.push('<font color="grey">　- WS 未连接 → `/reconnect`</font>');
    tips.push('<font color="grey">　- kiro-cli 不可达 → 检查 PATH 或 config.kiro.binPath</font>');
    tips.push(
      '<font color="grey">　- defaultCwd 越界 → `/config` 调整 allowedRoots 或 defaultCwd</font>',
    );
  } else if (summary.warn > 0) {
    tips.push(
      '<font color="grey">💡 警告项不阻塞使用，但建议处理（特别是 trustedTools 不含 execute_bash 时 Kiro 跑 shell 会挂死）</font>',
    );
  } else {
    tips.push('<font color="grey">💡 一切正常。可以 `/help` 看可用命令</font>');
  }
  elements.push(md(tips.join('\n')));

  return {
    schema: '2.0',
    config: { summary: { content: '自检报告' } },
    body: { elements },
  };
}

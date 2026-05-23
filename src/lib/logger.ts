/**
 * 全局日志器
 * - 开发模式（TTY）用 pino-pretty 输出彩色易读日志
 * - 生产模式输出 NDJSON，写入 ~/.lark-kiro-bridge/logs/YYYY-MM-DD.log
 * - 启动时按 logRetentionDays（默认 7 天）清理旧日志
 *   ENV LARK_KIRO_LOG_DAYS 可覆盖，便于不读 config 的场景
 */
import pino, { type Logger } from 'pino';
import { join } from 'node:path';
import { readdirSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { LOGS_DIR, ensureDataDirs } from './paths.js';

function todayLogFile(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return join(LOGS_DIR, `${yyyy}-${mm}-${dd}.log`);
}

/**
 * 清理 LOGS_DIR 下早于 retainDays 天的 *.log 文件。
 * 异常静默吞掉——日志清理不应该挡启动。
 */
export function pruneOldLogs(retainDays: number): void {
  if (!Number.isFinite(retainDays) || retainDays <= 0) return;
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  try {
    const files = readdirSync(LOGS_DIR);
    for (const f of files) {
      if (!f.endsWith('.log')) continue;
      const full = join(LOGS_DIR, f);
      try {
        const st = statSync(full);
        if (st.mtimeMs < cutoff) unlinkSync(full);
      } catch {
        // 单个文件失败忽略
      }
    }
  } catch {
    // 目录不存在等
  }
}

let cachedLogger: Logger | null = null;

export function getLogger(): Logger {
  if (cachedLogger) return cachedLogger;

  ensureDataDirs();

  const isTty = process.stdout.isTTY;
  const level = process.env['LARK_KIRO_LOG_LEVEL'] ?? (isTty ? 'info' : 'info');

  if (isTty) {
    // 开发：终端友好输出
    cachedLogger = pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    });
  } else {
    // 生产：NDJSON 落盘
    cachedLogger = pino(
      { level, base: { pid: process.pid } },
      pino.destination({ dest: todayLogFile(), append: true, sync: false }),
    );
  }

  // 启动清理（用 env 兜底；bootstrap 后续会用 config 再调一次也没关系）
  const envDays = Number(process.env['LARK_KIRO_LOG_DAYS']);
  if (Number.isFinite(envDays) && envDays > 0) {
    pruneOldLogs(envDays);
  } else {
    pruneOldLogs(7);
  }

  return cachedLogger;
}

/**
 * 读最近 N 行结构化日志，供 /doctor 命令使用。
 * 简单实现：按文件 mtime 倒序取最新若干文件，整体读完后按行切，取最后 N 行。
 * 单条 NDJSON 可能很长，做一道字段截短，避免把 axios 错误的整个 request dump 都喂给 LLM。
 */
export function readRecentLogLines(maxLines = 200): string[] {
  try {
    const files = readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith('.log') && !f.startsWith('daemon-'))
      .map((f) => ({ f, t: statSync(join(LOGS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 3) // 最多翻 3 个文件
      .map((x) => x.f);
    const allLines: string[] = [];
    for (const f of files) {
      const full = join(LOGS_DIR, f);
      const raw = readFileSync(full, 'utf-8');
      // pino 会出现一行很长的情况，截短到 1KB
      for (const line of raw.split('\n')) {
        if (!line) continue;
        allLines.push(line.length > 1024 ? line.slice(0, 1024) + '…[truncated]' : line);
      }
      if (allLines.length >= maxLines * 3) break;
    }
    return allLines.slice(-maxLines);
  } catch {
    return [];
  }
}

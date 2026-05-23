/**
 * 会话状态持久化
 *
 * 数据模型：
 *   每个飞书 chatId 维护一个 ChatSession：
 *     - currentCwd: 当前工作目录
 *     - sessionsByCwd: cwd → kiroSessionId 的映射
 *
 * 切换工作目录时，该 chat 之前在新 cwd 下的 kiroSessionId 会被自动恢复（如果有），
 * 否则下次跑 Kiro 时新建。
 *
 * 这是工作目录方案 B 的核心数据结构。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { SESSIONS_FILE, ensureDataDirs } from '../lib/paths.js';
import { getLogger } from '../lib/logger.js';

const ChatSessionSchema = z.object({
  currentCwd: z.string(),
  sessionsByCwd: z.record(z.string(), z.string()).default({}),
  lastActiveAt: z.number().int().nonnegative().default(0),
  /**
   * per-chat idle watchdog 分钟数覆盖：
   *   undefined → 用全局默认（preferences/kiro.idleTimeoutMinutes）
   *   0         → 显式关闭
   *   N>0       → 用 N 分钟
   */
  idleTimeoutMinutes: z.number().int().nonnegative().optional(),
});

const SessionsFileSchema = z.object({
  version: z.literal(1).default(1),
  chats: z.record(z.string(), ChatSessionSchema).default({}),
});

export type ChatSession = z.infer<typeof ChatSessionSchema>;
export type SessionsFile = z.infer<typeof SessionsFileSchema>;

const log = () => getLogger().child({ module: 'sessions' });

function readFile(): SessionsFile {
  if (!existsSync(SESSIONS_FILE)) {
    return SessionsFileSchema.parse({});
  }
  try {
    const raw = readFileSync(SESSIONS_FILE, 'utf-8');
    const parsed = SessionsFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log().warn({ err: parsed.error.issues }, 'sessions.json validation failed, resetting');
      return SessionsFileSchema.parse({});
    }
    return parsed.data;
  } catch (e) {
    log().warn({ err: e }, 'sessions.json read failed, resetting');
    return SessionsFileSchema.parse({});
  }
}

function writeFile(data: SessionsFile): void {
  ensureDataDirs();
  writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

/**
 * 文件锁包装器：防止多进程并发写入损坏文件。
 * proper-lockfile 用 .lock 目录实现跨进程互斥。
 */
async function withLock<T>(fn: () => T): Promise<T> {
  ensureDataDirs();
  // 文件不存在时先创建空文件，否则 lockfile 会报 ENOENT
  if (!existsSync(SESSIONS_FILE)) {
    writeFileSync(SESSIONS_FILE, '{}\n', { mode: 0o600 });
  }
  const release = await lockfile.lock(SESSIONS_FILE, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
    stale: 10_000,
  });
  try {
    return fn();
  } finally {
    await release();
  }
}

export class SessionStore {
  /**
   * 获取一个 chat 的会话状态；不存在则用 defaultCwd 初始化。
   */
  async get(chatId: string, defaultCwd: string): Promise<ChatSession> {
    return withLock(() => {
      const data = readFile();
      let session = data.chats[chatId];
      if (!session) {
        session = {
          currentCwd: defaultCwd,
          sessionsByCwd: {},
          lastActiveAt: Date.now(),
        };
        data.chats[chatId] = session;
        writeFile(data);
      }
      return session;
    });
  }

  /**
   * 切换 chat 的当前 cwd。该 cwd 下若已有 kiro session 会被自动延用。
   */
  async setCwd(chatId: string, cwd: string, defaultCwd: string): Promise<ChatSession> {
    return withLock(() => {
      const data = readFile();
      const session = data.chats[chatId] ?? {
        currentCwd: defaultCwd,
        sessionsByCwd: {},
        lastActiveAt: Date.now(),
      };
      session.currentCwd = cwd;
      session.lastActiveAt = Date.now();
      data.chats[chatId] = session;
      writeFile(data);
      return session;
    });
  }

  /**
   * 关联当前 (chatId, cwd) 到一个 kiroSessionId（Kiro CLI 跑完返回的 sid）。
   */
  async setKiroSession(chatId: string, cwd: string, kiroSessionId: string): Promise<void> {
    await withLock(() => {
      const data = readFile();
      const session = data.chats[chatId];
      if (!session) return;
      session.sessionsByCwd[cwd] = kiroSessionId;
      session.lastActiveAt = Date.now();
      writeFile(data);
    });
  }

  /**
   * 清空当前 cwd 下的 kiro session（用于 /new 命令）。
   */
  async clearKiroSession(chatId: string, cwd: string): Promise<void> {
    await withLock(() => {
      const data = readFile();
      const session = data.chats[chatId];
      if (!session) return;
      delete session.sessionsByCwd[cwd];
      session.lastActiveAt = Date.now();
      writeFile(data);
    });
  }

  /**
   * 获取当前 (chatId, cwd) 对应的 kiroSessionId（可能不存在）。
   */
  async getKiroSession(chatId: string, cwd: string): Promise<string | undefined> {
    return withLock(() => {
      const data = readFile();
      return data.chats[chatId]?.sessionsByCwd[cwd];
    });
  }

  /**
   * 设置 chat 的 idle watchdog 阈值（分钟）。
   *   - undefined：清除覆盖，回归全局默认
   *   - 0：关闭
   *   - N>0：用 N 分钟
   */
  async setIdleTimeout(
    chatId: string,
    minutes: number | undefined,
    defaultCwd: string,
  ): Promise<void> {
    await withLock(() => {
      const data = readFile();
      const session =
        data.chats[chatId] ??
        ({
          currentCwd: defaultCwd,
          sessionsByCwd: {},
          lastActiveAt: Date.now(),
        } as ChatSession);
      if (minutes === undefined) {
        delete session.idleTimeoutMinutes;
      } else {
        session.idleTimeoutMinutes = minutes;
      }
      session.lastActiveAt = Date.now();
      data.chats[chatId] = session;
      writeFile(data);
    });
  }
}

/**
 * Cron 任务持久化
 *
 * 文件路径：~/.lark-kiro-bridge/cron.json
 *
 * 数据模型：每条任务一个 CronTask，包含：
 *   - id：8 位短 hex（创建时随机生成）
 *   - chatId / cwd：触发时把卡片发回这个 chat、cwd 跑 Kiro
 *   - expression：标准 cron 5 段（已规范化）
 *   - prompt：触发时喂给 Kiro 的 prompt
 *   - description：用户可读的描述（来自关键词预设或用户填）
 *   - enabled：暂停/恢复
 *
 * 安全限制：
 *   - 单 chat 任务数 ≤ 20
 *   - 全局任务数 ≤ 100
 *   - prompt ≤ 1000 字符
 *
 * 文件锁：用 proper-lockfile 防多进程并发损坏。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { CRON_FILE, ensureDataDirs } from '../lib/paths.js';
import { getLogger } from '../lib/logger.js';

const CronTaskSchema = z.object({
  id: z.string().length(8),
  chatId: z.string().min(1),
  cwd: z.string().min(1),
  /** 标准 cron 5 段表达式（已规范化）*/
  expression: z.string().min(1),
  /** 触发时给 Kiro 的 prompt */
  prompt: z.string().min(1).max(1000),
  /** 人类可读描述（"每天 9:00" 等）*/
  description: z.string().default(''),
  /** 创建时间 ms */
  createdAt: z.number().int().nonnegative(),
  /** 创建者 open_id（admin 校验用日志）*/
  createdBy: z.string().default(''),
  /** 上次触发时间 ms（0 = 还没触发过）*/
  lastRunAt: z.number().int().nonnegative().default(0),
  /** 暂停 / 恢复 */
  enabled: z.boolean().default(true),
});

const CronFileSchema = z.object({
  version: z.literal(1).default(1),
  tasks: z.array(CronTaskSchema).default([]),
});

export type CronTask = z.infer<typeof CronTaskSchema>;
type CronFile = z.infer<typeof CronFileSchema>;

const log = () => getLogger().child({ module: 'cron-store' });

export class CronStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronStoreError';
  }
}

const PER_CHAT_LIMIT = 20;
const GLOBAL_LIMIT = 100;

function readFile(): CronFile {
  if (!existsSync(CRON_FILE)) return CronFileSchema.parse({});
  try {
    const raw = readFileSync(CRON_FILE, 'utf-8');
    const parsed = CronFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log().warn({ err: parsed.error.issues }, 'cron.json validation failed, resetting');
      return CronFileSchema.parse({});
    }
    return parsed.data;
  } catch (e) {
    log().warn({ err: e }, 'cron.json read failed, resetting');
    return CronFileSchema.parse({});
  }
}

function writeFile(data: CronFile): void {
  ensureDataDirs();
  writeFileSync(CRON_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

async function withLock<T>(fn: () => T): Promise<T> {
  ensureDataDirs();
  if (!existsSync(CRON_FILE)) writeFileSync(CRON_FILE, '{}\n', { mode: 0o600 });
  const release = await lockfile.lock(CRON_FILE, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
    stale: 10_000,
  });
  try {
    return fn();
  } finally {
    await release();
  }
}

function newId(): string {
  return randomBytes(4).toString('hex');
}

export class CronStore {
  /**
   * 列出所有任务（按 chatId 过滤可选）。
   */
  async list(filterChatId?: string): Promise<CronTask[]> {
    return withLock(() => {
      const data = readFile();
      return filterChatId ? data.tasks.filter((t) => t.chatId === filterChatId) : data.tasks;
    });
  }

  /** 按 id 找任务（前缀匹配也支持，因为 id 是 8 位 hex）。 */
  async findById(idOrPrefix: string): Promise<CronTask | undefined> {
    const id = idOrPrefix.trim().toLowerCase();
    if (!id) return undefined;
    return withLock(() => {
      const data = readFile();
      // 完整 id 优先
      const exact = data.tasks.find((t) => t.id === id);
      if (exact) return exact;
      // 前缀匹配（≥ 4 位才允许，避免歧义）
      if (id.length >= 4) {
        const matches = data.tasks.filter((t) => t.id.startsWith(id));
        if (matches.length === 1) return matches[0];
      }
      return undefined;
    });
  }

  /**
   * 创建新任务。返回创建好的 task。
   * 校验：
   *   - prompt ≤ 1000
   *   - 单 chat 上限
   *   - 全局上限
   */
  async create(opts: {
    chatId: string;
    cwd: string;
    expression: string;
    prompt: string;
    description?: string;
    createdBy?: string;
  }): Promise<CronTask> {
    if (opts.prompt.length > 1000) {
      throw new CronStoreError(`prompt 超过 1000 字符（当前 ${opts.prompt.length}）`);
    }
    return withLock(() => {
      const data = readFile();
      const inChat = data.tasks.filter((t) => t.chatId === opts.chatId);
      if (inChat.length >= PER_CHAT_LIMIT) {
        throw new CronStoreError(`单 chat 任务数已达上限 ${PER_CHAT_LIMIT}`);
      }
      if (data.tasks.length >= GLOBAL_LIMIT) {
        throw new CronStoreError(`全局任务数已达上限 ${GLOBAL_LIMIT}`);
      }
      const task: CronTask = {
        id: newId(),
        chatId: opts.chatId,
        cwd: opts.cwd,
        expression: opts.expression,
        prompt: opts.prompt,
        description: opts.description ?? '',
        createdAt: Date.now(),
        createdBy: opts.createdBy ?? '',
        lastRunAt: 0,
        enabled: true,
      };
      data.tasks.push(task);
      writeFile(data);
      log().info(
        { id: task.id, chatId: task.chatId, expression: task.expression },
        'cron task created',
      );
      return task;
    });
  }

  /** 更新任务（用 mutator，跟 patchAndSaveConfig 风格一致）。 */
  async update(id: string, mutator: (t: CronTask) => void): Promise<CronTask | undefined> {
    return withLock(() => {
      const data = readFile();
      const idx = data.tasks.findIndex((t) => t.id === id);
      if (idx < 0) return undefined;
      const draft = { ...(data.tasks[idx] as CronTask) };
      mutator(draft);
      // 重新校验
      const validated = CronTaskSchema.parse(draft);
      data.tasks[idx] = validated;
      writeFile(data);
      return validated;
    });
  }

  /** 标记任务的 lastRunAt（触发后调）。 */
  async markRun(id: string, when = Date.now()): Promise<void> {
    await this.update(id, (t) => {
      t.lastRunAt = when;
    });
  }

  async delete(id: string): Promise<boolean> {
    return withLock(() => {
      const data = readFile();
      const before = data.tasks.length;
      data.tasks = data.tasks.filter((t) => t.id !== id);
      const removed = data.tasks.length !== before;
      if (removed) {
        writeFile(data);
        log().info({ id }, 'cron task deleted');
      }
      return removed;
    });
  }
}

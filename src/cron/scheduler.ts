/**
 * Cron 调度器
 *
 * 职责：
 *   1. 启动时从 CronStore 加载所有 enabled 任务，注册到 croner
 *   2. 创建/删除/暂停/恢复任务时同步 croner 实例
 *   3. 触发时调用注入的 onFire 回调（dispatcher 来跑 Kiro）
 *
 * 关键决策：
 *   - 用 croner 的 `protect: true` 防止上次还在跑下次又触发
 *   - 不补偿漏触发（GitHub Actions / AWS EventBridge 都一样）
 *   - 任务的 lastRunAt 由调度器在触发时调 markRun，不依赖 onFire 的成功与否
 */
import { Cron } from 'croner';
import type { Logger } from 'pino';
import type { CronStore, CronTask } from './store.js';

export interface CronFireContext {
  task: CronTask;
  /** 触发时间（瞬时，可能比 cron 表达式预期慢几百毫秒，没关系）*/
  firedAt: Date;
}

export interface CronSchedulerOptions {
  store: CronStore;
  logger: Logger;
  /** 任务到点触发时调用。允许异步，调度器不等它返回（fire-and-forget）。 */
  onFire: (ctx: CronFireContext) => void | Promise<void>;
}

export class CronScheduler {
  private readonly store: CronStore;
  private readonly log: Logger;
  private readonly onFire: CronSchedulerOptions['onFire'];
  private readonly jobs = new Map<string, Cron>();
  private started = false;

  constructor(opts: CronSchedulerOptions) {
    this.store = opts.store;
    this.log = opts.logger.child({ module: 'cron-scheduler' });
    this.onFire = opts.onFire;
  }

  /** 启动：加载所有 enabled 任务并注册。 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const tasks = await this.store.list();
    let registered = 0;
    for (const t of tasks) {
      if (!t.enabled) continue;
      try {
        this.register(t);
        registered++;
      } catch (e) {
        this.log.warn({ err: e, id: t.id }, 'failed to register cron task on start');
      }
    }
    this.log.info({ total: tasks.length, registered }, 'cron scheduler started');
  }

  /** 停止：取消所有 croner 实例。CronStore 数据不动。 */
  stop(): void {
    for (const [id, job] of this.jobs) {
      try {
        job.stop();
      } catch (e) {
        this.log.warn({ err: e, id }, 'failed to stop cron job');
      }
    }
    this.jobs.clear();
    this.started = false;
  }

  /**
   * 注册或重新注册一个任务到 croner。
   * 如果已存在同 id 的实例，先停掉再重建（用于 update 场景）。
   */
  register(task: CronTask): void {
    // 已有就先停
    const old = this.jobs.get(task.id);
    if (old) {
      try {
        old.stop();
      } catch {
        // ignore
      }
      this.jobs.delete(task.id);
    }

    const job = new Cron(
      task.expression,
      {
        // 防重叠：上次回调还没完成就不再触发
        protect: true,
        // 用本地时区（cron 标配，简单起见）
        timezone: undefined,
      },
      async () => {
        const firedAt = new Date();
        this.log.info(
          { id: task.id, chatId: task.chatId, firedAt: firedAt.toISOString() },
          'cron fired',
        );
        // 异步触发 onFire，自身错误不影响调度器
        try {
          await this.onFire({ task, firedAt });
        } catch (e) {
          this.log.error({ err: e, id: task.id }, 'cron onFire threw');
        }
        // 标记 lastRunAt（无论 onFire 成败）
        this.store.markRun(task.id, firedAt.getTime()).catch((e) => {
          this.log.warn({ err: e, id: task.id }, 'failed to mark cron run');
        });
      },
    );
    this.jobs.set(task.id, job);
    this.log.debug(
      { id: task.id, expression: task.expression, next: job.nextRun()?.toISOString() },
      'cron registered',
    );
  }

  /** 取消一个任务（删除或暂停时用）。 */
  unregister(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    try {
      job.stop();
    } catch (e) {
      this.log.warn({ err: e, id }, 'failed to stop cron job');
    }
    this.jobs.delete(id);
  }

  /** 看下次触发时间（不更新内部状态）。 */
  nextRun(id: string): Date | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    return job.nextRun() ?? null;
  }

  /** 当前注册了多少个 job。 */
  size(): number {
    return this.jobs.size;
  }
}

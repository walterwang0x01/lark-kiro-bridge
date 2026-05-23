/**
 * 单 chat 任务管线
 *
 * 一个飞书 chat 一个 ChatPipeline 实例。职责：
 *   - 对该 chat 串行执行任务（同一时刻最多一个 Kiro 在跑）
 *   - 新任务到来时打断旧任务（"preempt"）
 *   - 提供 stop() 主动中止当前任务
 */
import type { Logger } from 'pino';

export interface PipelineTask {
  /** 任务 id（用于日志） */
  id: string;
  /** 真正干活的函数；接收 AbortSignal */
  run: (signal: AbortSignal) => Promise<void>;
}

export class ChatPipeline {
  private readonly log: Logger;
  private currentAbort: AbortController | null = null;
  private currentTaskId: string | null = null;
  private currentPromise: Promise<void> | null = null;

  constructor(
    public readonly chatId: string,
    logger: Logger,
  ) {
    this.log = logger.child({ module: 'pipeline', chatId });
  }

  /**
   * 提交新任务。
   * 如果当前有任务在跑：
   *   - 先发 abort 信号
   *   - 等旧任务收尾（旧 run() 应该 catch AbortError 并 finalize 卡片）
   *   - 再启动新任务
   */
  async submit(task: PipelineTask): Promise<void> {
    if (this.currentAbort) {
      this.log.info({ oldTask: this.currentTaskId, newTask: task.id }, 'preempting current task');
      this.currentAbort.abort();
      // 等旧任务结束（不抛错）
      try {
        await this.currentPromise;
      } catch {
        // ignore
      }
    }
    const ctrl = new AbortController();
    this.currentAbort = ctrl;
    this.currentTaskId = task.id;
    const p = (async () => {
      try {
        await task.run(ctrl.signal);
      } catch (e) {
        this.log.error({ err: e, taskId: task.id }, 'task threw');
      } finally {
        if (this.currentAbort === ctrl) {
          this.currentAbort = null;
          this.currentTaskId = null;
          this.currentPromise = null;
        }
      }
    })();
    this.currentPromise = p;
    await p;
  }

  /** 主动中止当前任务（/stop 命令）。返回是否真的中止了某任务。 */
  abortCurrent(): boolean {
    if (this.currentAbort) {
      this.log.info({ taskId: this.currentTaskId }, 'aborting current task');
      this.currentAbort.abort();
      return true;
    }
    return false;
  }

  hasActiveTask(): boolean {
    return this.currentAbort !== null;
  }
}

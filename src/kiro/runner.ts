/**
 * Kiro CLI 子进程封装
 *
 * 职责：
 *   - 用 execa spawn `kiro-cli chat --no-interactive ...`
 *   - 流式收 stdout，去 ANSI 转义后通过 onChunk 回调推给上层（卡片渲染器）
 *   - 跑完后用 `kiro-cli chat --list-sessions` 取最新 sessionId 返回
 *   - 支持超时（kill SIGTERM，2 秒后 SIGKILL）
 *   - 支持外部主动中止（同样 SIGTERM/SIGKILL 流程）
 *
 * 注意：kiro-cli 没有原生 JSON 流式协议，stdout 是 ANSI 着色的纯文本。
 *       工具调用/思考过程在 --no-interactive 下被隐藏，输出的就是最终回复文本。
 */
import { execa, type ResultPromise } from 'execa';
import { getLogger } from '../lib/logger.js';

const log = () => getLogger().child({ module: 'kiro-runner' });

/** ANSI 转义序列剥离正则；覆盖 CSI、OSC 和常见控制序列。 */
// eslint-disable-next-line no-control-regex
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes require explicit \x1B / \x07
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[ -/]*[0-9?])/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '');
}

export interface RunOptions {
  /** 用户消息（即喂给 kiro-cli 的 INPUT 参数） */
  prompt: string;
  /** 工作目录 */
  cwd: string;
  /** 续接的 session id；不传则新建会话 */
  resumeId?: string | undefined;
  /** kiro-cli 可执行文件，默认 'kiro-cli' */
  binPath?: string;
  /** 信任的工具集合 */
  trustedTools?: string[];
  /** 模型名（可选） */
  model?: string | undefined;
  /** Agent 名（可选） */
  agent?: string | undefined;
  /** 总超时毫秒 */
  timeoutMs?: number;
  /**
   * 空闲 watchdog 阈值（毫秒）。
   * 若 stdout 连续这么久没新输出就认为假死，杀掉子进程。
   * 0 或不传 = 关闭 watchdog（仅依赖 timeoutMs）。
   */
  idleTimeoutMs?: number;
  /**
   * 流式文本回调；text 是已剥离 ANSI 的纯文本片段。
   * 调用方拿到原始流后自行解析（用 createRunStreamParser），
   * 不再由 runner 内部做 trace/正文分离。
   */
  onChunk?: (text: string) => void;
  /** AbortSignal 用于外部打断 */
  signal?: AbortSignal;
  /**
   * 额外的环境变量（合并到 process.env 之上）。
   * 用途：把飞书侧的上下文（chatId / chatType / senderOpenId）注入子进程，
   * 让 kiro-cli 通过工具（lark-cli 等）操作飞书时知道在哪个 chat 里。
   */
  extraEnv?: Record<string, string>;
}

export interface RunResult {
  /** 完整回复（已剥离 ANSI） */
  text: string;
  /** kiro-cli 退出码 */
  exitCode: number | null;
  /** 跑完之后从 list-sessions 拿到的最新 session id（可能为 undefined） */
  newSessionId?: string;
  /** 是否被外部信号中止 */
  aborted: boolean;
  /** 是否因总超时被强杀 */
  timedOut: boolean;
  /** 是否因 idle watchdog 被强杀（超过 idleTimeoutMs 没新输出） */
  idleTimedOut: boolean;
}

/** stdout 输出里 kiro-cli 的提示符前缀，剥掉。 */
const PROMPT_PREFIX_REGEX = /^>\s*/;

/**
 * 跑一次 kiro-cli。流式回调和超时/打断都安全终止。
 */
export async function runKiro(opts: RunOptions): Promise<RunResult> {
  const {
    prompt,
    cwd,
    resumeId,
    binPath = 'kiro-cli',
    trustedTools = ['fs_read', 'fs_write', 'grep', 'glob', 'code'],
    model,
    agent,
    timeoutMs = 10 * 60 * 1000,
    idleTimeoutMs = 0,
    onChunk,
    signal,
    extraEnv,
  } = opts;

  const args: string[] = ['chat', '--no-interactive'];
  if (resumeId) args.push('--resume-id', resumeId);
  if (model) args.push('--model', model);
  if (agent) args.push('--agent', agent);
  if (trustedTools.length > 0) {
    args.push(`--trust-tools=${trustedTools.join(',')}`);
  } else {
    args.push('--trust-tools=');
  }
  args.push(prompt);

  log().info({ cwd, resumeId, args: args.slice(0, 5) }, 'spawning kiro-cli');
  log().debug(
    {
      bin: binPath,
      argsLen: args.length,
      promptLen: prompt.length,
      promptHead: prompt.slice(0, 120),
      model,
      agent,
      timeoutMs,
      idleTimeoutMs,
    },
    'kiro-cli spawn detail',
  );

  let timedOut = false;
  let aborted = false;
  let idleTimedOut = false;
  let textBuf = '';
  let lastChunkAt = Date.now();

  // 用 execa 9 spawn；stdin 关闭，stdout/stderr 流式
  // 关键：detached:true 让 kiro-cli 自成一个 process group，
  // 这样 SIGTERM/SIGKILL 可以用 process.kill(-pgid, ...) 发给整个进程组，
  // 把它的子孙（kiro-cli-chat → bun tui.js → acp 等）一起干掉。
  // 否则 child.kill 只杀直接子进程，孙子继续占着 stdout pipe，
  // 导致 await child 永远不返回，整个 chat pipeline 卡死。
  const child: ResultPromise = execa(binPath, args, {
    cwd,
    reject: false,
    stripFinalNewline: false,
    buffer: false,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
    env: { ...process.env, FORCE_COLOR: '0', ...extraEnv }, // 尽量减少 ANSI；extraEnv 后置，可覆盖默认值
  });

  /**
   * 干掉整个进程组。
   * - 若 child.pid 还在：先给 -pid 进程组发 signal，失败回退 child.kill
   * - SIGKILL 之后再 destroy stdout，确保 promise 尽快 settle
   */
  const killTree = (signal: NodeJS.Signals): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      // 负号 = 进程组。要求 spawn 时 detached:true。
      process.kill(-pid, signal);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // ESRCH 表示组里没人了（已退出），忽略；其他错误降级到 child.kill
      if (code !== 'ESRCH') {
        try {
          child.kill(signal);
        } catch {
          // ignore
        }
      }
    }
  };

  // 总超时
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    log().warn({ pid: child.pid, timeoutMs }, 'kiro-cli timed out, sending SIGTERM');
    killTree('SIGTERM');
    setTimeout(() => {
      killTree('SIGKILL');
      // 强制释放 stdout pipe，避免 await child 还在等
      child.stdout?.destroy();
    }, 2000);
  }, timeoutMs);

  // 空闲 watchdog：每 30s 检查一次，若距离 lastChunkAt 超过 idleTimeoutMs 就杀掉
  // 用来兜底"kiro-cli 假死"——进程在但不输出，正常 timeoutMs (默认 10 分钟) 太久。
  let idleHandle: NodeJS.Timeout | null = null;
  if (idleTimeoutMs > 0) {
    const checkInterval = Math.min(30_000, Math.max(5_000, Math.floor(idleTimeoutMs / 4)));
    idleHandle = setInterval(() => {
      if (Date.now() - lastChunkAt < idleTimeoutMs) return;
      idleTimedOut = true;
      log().warn(
        { pid: child.pid, idleTimeoutMs, sinceLastChunkMs: Date.now() - lastChunkAt },
        'kiro-cli idle timeout, sending SIGTERM',
      );
      killTree('SIGTERM');
      setTimeout(() => {
        killTree('SIGKILL');
        child.stdout?.destroy();
      }, 2000);
      if (idleHandle) {
        clearInterval(idleHandle);
        idleHandle = null;
      }
    }, checkInterval);
  }

  // 外部 abort
  const onAbort = () => {
    aborted = true;
    log().info({ pid: child.pid }, 'kiro-cli abort requested');
    killTree('SIGTERM');
    setTimeout(() => {
      killTree('SIGKILL');
      child.stdout?.destroy();
    }, 2000);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  // 流式收 stdout，stripAnsi 后原样上报给 onChunk
  // 调用方负责进一步解析（旧版的 outputFilter 已下沉到 runStreamParser，
  // 由 RunCardController 内部使用）
  let chunkSeq = 0;
  if (child.stdout) {
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      lastChunkAt = Date.now();
      const cleanRaw = stripAnsi(chunk).replace(PROMPT_PREFIX_REGEX, '');
      chunkSeq++;
      log().debug(
        {
          seq: chunkSeq,
          rawLen: chunk.length,
          cleanLen: cleanRaw.length,
          head: cleanRaw.slice(0, 80),
        },
        'kiro stdout chunk',
      );
      if (!cleanRaw) return;
      textBuf += cleanRaw;
      try {
        onChunk?.(cleanRaw);
      } catch (e) {
        log().error({ err: e }, 'onChunk callback threw');
      }
    });
  }

  // stderr：信息级别记录（之前是 debug，排查时容易漏掉 kiro-cli 抛到 stderr 的关键提示，
  // 比如要登录、quota 用完等）
  if (child.stderr) {
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      const t = chunk.trim();
      if (!t) return;
      log().debug({ stderr: t.slice(0, 500) }, 'kiro stderr');
    });
  }

  const result = await child;
  clearTimeout(timeoutHandle);
  if (idleHandle) clearInterval(idleHandle);
  if (signal) signal.removeEventListener('abort', onAbort);

  log().info(
    {
      exitCode: result.exitCode,
      textLen: textBuf.length,
      chunks: chunkSeq,
      aborted,
      timedOut,
      idleTimedOut,
    },
    'kiro-cli finished',
  );

  // 跑完后取最新 session id（resume 用的话用同一个，否则取最新创建的）
  let newSessionId: string | undefined;
  if (!aborted && !timedOut && !idleTimedOut && result.exitCode === 0) {
    try {
      newSessionId = await getLatestSessionId(cwd, binPath);
    } catch (e) {
      log().warn({ err: e }, 'failed to fetch latest session id');
    }
  }

  return {
    text: textBuf.trim(),
    exitCode: result.exitCode ?? null,
    newSessionId: newSessionId ?? resumeId,
    aborted,
    timedOut,
    idleTimedOut,
  };
}

/**
 * 从 `kiro-cli chat --list-sessions` 输出里抓最新一条 SessionId。
 * 输出格式（去 ANSI 后）大致：
 *   Chat sessions for /path:
 *
 *   Chat SessionId: 124aaf58-...
 *     19 seconds ago | xxx | 2 msgs | v1
 *
 * 列表是按时间倒序，第一条就是最新。
 *
 * 注意：kiro-cli 把 list-sessions 的输出写到 stderr 而非 stdout，
 *       所以这里用 all:true 合并两边再 grep。
 */
async function getLatestSessionId(cwd: string, binPath: string): Promise<string | undefined> {
  const result = await execa(binPath, ['chat', '--list-sessions'], {
    cwd,
    reject: false,
    timeout: 10_000,
    all: true,
  });
  if (result.exitCode !== 0) return undefined;
  const combined = (result.all ?? result.stdout ?? '') as string;
  const text = stripAnsi(combined);
  const m = text.match(/Chat SessionId:\s*([0-9a-f-]{36})/i);
  return m?.[1];
}

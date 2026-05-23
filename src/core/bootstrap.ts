/**
 * 启动函数：加载配置 → 装配各模块 → 启动事件循环。
 *
 * 调用方（CLI 的 run 命令、或者外部嵌入）只需要：
 *   await runBridge();
 * 然后等 SIGINT/SIGTERM 来收尾。
 */
import { loadConfig } from '../lib/config.js';
import { getLogger, pruneOldLogs } from '../lib/logger.js';
import { LarkClient } from '../lark/client.js';
import { pruneOldMedia } from '../lark/media.js';
import { SessionStore } from '../store/sessions.js';
import { WorkspaceStore } from '../store/workspaces.js';
import { Dispatcher } from './dispatcher.js';
import { registerSelf, unregisterSelf, listProcesses } from '../daemon/registry.js';

export interface RunBridgeHandle {
  /** 主动停止；返回 promise 在所有清理完成后 resolve */
  stop: () => Promise<void>;
}

export async function runBridge(): Promise<RunBridgeHandle> {
  const log = getLogger();
  const config = loadConfig();
  log.info(
    {
      appId: config.lark.appId,
      defaultCwd: config.workspace.defaultCwd,
      allowedRoots: config.workspace.allowedRoots,
      trustedTools: config.kiro.trustedTools,
      idleTimeoutMinutes: config.kiro.idleTimeoutMinutes,
    },
    'lark-kiro-bridge starting',
  );

  // 启动清理：日志（覆盖 logger 里的默认 7 天） + 24h 前的媒体
  pruneOldLogs(config.preferences.logRetentionDays);
  pruneOldMedia(24);

  // 同 app 多实例检测
  const others = (await listProcesses()).filter(
    (p) => p.appId === config.lark.appId && p.pid !== process.pid,
  );
  if (others.length > 0) {
    log.warn(
      { others: others.map((p) => ({ pid: p.pid, shortId: p.shortId })) },
      'another bridge process is running with the same appId; Lark events may be routed randomly between them',
    );
  }

  await registerSelf(config.lark.appId);

  const lark = new LarkClient({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
    logger: log,
  });
  const sessions = new SessionStore();
  const workspaces = new WorkspaceStore();

  // 当前实现里 lark 实例不会被替换（reconnect 复用同一实例），所以是 const。
  // 如果未来需要在 reconnect 时换新实例（比如换 appId），把这里改成 let 即可。
  const larkRef = lark;

  const startEventLoop = async (): Promise<void> => {
    await larkRef.startEventLoop({
      onMessage: (msg) => dispatcher.handle(msg),
      onCardAction: (evt) => dispatcher.handleCardAction(evt),
      onReady: () => log.info('🚀 lark-kiro-bridge ready, waiting for messages'),
    });
  };

  const dispatcher = new Dispatcher({
    config,
    lark,
    sessions,
    workspaces,
    logger: log,
    onReconnect: async () => {
      log.info('reconnect requested via /reconnect');
      try {
        larkRef.close();
      } catch (e) {
        log.warn({ err: e }, 'close before reconnect failed (ignored)');
      }
      // 等一拍再起，避免 SDK 内部状态没清干净
      await new Promise((r) => setTimeout(r, 500));
      await startEventLoop();
    },
  });

  await startEventLoop();

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    log.info('shutting down');
    try {
      larkRef.close();
    } catch {
      // ignore
    }
    await unregisterSelf().catch(() => undefined);
  };

  // 注册信号处理（CLI 入口也会注册，这里冗余一次保险）
  const signalHandler = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'received signal');
    await stop();
    process.exit(0);
  };
  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);

  return { stop };
}

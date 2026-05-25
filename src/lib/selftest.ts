/**
 * `/selftest` 命令的核心检查逻辑
 *
 * 设计原则：
 *   - 纯检查，不动任何状态（不发消息、不建 cron、不改 config）
 *   - 每项独立 try/catch，单项失败不影响其他项
 *   - 超时控制：调外部进程的项必须有超时（默认 3s）
 *   - 不连飞书 API（避免触发 rate limit / 计费）；只检查本地状态
 *
 * 9 个检查项分三组：
 *   配置组：1-3      Config / 数据目录 / kiro-cli 可达性
 *   运行组：4-6      WebSocket / Token / cron store
 *   策略组：7-9      工作目录白名单 / 信任工具 / 用户访问权限
 *
 * 调用方（dispatcher.handleSelftestCmd）拿到 SelftestReport 后渲染卡片。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync, accessSync, constants as fsConst, readFileSync } from 'node:fs';
import type { Config } from './config.js';
import { DATA_DIR, LOGS_DIR, CONFIG_FILE, CRON_FILE } from './paths.js';

const execFileAsync = promisify(execFile);

export type CheckLevel = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  /** 项编号（用于卡片排序）*/
  id: number;
  /** 项名称，简短中文 */
  name: string;
  /** 等级 */
  level: CheckLevel;
  /** 一行说明，告诉用户这项检查的结果 / 错误详情 */
  detail: string;
}

export interface SelftestReport {
  results: CheckResult[];
  /** 整体结论 */
  summary: { ok: number; warn: number; fail: number; skip: number };
  /** 跑完用时 ms */
  durationMs: number;
}

/** 每个检查项的输入：拿到 config + bridge 自己的运行时上下文 */
export interface SelftestCtx {
  config: Config;
  /** 当前调用者的 open_id（用于检查访问权限）*/
  senderOpenId: string;
  /** 飞书 WebSocket 是否连上（由 dispatcher 注入）*/
  wsConnected: boolean;
  /** 飞书 token 缓存是否已建立（由 dispatcher 注入）*/
  hasTokenCache: boolean;
  /** kiro-cli bin path，从 config.kiro.binPath 拿；隔离开方便 mock */
  kiroBinPath: string;
}

/**
 * 跑全部检查，按 id 顺序返回。
 *
 * 每项内部 try/catch 兜底，**不会抛**——卡片渲染层不需要再做错误处理。
 */
export async function runSelfChecks(ctx: SelftestCtx): Promise<SelftestReport> {
  const start = Date.now();
  const results: CheckResult[] = [];

  results.push(checkConfig(ctx));
  results.push(checkDataDirs());
  results.push(await checkKiroCli(ctx.kiroBinPath));
  results.push(checkWebSocket(ctx));
  results.push(checkTokenCache(ctx));
  results.push(checkCronStore());
  results.push(checkAllowedRoots(ctx));
  results.push(checkTrustedTools(ctx));
  results.push(checkAccess(ctx));

  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) summary[r.level]++;

  return { results, summary, durationMs: Date.now() - start };
}

// ----- 检查项实现 -----

/**
 * 1. 配置文件加载状态
 *
 * 已经能进到这个函数说明 config 加载成功了，所以不会 fail；只校验关键字段非空。
 */
function checkConfig(ctx: SelftestCtx): CheckResult {
  try {
    const { appId, appSecret } = ctx.config.lark;
    if (!appId || !appSecret) {
      return mk(1, '配置文件', 'fail', 'lark.appId 或 appSecret 为空');
    }
    if (!appId.startsWith('cli_')) {
      return mk(1, '配置文件', 'warn', `appId 不是 cli_ 开头：${appId}（飞书新版规范）`);
    }
    return mk(1, '配置文件', 'ok', `已加载 ${CONFIG_FILE}（appId=${appId}）`);
  } catch (e) {
    return mk(1, '配置文件', 'fail', (e as Error).message);
  }
}

/**
 * 2. 数据目录可读可写
 *
 * 检查 ~/.lark-kiro-bridge/ 及子目录存在 + 权限正确。
 * sessions.json / cron.json 不强制存在（用户可能没用过），存在的话校验可读。
 */
function checkDataDirs(): CheckResult {
  try {
    if (!existsSync(DATA_DIR)) {
      return mk(2, '数据目录', 'fail', `${DATA_DIR} 不存在`);
    }
    accessSync(DATA_DIR, fsConst.R_OK | fsConst.W_OK);
    accessSync(LOGS_DIR, fsConst.R_OK | fsConst.W_OK);
    // 权限：DATA_DIR 应该是 0700（包含敏感凭证）
    const st = statSync(DATA_DIR);
    const mode = st.mode & 0o777;
    if (mode !== 0o700) {
      return mk(
        2,
        '数据目录',
        'warn',
        `${DATA_DIR} 权限是 ${mode.toString(8)}，建议 700（chmod -R 700 ~/.lark-kiro-bridge）`,
      );
    }
    return mk(2, '数据目录', 'ok', `${DATA_DIR} 可读可写，权限 700`);
  } catch (e) {
    return mk(2, '数据目录', 'fail', (e as Error).message);
  }
}

/**
 * 3. kiro-cli 可达性
 *
 * 跑 `kiro-cli --version`，3s 超时。失败说明 binPath 错或者 kiro-cli 没装。
 */
async function checkKiroCli(binPath: string): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync(binPath, ['--version'], { timeout: 3000 });
    const version = stdout.trim().split('\n')[0] ?? '(no version output)';
    return mk(3, 'kiro-cli', 'ok', `可达，${version}`);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return mk(3, 'kiro-cli', 'fail', `${binPath} 不在 PATH 中或路径错误`);
    }
    if ((err as { code?: string }).code === 'ETIMEDOUT') {
      return mk(3, 'kiro-cli', 'fail', `${binPath} --version 超时（>3s）`);
    }
    return mk(3, 'kiro-cli', 'fail', `${binPath} 调用失败：${err.message}`);
  }
}

/**
 * 4. WebSocket 连接状态
 */
function checkWebSocket(ctx: SelftestCtx): CheckResult {
  if (ctx.wsConnected) {
    return mk(4, '飞书 WebSocket', 'ok', '已连接');
  }
  return mk(4, '飞书 WebSocket', 'fail', '未连接，bot 无法收消息。试试 /reconnect 或检查网络');
}

/**
 * 5. 飞书 API token 缓存
 *
 * SDK 内部会做 token 缓存；如果第一次用还没拿过，就是 warn 不是 fail。
 */
function checkTokenCache(ctx: SelftestCtx): CheckResult {
  if (ctx.hasTokenCache) {
    return mk(5, '飞书 API token', 'ok', '缓存已建立');
  }
  return mk(5, '飞书 API token', 'warn', '尚未首次获取（发一条消息后再跑自检即可看到 ok）');
}

/**
 * 6. cron store 文件可读
 *
 * cron.json 不存在不算错（用户没用过）；存在但解析失败才 fail。
 */
function checkCronStore(): CheckResult {
  try {
    if (!existsSync(CRON_FILE)) {
      return mk(6, '定时任务存储', 'ok', '文件不存在（还没创建过任务，正常）');
    }
    const raw = readFileSync(CRON_FILE, 'utf-8');
    if (!raw.trim()) {
      return mk(6, '定时任务存储', 'ok', '空文件');
    }
    const parsed = JSON.parse(raw);
    const taskCount = Array.isArray(parsed?.tasks) ? parsed.tasks.length : 0;
    return mk(6, '定时任务存储', 'ok', `${CRON_FILE} 可读，${taskCount} 条任务`);
  } catch (e) {
    return mk(6, '定时任务存储', 'fail', `cron.json 解析失败：${(e as Error).message}`);
  }
}

/**
 * 7. 工作目录白名单
 *
 * defaultCwd 必须存在 + 在 allowedRoots 之内。
 */
function checkAllowedRoots(ctx: SelftestCtx): CheckResult {
  const { defaultCwd, allowedRoots } = ctx.config.workspace;
  if (!existsSync(defaultCwd)) {
    return mk(7, '工作目录', 'fail', `defaultCwd 不存在：${defaultCwd}`);
  }
  if (allowedRoots.length === 0) {
    return mk(7, '工作目录', 'warn', 'allowedRoots 为空，/cd 可以去任何地方（团队场景请收紧）');
  }
  // defaultCwd 必须在某个 allowedRoot 之下
  const ok = allowedRoots.some((root) => defaultCwd === root || defaultCwd.startsWith(root + '/'));
  if (!ok) {
    return mk(
      7,
      '工作目录',
      'fail',
      `defaultCwd ${defaultCwd} 不在 allowedRoots 任何一个之下：${allowedRoots.join(', ')}`,
    );
  }
  return mk(7, '工作目录', 'ok', `defaultCwd 合法，${allowedRoots.length} 个 allowedRoot`);
}

/**
 * 8. trustedTools 配置
 *
 * 检查 execute_bash 是否在列表里——这是之前飞书 fetch 卡死的根因之一。
 */
function checkTrustedTools(ctx: SelftestCtx): CheckResult {
  const tools = ctx.config.kiro.trustedTools;
  if (tools.length === 0) {
    return mk(
      8,
      '信任工具',
      'warn',
      'trustedTools 为空，Kiro 跑任何工具都会卡在等审批（--no-interactive 下永远等不到）',
    );
  }
  const hasBash = tools.includes('execute_bash');
  if (!hasBash) {
    return mk(
      8,
      '信任工具',
      'warn',
      `当前 ${tools.length} 个工具但**不含 execute_bash**——Kiro 想跑 shell（如 lark-cli）会挂死`,
    );
  }
  return mk(8, '信任工具', 'ok', `${tools.length} 个，包含 execute_bash`);
}

/**
 * 9. 当前用户访问权限
 *
 * 看 senderOpenId 是不是在 allowedUsers / admins 内。
 */
function checkAccess(ctx: SelftestCtx): CheckResult {
  const { allowedUsers, admins } = ctx.config.access;
  const me = ctx.senderOpenId;
  const inAllowed = allowedUsers.length === 0 || allowedUsers.includes(me);
  const isAdmin = admins.length === 0 || admins.includes(me);

  if (!inAllowed) {
    return mk(9, '访问权限', 'fail', '当前用户不在 allowedUsers 内（自检本身能跑说明 bug）');
  }
  const detail = isAdmin
    ? `${me.slice(0, 12)}… 是管理员，可跑全部命令`
    : `${me.slice(0, 12)}… 是普通用户（/config /cd 等管理员命令会被拒）`;
  return mk(9, '访问权限', 'ok', detail);
}

// ----- 工具 -----

function mk(id: number, name: string, level: CheckLevel, detail: string): CheckResult {
  return { id, name, level, detail };
}

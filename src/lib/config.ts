/**
 * 配置文件 schema 与加载逻辑
 *
 * 配置文件路径：~/.lark-kiro-bridge/config.json
 *
 * 字段：
 *  - lark.appId / lark.appSecret：飞书自建应用凭证
 *  - kiro.binPath：kiro-cli 可执行文件路径，默认 'kiro-cli'（PATH 中查找）
 *  - kiro.trustedTools：允许 Kiro 自动调用的工具列表
 *  - kiro.timeoutMs：单次 Kiro 任务超时（毫秒）
 *  - workspace.defaultCwd：未设置过 cwd 的会话默认工作目录
 *  - workspace.allowedRoots：白名单根目录，所有 /cd 必须落在这些根之下
 *  - access.allowedUsers / allowedChats / admins：访问控制
 *  - preferences.requireMentionInGroup：群里是否必须 @bot 才回复
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { z } from 'zod';
import { CONFIG_FILE, ensureDataDirs } from './paths.js';

export const ConfigSchema = z.object({
  lark: z.object({
    appId: z.string().min(1),
    appSecret: z.string().min(1),
  }),
  kiro: z
    .object({
      binPath: z.string().default('kiro-cli'),
      trustedTools: z
        .array(z.string())
        .default(['fs_read', 'fs_write', 'grep', 'glob', 'code']),
      timeoutMs: z.number().int().positive().default(10 * 60 * 1000),
      /**
       * 默认 idle watchdog（分钟）。0 = 关闭。
       * stdout 连续这么久没新输出就当作 kiro-cli 假死，killTree。
       * /timeout N 可以临时为某个 chat 覆盖。
       */
      idleTimeoutMinutes: z.number().int().nonnegative().default(5),
      model: z.string().optional(),
      agent: z.string().optional(),
    })
    .default({}),
  workspace: z
    .object({
      defaultCwd: z.string().default('/Users/administrator/PycharmProjects'),
      allowedRoots: z
        .array(z.string())
        .default(['/Users/administrator/PycharmProjects']),
    })
    .default({}),
  access: z
    .object({
      allowedUsers: z.array(z.string()).default([]),
      allowedChats: z.array(z.string()).default([]),
      admins: z.array(z.string()).default([]),
    })
    .default({}),
  preferences: z
    .object({
      requireMentionInGroup: z.boolean().default(true),
      cardUpdateIntervalMs: z.number().int().positive().default(800),
      /** 启动时清理多少天之前的日志文件 */
      logRetentionDays: z.number().int().positive().default(7),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * 从磁盘加载配置；不存在则抛错（让 CLI 引导用户跑 init/wizard）。
 */
export function loadConfig(): Config {
  ensureDataDirs();
  if (!existsSync(CONFIG_FILE)) {
    throw new ConfigError(
      `Config file not found at ${CONFIG_FILE}. Run \`lark-kiro-bridge init\` to create one.`,
    );
  }
  const raw = readFileSync(CONFIG_FILE, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`Config file is not valid JSON: ${(e as Error).message}`);
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Config validation failed:\n${result.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return result.data;
}

/**
 * 写入配置文件，权限 0600。
 */
export function saveConfig(cfg: Config): void {
  ensureDataDirs();
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
}

/**
 * 把内存里的 Config 应用一个 patch 后落盘。
 * 调用方用 mutator 直接改字段（推荐 immutable 风格：返回新对象也行）。
 *
 * 实现细节：写之前 deep-clone，避免外部 mutator 把传入的 cfg 改坏；
 * 写完用 ConfigSchema 再 parse 一遍兜底，防止 patch 写出非法值。
 */
export function patchAndSaveConfig(cfg: Config, mutator: (draft: Config) => void): Config {
  const draft = JSON.parse(JSON.stringify(cfg)) as Config;
  mutator(draft);
  const validated = ConfigSchema.parse(draft);
  saveConfig(validated);
  return validated;
}

/**
 * 生成最小可用的配置模板，供 init 命令使用。
 */
export function defaultConfig(appId: string, appSecret: string): Config {
  return ConfigSchema.parse({
    lark: { appId, appSecret },
  });
}

/**
 * 数据目录与文件路径常量
 * 所有持久化数据放在 ~/.lark-kiro-bridge/
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const DATA_DIR = join(homedir(), '.lark-kiro-bridge');
export const LOGS_DIR = join(DATA_DIR, 'logs');
export const MEDIA_DIR = join(DATA_DIR, 'media');

export const CONFIG_FILE = join(DATA_DIR, 'config.json');
export const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');
export const WORKSPACES_FILE = join(DATA_DIR, 'workspaces.json');
export const PROCESSES_FILE = join(DATA_DIR, 'processes.json');
export const CRON_FILE = join(DATA_DIR, 'cron.json');

/**
 * 确保数据目录存在；权限 0700（只有当前用户可访问，因为里面有 App Secret）。
 */
export function ensureDataDirs(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
}

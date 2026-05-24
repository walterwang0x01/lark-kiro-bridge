/**
 * Steering 文件管理（Kiro 的「内存文件」）
 *
 * Kiro 的 steering 机制：
 *   - 全局：~/.kiro/steering/*.md（每次启动都加载，跨项目）
 *   - 项目：<cwd>/.kiro/steering/*.md（只在该 cwd 下加载）
 *
 * 每个 .md 文件可选 frontmatter:
 *   ---
 *   inclusion: always | manual | fileMatch
 *   fileMatchPattern: 'README*'   # 仅 fileMatch 时
 *   ---
 *
 * 这个模块提供 list/get/save/delete，**完全在用户机器上**：
 *   - npm 包不带任何 steering 内容
 *   - 不同用户的 steering 互相独立
 *
 * 安全要求：
 *   - 文件名只允许 [a-zA-Z0-9._-]+，禁止 / .. 路径穿越
 *   - 强制 .md 后缀
 *   - 不允许操作非 steering 文件（README.md / sync.sh 等可能存在但归特殊用途）
 */
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export type SteeringScope = 'global' | 'project';

export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryError';
  }
}

/**
 * 解析 scope + cwd 得到 steering 目录路径。
 *
 * - global → ~/.kiro/steering/
 * - project → <cwd>/.kiro/steering/
 */
export function resolveSteeringDir(scope: SteeringScope, cwd: string): string {
  return scope === 'global' ? join(homedir(), '.kiro', 'steering') : join(cwd, '.kiro', 'steering');
}

/**
 * 文件名安全校验。返回错误信息字符串数组，空 = 通过。
 *
 * 规则：
 *   1. 不为空
 *   2. 只允许字母数字 . _ -
 *   3. 不能以 . 开头（防隐藏文件）
 *   4. 必须以 .md 结尾
 *   5. 不含 / 或 ..（路径穿越）
 *   6. 长度 ≤ 64
 */
export function validateFilename(name: string): string[] {
  const errors: string[] = [];
  const trimmed = name.trim();
  if (!trimmed) {
    errors.push('文件名不能为空');
    return errors;
  }
  if (trimmed.length > 64) errors.push('文件名长度不能超过 64 字符');
  if (trimmed.startsWith('.')) errors.push('文件名不能以 . 开头');
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    errors.push('文件名不能包含 / \\ ..');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    errors.push('文件名只允许字母、数字、. _ -');
  }
  if (!trimmed.endsWith('.md')) errors.push('文件名必须以 .md 结尾');
  return errors;
}

/** 规范化文件名：去空格 + 强制加 .md 后缀（如果没带） */
export function normalizeFilename(name: string): string {
  const trimmed = name.trim();
  return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
}

export interface MemoryFileMeta {
  name: string;
  /** 文件大小（字节） */
  size: number;
  /** 修改时间戳（毫秒） */
  modifiedAt: number;
}

export class MemoryStore {
  /**
   * 列出指定 scope 下所有 .md steering 文件。
   * 目录不存在 = 返回空数组（不报错，调用方按需建目录）。
   */
  list(scope: SteeringScope, cwd: string): MemoryFileMeta[] {
    const dir = resolveSteeringDir(scope, cwd);
    if (!existsSync(dir)) return [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const out: MemoryFileMeta[] = [];
    for (const n of names) {
      // 只列 .md，忽略隐藏文件 / 子目录 / 其他后缀（README.md 这种正经 md 也展示）
      if (!n.endsWith('.md')) continue;
      if (n.startsWith('.')) continue;
      try {
        const st = statSync(join(dir, n));
        if (!st.isFile()) continue;
        out.push({
          name: n,
          size: st.size,
          modifiedAt: st.mtimeMs,
        });
      } catch {
        // ignore
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 读取文件内容。文件不存在抛 MemoryError。
   */
  get(scope: SteeringScope, cwd: string, name: string): string {
    const errors = validateFilename(name);
    if (errors.length > 0) throw new MemoryError(errors.join('; '));
    const dir = resolveSteeringDir(scope, cwd);
    const path = join(dir, basename(name));
    if (!existsSync(path)) {
      throw new MemoryError(`文件不存在：${path}`);
    }
    return readFileSync(path, 'utf-8');
  }

  /**
   * 写入文件（创建或覆盖）。
   * 自动创建 steering 目录。
   * 写入前会做安全校验：文件名合法、内容大小 ≤ 100KB（防止误传超长内容）。
   */
  save(scope: SteeringScope, cwd: string, name: string, content: string): void {
    const errors = validateFilename(name);
    if (errors.length > 0) throw new MemoryError(errors.join('; '));
    if (content.length > 100_000) {
      throw new MemoryError('内容超过 100KB，过大的 steering 文件请用本地编辑器');
    }
    const dir = resolveSteeringDir(scope, cwd);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, basename(name));
    writeFileSync(path, content, 'utf-8');
  }

  /**
   * 删除文件。文件不存在 = 静默通过（幂等）。
   */
  delete(scope: SteeringScope, cwd: string, name: string): boolean {
    const errors = validateFilename(name);
    if (errors.length > 0) throw new MemoryError(errors.join('; '));
    const dir = resolveSteeringDir(scope, cwd);
    const path = join(dir, basename(name));
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }
}

/**
 * 解析 frontmatter 的 inclusion 字段（用于在卡片上展示加载策略）。
 * 极简实现：只看前 50 行内的 ---...--- 块。失败默认返回 always（Kiro 默认）。
 */
export function extractInclusion(content: string): string {
  const lines = content.split('\n').slice(0, 50);
  if (lines[0]?.trim() !== '---') return 'always';
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') break;
    const m = line.match(/^inclusion:\s*(.+?)\s*$/);
    if (m) return (m[1] ?? 'always').trim();
  }
  return 'always';
}

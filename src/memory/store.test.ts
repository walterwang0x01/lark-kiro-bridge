// MemoryStore 单元测试：文件名安全校验、读写删除、frontmatter 解析
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MemoryStore,
  validateFilename,
  normalizeFilename,
  extractInclusion,
  MemoryError,
} from './store.js';

let tmpCwd: string;

beforeEach(() => {
  tmpCwd = mkdtempSync(join(tmpdir(), 'lkb-mem-test-'));
});

afterEach(() => {
  rmSync(tmpCwd, { recursive: true, force: true });
});

describe('validateFilename', () => {
  it('合法名通过', () => {
    expect(validateFilename('foo.md')).toEqual([]);
    expect(validateFilename('language-chinese.md')).toEqual([]);
    expect(validateFilename('work_methodology.md')).toEqual([]);
    expect(validateFilename('a1.md')).toEqual([]);
  });

  it('空名拒绝', () => {
    expect(validateFilename('').length).toBeGreaterThan(0);
    expect(validateFilename('   ').length).toBeGreaterThan(0);
  });

  it('路径穿越拒绝', () => {
    expect(validateFilename('../etc/passwd.md').length).toBeGreaterThan(0);
    expect(validateFilename('foo/bar.md').length).toBeGreaterThan(0);
    expect(validateFilename('foo\\bar.md').length).toBeGreaterThan(0);
  });

  it('不带 .md 拒绝', () => {
    expect(validateFilename('foo').length).toBeGreaterThan(0);
    expect(validateFilename('foo.txt').length).toBeGreaterThan(0);
  });

  it('特殊字符拒绝', () => {
    expect(validateFilename('foo bar.md').length).toBeGreaterThan(0);
    expect(validateFilename('foo$.md').length).toBeGreaterThan(0);
    expect(validateFilename('foo;rm.md').length).toBeGreaterThan(0);
  });

  it('隐藏文件拒绝', () => {
    expect(validateFilename('.hidden.md').length).toBeGreaterThan(0);
  });

  it('过长拒绝', () => {
    const long = 'a'.repeat(70) + '.md';
    expect(validateFilename(long).length).toBeGreaterThan(0);
  });
});

describe('normalizeFilename', () => {
  it('已带 .md 不动', () => {
    expect(normalizeFilename('foo.md')).toBe('foo.md');
  });
  it('未带 .md 自动加', () => {
    expect(normalizeFilename('foo')).toBe('foo.md');
  });
  it('去前后空格', () => {
    expect(normalizeFilename('  foo  ')).toBe('foo.md');
  });
});

describe('MemoryStore.list', () => {
  it('目录不存在返回空', () => {
    const s = new MemoryStore();
    expect(s.list('project', tmpCwd)).toEqual([]);
  });

  it('列出 .md 文件并按名排序', () => {
    const dir = join(tmpCwd, '.kiro', 'steering');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'b.md'), 'b');
    writeFileSync(join(dir, 'a.md'), 'a');
    writeFileSync(join(dir, 'c.md'), 'c');
    const s = new MemoryStore();
    const list = s.list('project', tmpCwd);
    expect(list.map((f) => f.name)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(list[0]?.size).toBe(1);
  });

  it('忽略非 .md 文件、隐藏文件、目录', () => {
    const dir = join(tmpCwd, '.kiro', 'steering');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.md'), 'a');
    writeFileSync(join(dir, 'b.txt'), 'b');
    writeFileSync(join(dir, '.hidden.md'), 'h');
    mkdirSync(join(dir, 'subdir'));
    const s = new MemoryStore();
    expect(s.list('project', tmpCwd).map((f) => f.name)).toEqual(['a.md']);
  });
});

describe('MemoryStore.get / save / delete', () => {
  it('save 自动建目录', () => {
    const s = new MemoryStore();
    s.save('project', tmpCwd, 'new.md', 'hello');
    expect(existsSync(join(tmpCwd, '.kiro', 'steering', 'new.md'))).toBe(true);
  });

  it('save 后能 get', () => {
    const s = new MemoryStore();
    s.save('project', tmpCwd, 'foo.md', 'content here');
    expect(s.get('project', tmpCwd, 'foo.md')).toBe('content here');
  });

  it('get 不存在的文件抛错', () => {
    const s = new MemoryStore();
    expect(() => s.get('project', tmpCwd, 'noexist.md')).toThrow(MemoryError);
  });

  it('delete 已存在 → true，再次 delete → false', () => {
    const s = new MemoryStore();
    s.save('project', tmpCwd, 'gone.md', 'x');
    expect(s.delete('project', tmpCwd, 'gone.md')).toBe(true);
    expect(s.delete('project', tmpCwd, 'gone.md')).toBe(false);
  });

  it('save 内容超 100KB 抛错', () => {
    const s = new MemoryStore();
    const huge = 'a'.repeat(100_001);
    expect(() => s.save('project', tmpCwd, 'big.md', huge)).toThrow(/100KB/);
  });

  it('save 非法文件名抛错', () => {
    const s = new MemoryStore();
    expect(() => s.save('project', tmpCwd, '../escape.md', 'x')).toThrow(MemoryError);
    expect(() => s.save('project', tmpCwd, 'foo bar.md', 'x')).toThrow(MemoryError);
  });

  it('save 覆盖现有文件', () => {
    const s = new MemoryStore();
    s.save('project', tmpCwd, 'a.md', 'v1');
    s.save('project', tmpCwd, 'a.md', 'v2');
    expect(s.get('project', tmpCwd, 'a.md')).toBe('v2');
  });
});

describe('extractInclusion', () => {
  it('无 frontmatter 默认 always', () => {
    expect(extractInclusion('# Hello\n\nbody')).toBe('always');
  });

  it('frontmatter inclusion always', () => {
    const md = '---\ninclusion: always\n---\n\n# title';
    expect(extractInclusion(md)).toBe('always');
  });

  it('frontmatter inclusion manual', () => {
    const md = '---\ninclusion: manual\n---\n\n# title';
    expect(extractInclusion(md)).toBe('manual');
  });

  it('frontmatter inclusion fileMatch', () => {
    const md = "---\ninclusion: fileMatch\nfileMatchPattern: 'README*'\n---\n\n# title";
    expect(extractInclusion(md)).toBe('fileMatch');
  });
});

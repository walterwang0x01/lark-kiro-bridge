// /selftest 核心检查的单元测试
// 重点覆盖每项的 ok/warn/fail 三种状态，不测 fs 真实状态（那是集成测试）。
import { describe, it, expect } from 'vitest';
import { runSelfChecks, type SelftestCtx } from './selftest.js';
import type { Config } from './config.js';

function mkConfig(overrides: Partial<Config> = {}): Config {
  return {
    lark: { appId: 'cli_test_xxx', appSecret: 'secret_xxx' },
    kiro: {
      binPath: 'kiro-cli',
      trustedTools: ['fs_read', 'fs_write', 'execute_bash'],
      timeoutMs: 600000,
      idleTimeoutMinutes: 5,
    },
    workspace: {
      defaultCwd: '/Users/administrator/PycharmProjects',
      allowedRoots: ['/Users/administrator/PycharmProjects'],
    },
    access: {
      allowedUsers: [],
      allowedChats: [],
      admins: [],
    },
    preferences: {
      requireMentionInGroup: true,
      cardUpdateIntervalMs: 800,
      logRetentionDays: 7,
    },
    ...overrides,
  } as Config;
}

function mkCtx(overrides: Partial<SelftestCtx> = {}): SelftestCtx {
  return {
    config: mkConfig(),
    senderOpenId: 'ou_test123456',
    wsConnected: true,
    hasTokenCache: true,
    kiroBinPath: '/bin/echo', // echo 一定存在
    ...overrides,
  };
}

/** 找出指定 id 的检查结果 */
function find(report: Awaited<ReturnType<typeof runSelfChecks>>, id: number) {
  const r = report.results.find((x) => x.id === id);
  if (!r) throw new Error(`no check result for id=${id}`);
  return r;
}

describe('runSelfChecks', () => {
  it('返回结构正确：9 项 + summary + duration', async () => {
    const r = await runSelfChecks(mkCtx());
    expect(r.results).toHaveLength(9);
    expect(r.results.map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.summary.ok + r.summary.warn + r.summary.fail + r.summary.skip).toBe(9);
  });
});

describe('check 1 - 配置文件', () => {
  it('ok — appId 是 cli_ 开头', async () => {
    const r = await runSelfChecks(mkCtx());
    expect(find(r, 1).level).toBe('ok');
  });

  it('warn — appId 不是 cli_ 开头', async () => {
    const cfg = mkConfig({ lark: { appId: 'old_format', appSecret: 'x' } });
    const r = await runSelfChecks(mkCtx({ config: cfg }));
    expect(find(r, 1).level).toBe('warn');
  });
});

describe('check 4 - WebSocket', () => {
  it('ok — wsConnected', async () => {
    const r = await runSelfChecks(mkCtx({ wsConnected: true }));
    expect(find(r, 4).level).toBe('ok');
  });

  it('fail — 未连接', async () => {
    const r = await runSelfChecks(mkCtx({ wsConnected: false }));
    expect(find(r, 4).level).toBe('fail');
  });
});

describe('check 5 - token 缓存', () => {
  it('ok — 缓存已建立', async () => {
    const r = await runSelfChecks(mkCtx({ hasTokenCache: true }));
    expect(find(r, 5).level).toBe('ok');
  });

  it('warn — 还没拿过', async () => {
    const r = await runSelfChecks(mkCtx({ hasTokenCache: false }));
    expect(find(r, 5).level).toBe('warn');
  });
});

describe('check 7 - 工作目录', () => {
  it('warn — allowedRoots 为空', async () => {
    const cfg = mkConfig({
      workspace: {
        defaultCwd: '/tmp',
        allowedRoots: [],
      },
    });
    const r = await runSelfChecks(mkCtx({ config: cfg }));
    expect(find(r, 7).level).toBe('warn');
  });

  it('fail — defaultCwd 不存在', async () => {
    const cfg = mkConfig({
      workspace: {
        defaultCwd: '/nope/does/not/exist/xyz',
        allowedRoots: ['/tmp'],
      },
    });
    const r = await runSelfChecks(mkCtx({ config: cfg }));
    expect(find(r, 7).level).toBe('fail');
  });

  it('fail — defaultCwd 不在 allowedRoots 内', async () => {
    const cfg = mkConfig({
      workspace: {
        defaultCwd: '/tmp',
        allowedRoots: ['/Users/somebody'],
      },
    });
    const r = await runSelfChecks(mkCtx({ config: cfg }));
    expect(find(r, 7).level).toBe('fail');
  });

  it('ok — defaultCwd 在 allowedRoots 内', async () => {
    const cfg = mkConfig({
      workspace: {
        defaultCwd: '/tmp',
        allowedRoots: ['/tmp'],
      },
    });
    const r = await runSelfChecks(mkCtx({ config: cfg }));
    expect(find(r, 7).level).toBe('ok');
  });
});

describe('check 8 - trustedTools', () => {
  it('ok — 含 execute_bash', async () => {
    const r = await runSelfChecks(mkCtx());
    expect(find(r, 8).level).toBe('ok');
  });

  it('warn — 为空', async () => {
    const cfg = mkConfig({
      kiro: {
        binPath: 'kiro-cli',
        trustedTools: [],
        timeoutMs: 1,
        idleTimeoutMinutes: 0,
      },
    });
    const r = await runSelfChecks(mkCtx({ config: cfg }));
    expect(find(r, 8).level).toBe('warn');
  });

  it('warn — 不含 execute_bash', async () => {
    const cfg = mkConfig({
      kiro: {
        binPath: 'kiro-cli',
        trustedTools: ['fs_read', 'fs_write'],
        timeoutMs: 1,
        idleTimeoutMinutes: 0,
      },
    });
    const r = await runSelfChecks(mkCtx({ config: cfg }));
    const c8 = find(r, 8);
    expect(c8.level).toBe('warn');
    expect(c8.detail).toContain('execute_bash');
  });
});

describe('check 9 - 访问权限', () => {
  it('ok — 不限制（admins 空）', async () => {
    const r = await runSelfChecks(mkCtx());
    const c9 = find(r, 9);
    expect(c9.level).toBe('ok');
    expect(c9.detail).toContain('管理员');
  });

  it('ok — 显式 admin', async () => {
    const cfg = mkConfig({
      access: {
        allowedUsers: [],
        allowedChats: [],
        admins: ['ou_test123456'],
      },
    });
    const r = await runSelfChecks(mkCtx({ config: cfg }));
    expect(find(r, 9).detail).toContain('管理员');
  });

  it('ok — 普通用户', async () => {
    const cfg = mkConfig({
      access: {
        allowedUsers: [],
        allowedChats: [],
        admins: ['ou_someone_else'],
      },
    });
    const r = await runSelfChecks(mkCtx({ config: cfg }));
    expect(find(r, 9).detail).toContain('普通用户');
  });

  it('fail — 不在 allowedUsers 内', async () => {
    const cfg = mkConfig({
      access: {
        allowedUsers: ['ou_someone_else'],
        allowedChats: [],
        admins: [],
      },
    });
    const r = await runSelfChecks(mkCtx({ config: cfg }));
    expect(find(r, 9).level).toBe('fail');
  });
});

describe('check 3 - kiro-cli 可达性', () => {
  it('fail — bin 不存在', async () => {
    const r = await runSelfChecks(mkCtx({ kiroBinPath: '/nope/no/kiro-cli-xyz' }));
    expect(find(r, 3).level).toBe('fail');
  }, 5000);

  it('ok — /bin/echo 跑成功', async () => {
    const r = await runSelfChecks(mkCtx({ kiroBinPath: '/bin/echo' }));
    expect(find(r, 3).level).toBe('ok');
  }, 5000);
});

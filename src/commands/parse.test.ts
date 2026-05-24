// parseCommand unit tests covering all kinds, aliases, kiro-internal interception,
// unknown fallthrough, plain text, and edge cases on missing/invalid args.
import { describe, it, expect } from 'vitest';
import { parseCommand } from './parse.js';

describe('parseCommand', () => {
  describe('非命令', () => {
    it('普通文本返回 null', () => {
      expect(parseCommand('hello world')).toBeNull();
    });

    it('空字符串返回 null', () => {
      expect(parseCommand('')).toBeNull();
    });

    it('只有空格返回 null', () => {
      expect(parseCommand('   ')).toBeNull();
    });

    it('"slash" 不算命令', () => {
      expect(parseCommand('slash')).toBeNull();
    });
  });

  describe('/new 与 /reset', () => {
    it('/new', () => {
      expect(parseCommand('/new')).toEqual({ kind: 'new' });
    });

    it('/reset 是 /new 的别名', () => {
      expect(parseCommand('/reset')).toEqual({ kind: 'new' });
    });

    it('/clear 是 /new 的别名（覆盖了 kiro-internal）', () => {
      expect(parseCommand('/clear')).toEqual({ kind: 'new' });
    });
  });

  describe('/cd', () => {
    it('/cd /path/to/dir', () => {
      expect(parseCommand('/cd /path/to/dir')).toEqual({
        kind: 'cd',
        path: '/path/to/dir',
      });
    });

    it('/cd ~/foo', () => {
      expect(parseCommand('/cd ~/foo')).toEqual({ kind: 'cd', path: '~/foo' });
    });

    it('/cd 缺参数返回 unknown', () => {
      expect(parseCommand('/cd')).toEqual({ kind: 'unknown', raw: '/cd' });
    });

    it('/cd 路径含空格', () => {
      // 注意：parse 用 split(/\s+/) + join(' ')，多空格会被压成单空格
      const r = parseCommand('/cd /path with space');
      expect(r).toEqual({ kind: 'cd', path: '/path with space' });
    });
  });

  describe('/pwd', () => {
    it('/pwd', () => {
      expect(parseCommand('/pwd')).toEqual({ kind: 'pwd' });
    });

    it('/cwd 是 /pwd 别名', () => {
      expect(parseCommand('/cwd')).toEqual({ kind: 'pwd' });
    });
  });

  describe('/ws', () => {
    it('/ws list', () => {
      expect(parseCommand('/ws list')).toEqual({ kind: 'ws-list' });
    });

    it('/ws 单独也按 list 处理', () => {
      expect(parseCommand('/ws')).toEqual({ kind: 'ws-list' });
    });

    it('/ws save brand', () => {
      expect(parseCommand('/ws save brand')).toEqual({
        kind: 'ws-save',
        name: 'brand',
      });
    });

    it('/ws use brand', () => {
      expect(parseCommand('/ws use brand')).toEqual({
        kind: 'ws-use',
        name: 'brand',
      });
    });

    it('/ws remove brand', () => {
      expect(parseCommand('/ws remove brand')).toEqual({
        kind: 'ws-remove',
        name: 'brand',
      });
    });

    it('/ws rm brand 是 remove 别名', () => {
      expect(parseCommand('/ws rm brand')).toEqual({
        kind: 'ws-remove',
        name: 'brand',
      });
    });

    it('/ws delete brand 是 remove 别名', () => {
      expect(parseCommand('/ws delete brand')).toEqual({
        kind: 'ws-remove',
        name: 'brand',
      });
    });

    it('/ws save 缺名字返回 unknown', () => {
      expect(parseCommand('/ws save')).toEqual({
        kind: 'unknown',
        raw: '/ws save',
      });
    });

    it('/ws unknown_sub 返回 unknown', () => {
      expect(parseCommand('/ws foo bar')).toEqual({
        kind: 'unknown',
        raw: '/ws foo bar',
      });
    });
  });

  describe('/status 与 /stop', () => {
    it('/status', () => {
      expect(parseCommand('/status')).toEqual({ kind: 'status' });
    });

    it('/s 是 /status 别名', () => {
      expect(parseCommand('/s')).toEqual({ kind: 'status' });
    });

    it('/stat 是 /status 别名', () => {
      expect(parseCommand('/stat')).toEqual({ kind: 'status' });
    });

    it('/stop', () => {
      expect(parseCommand('/stop')).toEqual({ kind: 'stop' });
    });

    it('/abort 是 /stop 别名', () => {
      expect(parseCommand('/abort')).toEqual({ kind: 'stop' });
    });

    it('/cancel 是 /stop 别名', () => {
      expect(parseCommand('/cancel')).toEqual({ kind: 'stop' });
    });
  });

  describe('/timeout', () => {
    it('/timeout 不带参数 → show', () => {
      expect(parseCommand('/timeout')).toEqual({ kind: 'timeout', mode: 'show' });
    });

    it('/timeout 5 → set 5', () => {
      expect(parseCommand('/timeout 5')).toEqual({
        kind: 'timeout',
        mode: 'set',
        minutes: 5,
      });
    });

    it('/timeout off → off', () => {
      expect(parseCommand('/timeout off')).toEqual({ kind: 'timeout', mode: 'off' });
    });

    it('/timeout 0 → off', () => {
      expect(parseCommand('/timeout 0')).toEqual({ kind: 'timeout', mode: 'off' });
    });

    it('/timeout disable → off', () => {
      expect(parseCommand('/timeout disable')).toEqual({ kind: 'timeout', mode: 'off' });
    });

    it('/timeout default → default', () => {
      expect(parseCommand('/timeout default')).toEqual({
        kind: 'timeout',
        mode: 'default',
      });
    });

    it('/timeout reset → default', () => {
      expect(parseCommand('/timeout reset')).toEqual({
        kind: 'timeout',
        mode: 'default',
      });
    });

    it('/to 是 /timeout 别名', () => {
      expect(parseCommand('/to 10')).toEqual({
        kind: 'timeout',
        mode: 'set',
        minutes: 10,
      });
    });

    it('小数被 floor', () => {
      expect(parseCommand('/timeout 5.7')).toEqual({
        kind: 'timeout',
        mode: 'set',
        minutes: 5,
      });
    });

    it('超过 600 分钟返回 unknown', () => {
      expect(parseCommand('/timeout 601')).toEqual({
        kind: 'unknown',
        raw: '/timeout 601',
      });
    });

    it('负数返回 unknown', () => {
      expect(parseCommand('/timeout -5')).toEqual({
        kind: 'unknown',
        raw: '/timeout -5',
      });
    });

    it('非数字返回 unknown', () => {
      expect(parseCommand('/timeout foo')).toEqual({
        kind: 'unknown',
        raw: '/timeout foo',
      });
    });
  });

  describe('/reconnect 与 /doctor', () => {
    it('/reconnect', () => {
      expect(parseCommand('/reconnect')).toEqual({ kind: 'reconnect' });
    });

    it('/rc 是 /reconnect 别名', () => {
      expect(parseCommand('/rc')).toEqual({ kind: 'reconnect' });
    });

    it('/reconect typo 修正', () => {
      expect(parseCommand('/reconect')).toEqual({ kind: 'reconnect' });
    });

    it('/doctor 不带描述', () => {
      expect(parseCommand('/doctor')).toEqual({ kind: 'doctor', description: '' });
    });

    it('/doctor 带描述', () => {
      expect(parseCommand('/doctor 卡住了')).toEqual({
        kind: 'doctor',
        description: '卡住了',
      });
    });
  });

  describe('/model', () => {
    it('/model 不带参数 → show', () => {
      expect(parseCommand('/model')).toEqual({ kind: 'model', mode: 'show' });
    });

    it('/model claude-opus-4.7 → set', () => {
      expect(parseCommand('/model claude-opus-4.7')).toEqual({
        kind: 'model',
        mode: 'set',
        name: 'claude-opus-4.7',
      });
    });

    it('/model auto → reset', () => {
      expect(parseCommand('/model auto')).toEqual({ kind: 'model', mode: 'reset' });
    });

    it('/model default → reset', () => {
      expect(parseCommand('/model default')).toEqual({ kind: 'model', mode: 'reset' });
    });

    it('/model reset → reset', () => {
      expect(parseCommand('/model reset')).toEqual({ kind: 'model', mode: 'reset' });
    });

    it('/m 是 /model 别名', () => {
      expect(parseCommand('/m')).toEqual({ kind: 'model', mode: 'show' });
    });

    it('/mod 是 /model 别名', () => {
      expect(parseCommand('/mod claude-3')).toEqual({
        kind: 'model',
        mode: 'set',
        name: 'claude-3',
      });
    });

    it('/modle typo 修正', () => {
      expect(parseCommand('/modle')).toEqual({ kind: 'model', mode: 'show' });
    });

    it('包含非法字符的模型名返回 unknown', () => {
      expect(parseCommand('/model bad name')).toEqual({
        kind: 'unknown',
        raw: '/model bad name',
      });
    });

    it('模型名超过 64 字符返回 unknown', () => {
      const longName = 'a'.repeat(65);
      expect(parseCommand(`/model ${longName}`)).toEqual({
        kind: 'unknown',
        raw: `/model ${longName}`,
      });
    });
  });

  describe('/help', () => {
    it('/help', () => {
      expect(parseCommand('/help')).toEqual({ kind: 'help' });
    });

    it('/h 是 /help 别名', () => {
      expect(parseCommand('/h')).toEqual({ kind: 'help' });
    });

    it('/? 是 /help 别名', () => {
      expect(parseCommand('/?')).toEqual({ kind: 'help' });
    });
  });

  describe('/config', () => {
    it('/config', () => {
      expect(parseCommand('/config')).toEqual({ kind: 'config', mode: 'show' });
    });

    it('/cfg 是 /config 别名', () => {
      expect(parseCommand('/cfg')).toEqual({ kind: 'config', mode: 'show' });
    });

    it('/settings 是 /config 别名', () => {
      expect(parseCommand('/settings')).toEqual({ kind: 'config', mode: 'show' });
    });
  });

  describe('/ps 与 /exit', () => {
    it('/ps', () => {
      expect(parseCommand('/ps')).toEqual({ kind: 'ps' });
    });

    it('/exit <shortId>', () => {
      expect(parseCommand('/exit abc123')).toEqual({ kind: 'exit', target: 'abc123' });
    });

    it('/exit #1', () => {
      expect(parseCommand('/exit #1')).toEqual({ kind: 'exit', target: '#1' });
    });

    it('/exit 没参数 → unknown', () => {
      expect(parseCommand('/exit')).toEqual({ kind: 'unknown', raw: '/exit' });
    });

    it('/kill 是 /exit 别名', () => {
      expect(parseCommand('/kill 12345')).toEqual({ kind: 'exit', target: '12345' });
    });
  });

  describe('/steering（memory 管理）', () => {
    it('/steering 默认 list project', () => {
      expect(parseCommand('/steering')).toEqual({ kind: 'memory', mode: 'list', scope: 'project' });
    });
    it('/memory 是别名', () => {
      expect(parseCommand('/memory')).toEqual({ kind: 'memory', mode: 'list', scope: 'project' });
    });
    it('/mem 是别名', () => {
      expect(parseCommand('/mem')).toEqual({ kind: 'memory', mode: 'list', scope: 'project' });
    });
    it('/steering --global', () => {
      expect(parseCommand('/steering --global')).toEqual({
        kind: 'memory',
        mode: 'list',
        scope: 'global',
      });
    });
    it('/steering -g 短参', () => {
      expect(parseCommand('/steering -g')).toEqual({
        kind: 'memory',
        mode: 'list',
        scope: 'global',
      });
    });
    it('/steering view <name>', () => {
      expect(parseCommand('/steering view foo.md')).toEqual({
        kind: 'memory',
        mode: 'view',
        scope: 'project',
        name: 'foo.md',
      });
    });
    it('/steering <name> 无子命令直接 view', () => {
      expect(parseCommand('/steering foo.md')).toEqual({
        kind: 'memory',
        mode: 'view',
        scope: 'project',
        name: 'foo.md',
      });
    });
    it('/steering edit <name>', () => {
      expect(parseCommand('/steering edit foo.md')).toEqual({
        kind: 'memory',
        mode: 'edit',
        scope: 'project',
        name: 'foo.md',
      });
    });
    it('/steering new <name>', () => {
      expect(parseCommand('/steering new bar.md')).toEqual({
        kind: 'memory',
        mode: 'new',
        scope: 'project',
        name: 'bar.md',
      });
    });
    it('/steering rm <name>', () => {
      expect(parseCommand('/steering rm baz.md')).toEqual({
        kind: 'memory',
        mode: 'rm',
        scope: 'project',
        name: 'baz.md',
      });
    });
    it('/steering edit --global <name>（顺序灵活）', () => {
      expect(parseCommand('/steering edit --global foo.md')).toEqual({
        kind: 'memory',
        mode: 'edit',
        scope: 'global',
        name: 'foo.md',
      });
    });
    it('/steering --global edit <name>', () => {
      expect(parseCommand('/steering --global edit foo.md')).toEqual({
        kind: 'memory',
        mode: 'edit',
        scope: 'global',
        name: 'foo.md',
      });
    });
    it('/steering edit 没参数 → unknown', () => {
      expect(parseCommand('/steering edit')).toEqual({ kind: 'unknown', raw: '/steering edit' });
    });
  });

  describe('kiro-internal 拦截', () => {
    it('/agent 拦截', () => {
      expect(parseCommand('/agent')).toEqual({ kind: 'kiro-internal', name: 'agent' });
    });

    it('/tools 拦截', () => {
      expect(parseCommand('/tools')).toEqual({ kind: 'kiro-internal', name: 'tools' });
    });

    it('/compact 拦截', () => {
      expect(parseCommand('/compact')).toEqual({ kind: 'kiro-internal', name: 'compact' });
    });

    it('/login 拦截', () => {
      expect(parseCommand('/login')).toEqual({ kind: 'kiro-internal', name: 'login' });
    });

    it('/logout 拦截', () => {
      expect(parseCommand('/logout')).toEqual({ kind: 'kiro-internal', name: 'logout' });
    });

    it('/session 拦截', () => {
      expect(parseCommand('/session')).toEqual({ kind: 'kiro-internal', name: 'session' });
    });
  });

  describe('未知命令', () => {
    it('/random 返回 unknown', () => {
      expect(parseCommand('/random')).toEqual({ kind: 'unknown', raw: '/random' });
    });

    it('/foo bar 返回 unknown', () => {
      expect(parseCommand('/foo bar')).toEqual({ kind: 'unknown', raw: '/foo bar' });
    });
  });

  describe('大小写与空白', () => {
    it('命令名大小写不敏感', () => {
      expect(parseCommand('/HELP')).toEqual({ kind: 'help' });
      expect(parseCommand('/Status')).toEqual({ kind: 'status' });
    });

    it('前后空白被 trim', () => {
      expect(parseCommand('  /help  ')).toEqual({ kind: 'help' });
    });
  });
});

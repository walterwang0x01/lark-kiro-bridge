/**
 * lark-kiro-bridge CLI 入口
 *
 * 子命令：
 *   init         首次配置：填入飞书 App ID / Secret，生成 ~/.lark-kiro-bridge/config.json
 *   run          前台启动 bridge，监听飞书消息
 *   config-show  打印当前配置（隐藏 secret）
 *   service ...  launchd 守护进程管理（start/stop/status/install/uninstall）
 */
import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { CONFIG_FILE, ensureDataDirs, LOGS_DIR } from './lib/paths.js';
import { defaultConfig, loadConfig, saveConfig } from './lib/config.js';
import { runBridge } from './core/bootstrap.js';
import { getLogger } from './lib/logger.js';
import {
  serviceStart,
  serviceStop,
  serviceStatus,
  serviceInstall,
  serviceUninstall,
} from './daemon/launchd.js';
import { listProcesses, findProcess } from './daemon/registry.js';

const program = new Command();

program
  .name('lark-kiro-bridge')
  .description('Bridge Feishu/Lark messenger with local Kiro CLI')
  .version('0.1.0');

program
  .command('init')
  .description('Interactive setup: write App ID/Secret and defaults to config file')
  .option('--app-id <id>', 'Lark App ID (skip prompt)')
  .option('--app-secret <secret>', 'Lark App Secret (skip prompt)')
  .option('--force', 'Overwrite existing config')
  .action(async (opts: { appId?: string; appSecret?: string; force?: boolean }) => {
    ensureDataDirs();
    if (existsSync(CONFIG_FILE) && !opts.force) {
      console.error(
        `Config already exists at ${CONFIG_FILE}. Use --force to overwrite, or edit it directly.`,
      );
      process.exit(1);
    }
    let appId = opts.appId;
    let appSecret = opts.appSecret;
    if (!appId || !appSecret) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        if (!appId) appId = (await rl.question('Lark App ID: ')).trim();
        if (!appSecret) appSecret = (await rl.question('Lark App Secret: ')).trim();
      } finally {
        rl.close();
      }
    }
    if (!appId || !appSecret) {
      console.error('App ID and Secret are required.');
      process.exit(1);
    }
    saveConfig(defaultConfig(appId, appSecret));
    console.log(`✅ Wrote config to ${CONFIG_FILE}`);
    console.log('');
    console.log('Defaults:');
    console.log('  • workspace.defaultCwd : /Users/administrator/PycharmProjects');
    console.log('  • workspace.allowedRoots: [/Users/administrator/PycharmProjects]');
    console.log('  • kiro.trustedTools    : fs_read, fs_write, grep, glob, code');
    console.log('');
    console.log('Edit the file directly to customize. Then run:');
    console.log('  lark-kiro-bridge run');
  });

program
  .command('run')
  .description('Run the bridge in foreground')
  .action(async () => {
    try {
      await runBridge();
      // 保持进程不退出，等信号
      await new Promise(() => undefined);
    } catch (e) {
      const err = e as Error;
      console.error(`❌ ${err.message}`);
      if (process.env['LARK_KIRO_DEBUG']) console.error(err.stack);
      process.exit(1);
    }
  });

program
  .command('config-show')
  .description('Show current config (with App Secret masked)')
  .action(() => {
    try {
      const cfg = loadConfig();
      const masked = {
        ...cfg,
        lark: {
          ...cfg.lark,
          appSecret: cfg.lark.appSecret ? cfg.lark.appSecret.slice(0, 4) + '****' : '',
        },
      };
      console.log(JSON.stringify(masked, null, 2));
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

const service = program.command('service').description('Manage background daemon (launchd)');
service
  .command('install')
  .description('Install launchd plist')
  .action(async () => {
    await serviceInstall();
  });
service
  .command('uninstall')
  .description('Remove launchd plist')
  .action(async () => {
    await serviceUninstall();
  });
service
  .command('start')
  .description('Start the daemon')
  .action(async () => {
    await serviceStart();
  });
service
  .command('stop')
  .description('Stop the daemon')
  .action(async () => {
    await serviceStop();
  });
service
  .command('status')
  .description('Show daemon status')
  .action(async () => {
    await serviceStatus();
  });

// 顶级别名（业界惯例：start/stop/restart/status 直接顶在 CLI 上）
program
  .command('start')
  .description('Install (if needed) and start the background daemon')
  .action(async () => {
    await serviceInstall().catch((e) => {
      // 已存在 plist 也无所谓
      console.error(`(install) ${(e as Error).message}`);
    });
    await serviceStart();
  });

program
  .command('stop')
  .description('Stop the background daemon')
  .action(async () => {
    await serviceStop();
  });

program
  .command('restart')
  .description('Restart the background daemon in place')
  .action(async () => {
    await serviceStop().catch(() => undefined);
    // 等 launchd 彻底 bootout，避免 bootstrap 时撞上"already loaded"
    await new Promise((r) => setTimeout(r, 1500));
    await serviceStart();
  });

program
  .command('status')
  .description('Show daemon status (alias of `service status`)')
  .action(async () => {
    await serviceStatus();
  });

program
  .command('unregister')
  .description('Remove daemon plist and stop')
  .action(async () => {
    await serviceUninstall();
  });

program
  .command('ps')
  .description('List all running bridge processes on this host')
  .action(async () => {
    const list = await listProcesses();
    if (list.length === 0) {
      console.log('No running bridge processes.');
      console.log(`Logs: ${LOGS_DIR}/`);
      return;
    }
    console.log(`#  PID     SHORT   APP_ID                STARTED              CWD`);
    list.forEach((p, i) => {
      const started = new Date(p.startedAt).toISOString().replace('T', ' ').slice(0, 19);
      const num = String(i + 1).padEnd(2);
      const pid = String(p.pid).padEnd(7);
      const sh = p.shortId.padEnd(7);
      const app = p.appId.padEnd(20).slice(0, 20);
      console.log(`${num} ${pid} ${sh} ${app}  ${started}  ${p.cwd}`);
    });
    console.log(`\nLogs: ${LOGS_DIR}/`);
  });

program
  .command('kill <id>')
  .description('Kill a bridge process by pid / shortId / #N')
  .option('--force', 'Send SIGKILL after 2s if still alive')
  .action(async (id: string, opts: { force?: boolean }) => {
    const target = await findProcess(id);
    if (!target) {
      console.error(`No bridge process matches "${id}". Use \`ps\` to list.`);
      process.exit(1);
    }
    try {
      process.kill(target.pid, 'SIGTERM');
      console.log(`✅ SIGTERM sent to pid ${target.pid} (shortId ${target.shortId})`);
    } catch (e) {
      console.error(`Failed to signal pid ${target.pid}: ${(e as Error).message}`);
      process.exit(1);
    }
    if (opts.force) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        process.kill(target.pid, 0);
        // 还活着
        process.kill(target.pid, 'SIGKILL');
        console.log(`✅ SIGKILL sent to pid ${target.pid}`);
      } catch {
        // 已死
      }
    }
  });

// 兜底未知命令
program.parseAsync(process.argv).catch((e) => {
  getLogger().error({ err: e }, 'cli error');
  process.exit(1);
});

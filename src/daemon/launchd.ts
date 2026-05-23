/**
 * macOS launchd 守护进程支持
 *
 * 安装目标：~/Library/LaunchAgents/ai.lark-kiro-bridge.bot.plist
 *
 * service install   生成 plist（指向 process.execPath + bin 路径）
 * service uninstall 移除 plist 并 unload
 * service start     bootstrap + kickstart
 * service stop      bootout
 * service status    打印 PID / 上次退出码 / 日志路径
 */
import { execa } from 'execa';
import { writeFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { LOGS_DIR, ensureDataDirs } from '../lib/paths.js';

const LABEL = 'ai.lark-kiro-bridge.bot';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

/** UID for `launchctl bootstrap gui/<uid>` */
function uid(): number {
  // process.getuid 在 darwin 一定有
  return (process.getuid?.() ?? 0) | 0;
}

/**
 * 找当前 lark-kiro-bridge 可执行入口。
 * 优先用全局安装的 bin，否则回退到当前 node + 本仓库的 bin/lark-kiro-bridge.mjs（开发模式）。
 */
async function resolveBinPath(): Promise<{ program: string; args: string[] }> {
  // 优先 PATH 里的 lark-kiro-bridge
  try {
    const r = await execa('which', ['lark-kiro-bridge'], { reject: false });
    if (r.exitCode === 0 && r.stdout.trim()) {
      return { program: r.stdout.trim(), args: ['run'] };
    }
  } catch {
    // ignore
  }
  // 回退到当前进程：node + 本包 bin
  const node = process.execPath;
  const fileUrl = new URL(import.meta.url).pathname;
  // dist/cli.js 或 dist/cli.mjs 的位置；从 launchd.js 推 ../bin/lark-kiro-bridge.mjs 不一定对，
  // 直接指向 dist 同级 cli 入口最稳。但 launchd 推荐绝对路径全局安装。
  const guess = fileUrl.replace(
    /\/(dist|src)\/daemon\/launchd\.[mc]?js$/,
    '/bin/lark-kiro-bridge.mjs',
  );
  return { program: node, args: [guess, 'run'] };
}

function buildPlist(program: string, args: string[]): string {
  const programArgsXml = [program, ...args]
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArgsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOGS_DIR}/daemon-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOGS_DIR}/daemon-stderr.log</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}</string>
        <key>HOME</key>
        <string>${homedir()}</string>
    </dict>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function serviceInstall(): Promise<void> {
  ensureDataDirs();
  const { program, args } = await resolveBinPath();
  const plist = buildPlist(program, args);
  writeFileSync(PLIST_PATH, plist, { mode: 0o644 });
  chmodSync(PLIST_PATH, 0o644);
  console.log(`✅ Installed: ${PLIST_PATH}`);
  console.log(`    Program: ${program} ${args.join(' ')}`);
  console.log('');
  console.log('Next: lark-kiro-bridge service start');
}

export async function serviceUninstall(): Promise<void> {
  await serviceStop().catch(() => undefined);
  if (existsSync(PLIST_PATH)) {
    unlinkSync(PLIST_PATH);
    console.log(`✅ Removed: ${PLIST_PATH}`);
  } else {
    console.log(`Already removed: ${PLIST_PATH}`);
  }
}

export async function serviceStart(): Promise<void> {
  if (!existsSync(PLIST_PATH)) {
    console.error(`No plist at ${PLIST_PATH}. Run 'lark-kiro-bridge service install' first.`);
    process.exit(1);
  }
  await execa('launchctl', ['bootstrap', `gui/${uid()}`, PLIST_PATH], { reject: false });
  await execa('launchctl', ['kickstart', '-k', `gui/${uid()}/${LABEL}`], { reject: false });
  console.log(`✅ Started ${LABEL}`);
  console.log(`    Logs: ${LOGS_DIR}/daemon-stdout.log`);
}

export async function serviceStop(): Promise<void> {
  await execa('launchctl', ['bootout', `gui/${uid()}/${LABEL}`], { reject: false });
  console.log(`✅ Stopped ${LABEL}`);
}

export async function serviceStatus(): Promise<void> {
  const r = await execa('launchctl', ['print', `gui/${uid()}/${LABEL}`], { reject: false });
  if (r.exitCode === 0) {
    const lines = r.stdout.split('\n');
    const interesting = lines.filter((l) =>
      /^\s*(state|pid|last exit code|program|stdout|stderr)/i.test(l),
    );
    console.log(`Status: ${LABEL}`);
    interesting.forEach((l) => {
      console.log(`  ${l.trim()}`);
    });
  } else {
    console.log(`Service ${LABEL} not loaded.`);
  }
  console.log(`Logs: ${LOGS_DIR}/`);
}

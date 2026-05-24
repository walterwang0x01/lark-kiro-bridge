/**
 * 飞书 PersonalAgent 扫码注册向导
 *
 * 飞书 SDK 自带 `registerApp()`：调起 OAuth-style 设备码流程，
 * 用户在飞书 App 扫码同意 → SDK 拿到 client_id/client_secret → 写进 config。
 *
 * 用户体验对比：
 *   传统手动配：开发者后台注册账号 → 创建应用 → 开机器人能力 →
 *               订阅事件 → 开权限 → 复制 App ID/Secret →
 *               填进 config.json （8+ 步，10-15 分钟，每步可能填错）
 *
 *   扫码：     扫码同意（30 秒，0 错误）
 *
 * 使用飞书 SDK 的设备码扫码流程。
 */
import * as lark from '@larksuiteoapi/node-sdk';
import qrcode from 'qrcode-terminal';
import type { Config } from './config.js';
import { defaultConfig } from './config.js';

export interface QrWizardResult {
  config: Config;
  /** 扫码用户的 open_id（如果飞书返回了）。会自动放进 access.admins。 */
  operatorOpenId?: string;
}

/**
 * 启动扫码向导。阻塞到用户扫码完成（或超时）后返回完整 Config。
 *
 * 失败场景：网络不通、二维码过期、用户主动取消都会抛错给调用方。
 */
export async function runQrWizard(): Promise<QrWizardResult> {
  console.log('\n未检测到飞书应用配置，进入扫码创建向导。\n');

  const result = await lark.registerApp({
    onQRCodeReady: (info) => {
      console.log('请用飞书 App 扫描以下二维码完成应用创建：\n');
      qrcode.generate(info.url, { small: true });
      const mins = Math.max(1, Math.round(info.expireIn / 60));
      console.log(`\n二维码有效期：约 ${mins} 分钟`);
      console.log(`也可以直接在浏览器打开：${info.url}\n`);
    },
    onStatusChange: (info) => {
      if (info.status === 'domain_switched') {
        console.log('识别到国际版租户，已切换到 larksuite.com 域名。');
      } else if (info.status === 'slow_down') {
        console.log('轮询速度过快，已自动降速。');
      }
    },
  });

  const tenant = result.user_info?.tenant_brand ?? 'feishu';
  const operatorOpenId = result.user_info?.open_id;

  console.log('\n✅ 应用创建成功');
  console.log(`   App ID:  ${result.client_id}`);
  console.log(`   Tenant:  ${tenant}`);

  // 用 defaultConfig 拿到完整默认值，然后只覆盖凭证
  const cfg = defaultConfig(result.client_id, result.client_secret);

  // 把扫码用户加到 admins，避免其他人也能用 /cd /ws save 等敏感命令
  if (operatorOpenId) {
    cfg.access.admins = [operatorOpenId];
    console.log(`   Admin:   ${operatorOpenId}（你自己，已自动加入管理员名单）`);
  } else {
    console.log(
      '   ⚠️  未拿到扫码用户的 open_id，管理员列表留空 = 所有用户都能跑敏感命令。\n' +
        '       可以稍后手动编辑 ~/.lark-kiro-bridge/config.json 的 access.admins',
    );
  }

  console.log('');
  const out: QrWizardResult = { config: cfg };
  if (operatorOpenId) out.operatorOpenId = operatorOpenId;
  return out;
}

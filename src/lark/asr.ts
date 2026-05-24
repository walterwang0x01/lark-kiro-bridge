/**
 * 飞书语音识别（ASR）封装。
 *
 * 调用链：
 *   原始 OPUS 文件 (来自 lark/media.ts 下载)
 *      ↓ ffmpeg 转码
 *   16k 单声道 s16le PCM
 *      ↓ base64
 *   POST /open-apis/speech_to_text/v1/speech/file_recognize
 *      ↓
 *   recognition_text (中文/英文文本)
 *
 * 飞书 ASR 接口约束（来自官方文档）：
 *   - 仅接受 PCM；engine_type 固定 16k_auto；最长 60 秒
 *   - 单租户限流 20 QPS
 *   - 免费版租户不支持
 *   - 需要 scope: speech_to_text:speech
 *
 * 因此 transcribe() 接受任意格式音频路径，先 ffmpeg 转 PCM 再调 API。
 * ffmpeg 缺失时返回 'ffmpeg-missing' 错误，调用方决定怎么降级。
 */
import { execa } from 'execa';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LarkClient } from './client.js';
import { getLogger } from '../lib/logger.js';

const log = () => getLogger().child({ module: 'asr' });

/** ASR 单次调用结果。 */
export type TranscribeResult =
  | { ok: true; text: string }
  | {
      ok: false;
      reason: 'ffmpeg-missing' | 'ffmpeg-failed' | 'too-long' | 'api-failed' | 'empty';
      detail?: string;
    };

/** 飞书 ASR 单次最长支持 60 秒；超出直接拒绝以免浪费 API 调用。 */
const MAX_DURATION_SEC = 60;

/**
 * 探测系统是否安装了 ffmpeg。结果在进程内缓存（一次启动测一次就够）。
 */
let ffmpegAvailableCache: boolean | undefined;
export async function isFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailableCache !== undefined) return ffmpegAvailableCache;
  try {
    await execa('ffmpeg', ['-version'], { reject: false, timeout: 3000 });
    ffmpegAvailableCache = true;
  } catch {
    ffmpegAvailableCache = false;
  }
  return ffmpegAvailableCache;
}

/** 仅供测试：清空 ffmpeg 探测缓存。 */
export function _resetFfmpegCacheForTest(): void {
  ffmpegAvailableCache = undefined;
}

/**
 * 用 ffprobe 拿不到时退而求其次：用 ffmpeg -i 自带的 stderr 解析时长。
 * 失败返回 -1（调用方就当未知，不做时长检查）。
 */
async function probeDurationSec(audioPath: string): Promise<number> {
  try {
    const r = await execa('ffmpeg', ['-i', audioPath, '-f', 'null', '-'], {
      reject: false,
      timeout: 5000,
    });
    // ffmpeg 把元信息写到 stderr，例如 "Duration: 00:00:02.57, ..."
    const stderr = (r.stderr ?? '') as string;
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return -1;
    const [, h, mm, ss] = m;
    return Number(h) * 3600 + Number(mm) * 60 + Number(ss);
  } catch {
    return -1;
  }
}

/**
 * 用 ffmpeg 把任意音频转成 16k 单声道 s16le PCM。
 * 返回临时文件路径，调用方负责删除。
 */
async function toPcm(audioPath: string): Promise<string> {
  const out = join(tmpdir(), `lkb-asr-${randomUUID()}.pcm`);
  await execa(
    'ffmpeg',
    [
      '-y',
      '-i',
      audioPath,
      '-ar',
      '16000', // 16 kHz
      '-ac',
      '1', // mono
      '-f',
      's16le', // 16-bit little-endian PCM, 飞书要求的格式
      out,
    ],
    { reject: true, timeout: 30_000 },
  );
  return out;
}

/**
 * 把音频文件转成文本。返回 TranscribeResult；调用方根据 reason 决定怎么降级。
 *
 * 实现细节：
 *   - 没装 ffmpeg → 直接返回 ffmpeg-missing，不再尝试
 *   - 时长 > 60s → 返回 too-long，让调用方告诉用户截短
 *   - API 调用失败 → 返回 api-failed + detail（含错误码）
 *   - 识别成功但 text 为空 → 返回 empty（可能是静音 / 噪音）
 */
export async function transcribeAudio(
  client: LarkClient,
  audioPath: string,
): Promise<TranscribeResult> {
  // 1. ffmpeg 可用性
  if (!(await isFfmpegAvailable())) {
    log().warn('ffmpeg not found in PATH; voice transcription disabled');
    return { ok: false, reason: 'ffmpeg-missing' };
  }

  // 2. 时长预检
  const durSec = await probeDurationSec(audioPath);
  if (durSec > MAX_DURATION_SEC) {
    log().info({ durSec, audioPath }, 'audio too long for ASR API, skipping');
    return {
      ok: false,
      reason: 'too-long',
      detail: `${durSec.toFixed(1)}s > ${MAX_DURATION_SEC}s`,
    };
  }

  // 3. 转 PCM
  let pcmPath: string;
  try {
    pcmPath = await toPcm(audioPath);
  } catch (e) {
    log().warn({ err: (e as Error).message, audioPath }, 'ffmpeg transcoding failed');
    return { ok: false, reason: 'ffmpeg-failed', detail: (e as Error).message };
  }

  try {
    const pcm = readFileSync(pcmPath);
    if (pcm.length === 0) {
      return { ok: false, reason: 'empty', detail: 'transcoded pcm is empty' };
    }
    const speech = pcm.toString('base64');
    // 接口要求 file_id 是 16 位字母数字下划线
    const fileId = randomUUID().replace(/-/g, '').slice(0, 16);

    // 4. 调 ASR API
    type FileRecognizeResp = {
      code: number;
      msg: string;
      data?: { recognition_text?: string };
    };
    const resp = (await client.api.speech_to_text.v1.speech.fileRecognize({
      data: {
        speech: { speech },
        config: {
          file_id: fileId,
          format: 'pcm',
          engine_type: '16k_auto',
        },
      },
    } as never)) as FileRecognizeResp;

    if (resp.code !== 0) {
      log().warn({ code: resp.code, msg: resp.msg }, 'ASR API returned non-zero code');
      return { ok: false, reason: 'api-failed', detail: `code=${resp.code} msg=${resp.msg}` };
    }
    const text = (resp.data?.recognition_text ?? '').trim();
    if (!text) {
      return { ok: false, reason: 'empty', detail: 'recognition_text is empty' };
    }
    log().info({ durSec, textLength: text.length }, 'ASR success');
    return { ok: true, text };
  } catch (e) {
    log().warn({ err: (e as Error).message }, 'ASR API call threw');
    return { ok: false, reason: 'api-failed', detail: (e as Error).message };
  } finally {
    try {
      const st = statSync(pcmPath);
      if (st.isFile()) unlinkSync(pcmPath);
    } catch {
      // 忽略：临时文件已删或没建出来
    }
  }
}

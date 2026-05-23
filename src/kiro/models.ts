/**
 * kiro-cli 模型列表查询
 *
 * 调 `kiro-cli chat --list-models --format json` 拿到结构化列表，
 * 解析后供 /model 命令使用。结果在进程内缓存 5 分钟，避免每次都启子进程。
 */
import { execa } from 'execa';
import { stripAnsi } from './runner.js';
import { getLogger } from '../lib/logger.js';

const log = () => getLogger().child({ module: 'kiro-models' });

export interface ModelInfo {
  /** 模型名（用作 --model 参数值，比如 "claude-opus-4.6"） */
  name: string;
  description: string;
  /** 计费倍率（1.0 = 1x credit） */
  rateMultiplier: number;
  /** 上下文窗口 tokens 数 */
  contextWindow: number;
}

export interface ModelListResult {
  models: ModelInfo[];
  /** kiro-cli 自身的默认模型（通常是 'auto'） */
  defaultModel: string;
}

interface RawModelEntry {
  model_name: string;
  description?: string;
  rate_multiplier?: number;
  context_window_tokens?: number;
}

interface RawListModelsResp {
  models: RawModelEntry[];
  default_model?: string;
}

let cache: { at: number; data: ModelListResult } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 获取可用模型列表。失败时返回 undefined（调用方决定怎么降级）。
 */
export async function listModels(binPath = 'kiro-cli'): Promise<ModelListResult | undefined> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  let r: Awaited<ReturnType<typeof execa>>;
  try {
    r = await execa(binPath, ['chat', '--list-models', '--format', 'json'], {
      reject: false,
      timeout: 10_000,
      all: true,
    });
  } catch (e) {
    log().warn({ err: (e as Error).message }, 'list-models spawn failed');
    return undefined;
  }
  if (r.exitCode !== 0) {
    log().warn(
      {
        exitCode: r.exitCode,
        stdoutSample: ((r.stdout ?? '') as string).slice(0, 200),
        stderrSample: ((r.stderr ?? '') as string).slice(0, 200),
        allSample: ((r.all ?? '') as string).slice(0, 200),
      },
      'list-models non-zero exit',
    );
    return undefined;
  }

  const text = stripAnsi(((r.all ?? r.stdout ?? '') as string).trim());
  if (!text) return undefined;

  let parsed: RawListModelsResp;
  try {
    parsed = JSON.parse(text) as RawListModelsResp;
  } catch (e) {
    log().warn(
      { err: (e as Error).message, sample: text.slice(0, 200) },
      'list-models json parse failed',
    );
    return undefined;
  }
  if (!Array.isArray(parsed.models)) return undefined;

  const data: ModelListResult = {
    defaultModel: parsed.default_model ?? 'auto',
    models: parsed.models.map((m) => ({
      name: m.model_name,
      description: m.description ?? '',
      rateMultiplier: m.rate_multiplier ?? 1,
      contextWindow: m.context_window_tokens ?? 0,
    })),
  };
  cache = { at: Date.now(), data };
  return data;
}

/** 强制清缓存（比如配置改了想立刻刷新） */
export function clearModelCache(): void {
  cache = null;
}

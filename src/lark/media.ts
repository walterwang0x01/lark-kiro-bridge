/**
 * 飞书消息中的图片/文件下载
 *
 * 收到 image / file / audio 消息时：
 *   1. 从 message.content（JSON 字符串）里取出 image_key 或 file_key
 *   2. 调 api.im.v1.messageResource.get 拿二进制流
 *   3. 写到 ~/.lark-kiro-bridge/media/<chatId>/<filename>
 *   4. 返回绝对路径
 *
 * Kiro CLI 支持 prompt 里写绝对路径或 @path，会自动读到上下文里。
 *
 * 启动时会清理 24h 之前的媒体文件，避免无限增长。
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { LarkClient } from './client.js';
import type { IncomingMessage } from './types.js';
import { MEDIA_DIR } from '../lib/paths.js';
import { getLogger } from '../lib/logger.js';

const log = () => getLogger().child({ module: 'media' });

interface ImageContent {
  image_key: string;
}

interface FileContent {
  file_key: string;
  file_name?: string;
}

interface AudioContent {
  file_key: string;
  duration?: number;
}

/** 文件名清洗：去掉路径分隔符和危险字符，超过 80 字符截断（保留扩展名） */
function sanitizeFilename(name: string, fallbackKey: string, defaultExt: string): string {
  let s = name.replace(/[/\\\x00-\x1f]/g, '_').trim();
  if (!s) s = fallbackKey + defaultExt;
  if (s.length > 80) {
    const dotIdx = s.lastIndexOf('.');
    if (dotIdx > 0 && dotIdx > s.length - 12) {
      const ext = s.slice(dotIdx);
      s = s.slice(0, 80 - ext.length) + ext;
    } else {
      s = s.slice(0, 80);
    }
  }
  return s;
}

function ensureChatDir(chatId: string): string {
  const dir = join(MEDIA_DIR, chatId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * 下载消息里所有可下载的资源（image/file/audio），返回绝对路径数组。
 * 不可下载的类型（sticker / video 等）静默跳过，返回空数组。
 */
export async function downloadMessageMedia(
  lark: LarkClient,
  msg: IncomingMessage,
): Promise<string[]> {
  const out: string[] = [];
  const ts = Date.now();
  let parsed: unknown;
  try {
    parsed = JSON.parse(msg.rawContent);
  } catch {
    return out;
  }

  if (msg.messageType === 'image') {
    const c = parsed as ImageContent;
    if (c.image_key) {
      const filename = sanitizeFilename('', `${ts}-${c.image_key.slice(0, 8)}`, '.jpg');
      const path = await fetchResource(lark, msg.messageId, c.image_key, 'image', chatPath(msg.chatId, filename));
      if (path) out.push(path);
    }
  } else if (msg.messageType === 'file') {
    const c = parsed as FileContent;
    if (c.file_key) {
      const filename = sanitizeFilename(c.file_name ?? '', `${ts}-${c.file_key.slice(0, 8)}`, '.bin');
      const path = await fetchResource(lark, msg.messageId, c.file_key, 'file', chatPath(msg.chatId, filename));
      if (path) out.push(path);
    }
  } else if (msg.messageType === 'audio') {
    const c = parsed as AudioContent;
    if (c.file_key) {
      const filename = sanitizeFilename('', `${ts}-${c.file_key.slice(0, 8)}`, '.opus');
      const path = await fetchResource(lark, msg.messageId, c.file_key, 'file', chatPath(msg.chatId, filename));
      if (path) out.push(path);
    }
  }
  // 其他类型（sticker / video / location / share_chat...）暂不支持
  return out;
}

function chatPath(chatId: string, filename: string): { dir: string; full: string; name: string } {
  const dir = ensureChatDir(chatId);
  let name = filename;
  let full = join(dir, name);
  // 同名时加序号
  let i = 1;
  while (existsSync(full)) {
    const dotIdx = filename.lastIndexOf('.');
    name =
      dotIdx > 0
        ? `${filename.slice(0, dotIdx)}-${i}${filename.slice(dotIdx)}`
        : `${filename}-${i}`;
    full = join(dir, name);
    i++;
    if (i > 1000) break;
  }
  return { dir, full, name };
}

async function fetchResource(
  lark: LarkClient,
  messageId: string,
  fileKey: string,
  resourceType: 'image' | 'file',
  target: { dir: string; full: string; name: string },
): Promise<string | undefined> {
  try {
    const resp = await lark.api.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: resourceType },
    });
    // SDK 返回 writeFile + getReadableStream；优先 writeFile
    if (typeof resp.writeFile === 'function') {
      await resp.writeFile(target.full);
    } else {
      const stream = resp.getReadableStream() as Readable;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      writeFileSync(target.full, Buffer.concat(chunks), { mode: 0o600 });
    }
    log().info({ messageId, fileKey, resourceType, path: target.full }, 'media downloaded');
    return target.full;
  } catch (e) {
    log().warn({ err: (e as Error).message, messageId, fileKey }, 'media download failed');
    return undefined;
  }
}

/**
 * 启动时清理 24h 前的媒体文件。
 */
export function pruneOldMedia(retainHours = 24): void {
  if (!existsSync(MEDIA_DIR)) return;
  const cutoff = Date.now() - retainHours * 60 * 60 * 1000;
  try {
    for (const chat of readdirSync(MEDIA_DIR)) {
      const chatDir = join(MEDIA_DIR, chat);
      let dirSt;
      try {
        dirSt = statSync(chatDir);
      } catch {
        continue;
      }
      if (!dirSt.isDirectory()) continue;
      let files: string[] = [];
      try {
        files = readdirSync(chatDir);
      } catch {
        continue;
      }
      for (const f of files) {
        const full = join(chatDir, f);
        try {
          const st = statSync(full);
          if (st.mtimeMs < cutoff) rmSync(full, { force: true });
        } catch {
          // ignore
        }
      }
      // 清空目录则删目录
      try {
        if (readdirSync(chatDir).length === 0) rmSync(chatDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

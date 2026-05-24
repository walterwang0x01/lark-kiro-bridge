// transcribeAudio unit tests covering ffmpeg detection, duration probing,
// PCM transcoding, ASR API call, and error path returns.
//
// Strategy: mock `execa` for the ffmpeg/ffprobe invocations and the SDK call
// via a fake LarkClient. We do NOT actually invoke ffmpeg or hit the network.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LarkClient } from './client.js';

// Mock execa BEFORE importing the module under test so the module sees the mock.
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// Mock node:fs readFileSync / statSync / unlinkSync so we never touch real
// files. The asr module reads the transcoded pcm from disk after ffmpeg
// "writes" it; we feed back a deterministic Buffer.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const { execa } = await import('execa');
const { readFileSync, statSync } = await import('node:fs');
const { transcribeAudio, isFfmpegAvailable, _resetFfmpegCacheForTest } = await import('./asr.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedExeca = execa as unknown as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedReadFile = readFileSync as unknown as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedStat = statSync as unknown as ReturnType<typeof vi.fn>;

/** Build a fake LarkClient whose api.speech_to_text.v1.speech.fileRecognize is a vi.fn(). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeClient(fileRecognize: any): LarkClient {
  return {
    api: {
      speech_to_text: {
        v1: {
          speech: {
            fileRecognize,
          },
        },
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetFfmpegCacheForTest();
  // Default: statSync returns a regular file, readFileSync returns 100 bytes
  mockedStat.mockReturnValue({ isFile: () => true });
  mockedReadFile.mockReturnValue(Buffer.from(new Uint8Array(100).fill(1)));
});

describe('isFfmpegAvailable', () => {
  it('returns true when ffmpeg -version succeeds', async () => {
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 });
    expect(await isFfmpegAvailable()).toBe(true);
  });

  it('returns false when ffmpeg -version throws', async () => {
    mockedExeca.mockRejectedValueOnce(new Error('command not found'));
    expect(await isFfmpegAvailable()).toBe(false);
  });

  it('caches the result across calls', async () => {
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 });
    expect(await isFfmpegAvailable()).toBe(true);
    expect(await isFfmpegAvailable()).toBe(true);
    expect(mockedExeca).toHaveBeenCalledTimes(1);
  });

  it('cache reset (via _resetFfmpegCacheForTest) re-probes', async () => {
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 });
    expect(await isFfmpegAvailable()).toBe(true);
    _resetFfmpegCacheForTest();
    mockedExeca.mockRejectedValueOnce(new Error('removed'));
    expect(await isFfmpegAvailable()).toBe(false);
  });
});

describe('transcribeAudio', () => {
  describe('ffmpeg-missing path', () => {
    it('returns ffmpeg-missing when ffmpeg is not available', async () => {
      mockedExeca.mockRejectedValueOnce(new Error('command not found'));
      const client = makeFakeClient(vi.fn());
      const r = await transcribeAudio(client, '/tmp/test.opus');
      expect(r).toEqual({ ok: false, reason: 'ffmpeg-missing' });
      // Should not call the ASR API
      expect(client.api.speech_to_text.v1.speech.fileRecognize).not.toHaveBeenCalled();
    });
  });

  describe('too-long path', () => {
    it('rejects audio longer than 60 seconds', async () => {
      // 1st execa: ffmpeg -version → succeed
      mockedExeca.mockResolvedValueOnce({ exitCode: 0 });
      // 2nd execa: ffmpeg -i for duration probe → stderr contains 90 second
      mockedExeca.mockResolvedValueOnce({
        exitCode: 0,
        stderr: 'Duration: 00:01:30.50, start: 0.000000\n',
      });
      const fileRecognize = vi.fn();
      const r = await transcribeAudio(makeFakeClient(fileRecognize), '/tmp/long.opus');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('too-long');
        expect(r.detail).toContain('90');
      }
      expect(fileRecognize).not.toHaveBeenCalled();
    });

    it('accepts audio shorter than 60 seconds', async () => {
      mockedExeca
        .mockResolvedValueOnce({ exitCode: 0 }) // ffmpeg -version
        .mockResolvedValueOnce({
          exitCode: 0,
          stderr: 'Duration: 00:00:30.00, start: 0.000000\n',
        }) // probe
        .mockResolvedValueOnce({ exitCode: 0 }); // toPcm
      const fileRecognize = vi
        .fn()
        .mockResolvedValueOnce({ code: 0, msg: 'ok', data: { recognition_text: 'hi' } });
      const r = await transcribeAudio(makeFakeClient(fileRecognize), '/tmp/ok.opus');
      expect(r).toEqual({ ok: true, text: 'hi' });
    });
  });

  describe('ffmpeg-failed path', () => {
    it('returns ffmpeg-failed when transcoding throws', async () => {
      mockedExeca
        .mockResolvedValueOnce({ exitCode: 0 }) // ffmpeg -version
        .mockResolvedValueOnce({
          exitCode: 0,
          stderr: 'Duration: 00:00:10.00, start: 0.000000\n',
        }) // probe
        .mockRejectedValueOnce(new Error('codec not found')); // toPcm
      const r = await transcribeAudio(makeFakeClient(vi.fn()), '/tmp/bad.opus');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('ffmpeg-failed');
        expect(r.detail).toContain('codec not found');
      }
    });
  });

  describe('successful transcription', () => {
    it('returns the recognized text', async () => {
      mockedExeca
        .mockResolvedValueOnce({ exitCode: 0 })
        .mockResolvedValueOnce({
          exitCode: 0,
          stderr: 'Duration: 00:00:03.00, start: 0.000000\n',
        })
        .mockResolvedValueOnce({ exitCode: 0 }); // toPcm
      const fileRecognize = vi.fn().mockResolvedValueOnce({
        code: 0,
        msg: 'success',
        data: { recognition_text: '你好世界' },
      });
      const r = await transcribeAudio(makeFakeClient(fileRecognize), '/tmp/ok.opus');
      expect(r).toEqual({ ok: true, text: '你好世界' });
      expect(fileRecognize).toHaveBeenCalledOnce();
    });

    it('passes correct ASR config (pcm + 16k_auto)', async () => {
      mockedExeca
        .mockResolvedValueOnce({ exitCode: 0 })
        .mockResolvedValueOnce({
          exitCode: 0,
          stderr: 'Duration: 00:00:03.00, start: 0.000000\n',
        })
        .mockResolvedValueOnce({ exitCode: 0 });
      const fileRecognize = vi.fn().mockResolvedValueOnce({
        code: 0,
        msg: 'success',
        data: { recognition_text: 'x' },
      });
      await transcribeAudio(makeFakeClient(fileRecognize), '/tmp/ok.opus');
      const call = fileRecognize.mock.calls[0]![0]!;
      expect(call.data.config.format).toBe('pcm');
      expect(call.data.config.engine_type).toBe('16k_auto');
      expect(call.data.config.file_id).toMatch(/^[a-zA-Z0-9_]{16}$/);
      expect(typeof call.data.speech.speech).toBe('string');
      expect(call.data.speech.speech.length).toBeGreaterThan(0);
    });

    it('trims surrounding whitespace from recognition_text', async () => {
      mockedExeca
        .mockResolvedValueOnce({ exitCode: 0 })
        .mockResolvedValueOnce({
          exitCode: 0,
          stderr: 'Duration: 00:00:03.00, start: 0.000000\n',
        })
        .mockResolvedValueOnce({ exitCode: 0 });
      const fileRecognize = vi.fn().mockResolvedValueOnce({
        code: 0,
        msg: 'success',
        data: { recognition_text: '  hello  ' },
      });
      const r = await transcribeAudio(makeFakeClient(fileRecognize), '/tmp/ok.opus');
      expect(r).toEqual({ ok: true, text: 'hello' });
    });
  });

  describe('api-failed path', () => {
    it('non-zero code returns api-failed with detail', async () => {
      mockedExeca
        .mockResolvedValueOnce({ exitCode: 0 })
        .mockResolvedValueOnce({
          exitCode: 0,
          stderr: 'Duration: 00:00:03.00, start: 0.000000\n',
        })
        .mockResolvedValueOnce({ exitCode: 0 });
      const fileRecognize = vi
        .fn()
        .mockResolvedValueOnce({ code: 1040101, msg: 'invalid param', data: {} });
      const r = await transcribeAudio(makeFakeClient(fileRecognize), '/tmp/x.opus');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('api-failed');
        expect(r.detail).toContain('1040101');
      }
    });

    it('thrown SDK error returns api-failed', async () => {
      mockedExeca
        .mockResolvedValueOnce({ exitCode: 0 })
        .mockResolvedValueOnce({
          exitCode: 0,
          stderr: 'Duration: 00:00:03.00, start: 0.000000\n',
        })
        .mockResolvedValueOnce({ exitCode: 0 });
      const fileRecognize = vi.fn().mockRejectedValueOnce(new Error('network'));
      const r = await transcribeAudio(makeFakeClient(fileRecognize), '/tmp/x.opus');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('api-failed');
        expect(r.detail).toContain('network');
      }
    });
  });

  describe('empty path', () => {
    it('returns empty when transcoded pcm is 0 bytes', async () => {
      mockedExeca
        .mockResolvedValueOnce({ exitCode: 0 })
        .mockResolvedValueOnce({
          exitCode: 0,
          stderr: 'Duration: 00:00:01.00, start: 0.000000\n',
        })
        .mockResolvedValueOnce({ exitCode: 0 });
      mockedReadFile.mockReturnValueOnce(Buffer.alloc(0));
      const r = await transcribeAudio(makeFakeClient(vi.fn()), '/tmp/silent.opus');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('empty');
      }
    });

    it('returns empty when recognition_text is empty', async () => {
      mockedExeca
        .mockResolvedValueOnce({ exitCode: 0 })
        .mockResolvedValueOnce({
          exitCode: 0,
          stderr: 'Duration: 00:00:01.00, start: 0.000000\n',
        })
        .mockResolvedValueOnce({ exitCode: 0 });
      const fileRecognize = vi
        .fn()
        .mockResolvedValueOnce({ code: 0, msg: 'success', data: { recognition_text: '' } });
      const r = await transcribeAudio(makeFakeClient(fileRecognize), '/tmp/silent.opus');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('empty');
      }
    });
  });

  describe('duration probe edge cases', () => {
    it('proceeds when probe cannot find Duration line (returns -1)', async () => {
      mockedExeca
        .mockResolvedValueOnce({ exitCode: 0 }) // ffmpeg -version
        .mockResolvedValueOnce({ exitCode: 1, stderr: 'unknown error' }) // probe — no Duration
        .mockResolvedValueOnce({ exitCode: 0 }); // toPcm
      const fileRecognize = vi
        .fn()
        .mockResolvedValueOnce({ code: 0, msg: 'success', data: { recognition_text: 'x' } });
      const r = await transcribeAudio(makeFakeClient(fileRecognize), '/tmp/no-meta.opus');
      expect(r).toEqual({ ok: true, text: 'x' });
    });
  });
});

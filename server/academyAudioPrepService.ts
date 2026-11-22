import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { GoogleGenAI } from '@google/genai';
import {
  collectAcademyAudioManifestItems,
  type AcademyAudioLang,
  type AcademyAudioManifestItem,
} from './academyAudioManifestBuilder';
import { hasValidAudioMagicBytes } from './storyAudioService';
import {
  classifyUpstreamTtsError,
  ensureWavContainerFromPcm,
  FALLBACK_TTS_MODEL,
  PRIMARY_TTS_MODEL,
} from './ttsService';

const execFileAsync = promisify(execFile);

export const ACADEMY_AUDIO_ROOT_DIR = path.resolve(
  process.cwd(),
  'public',
  'assets',
  'audio',
  'academy',
);
export const ACADEMY_MANIFEST_JSON_PATH = path.join(ACADEMY_AUDIO_ROOT_DIR, 'manifest.json');
export const ACADEMY_CLIENT_MANIFEST_TS_PATH = path.resolve(
  process.cwd(),
  'src',
  'data',
  'academyAudioManifest.ts',
);

export interface ValidatedMp3Metrics {
  valid: boolean;
  bytes: number;
  durationSeconds: number | null;
  maxVolumeDb: number | null;
  meanVolumeDb: number | null;
  sha256: string | null;
  reason?: string;
}

export async function validateAcademyMp3File(filePath: string): Promise<ValidatedMp3Metrics> {
  if (!fs.existsSync(filePath)) {
    return {
      valid: false,
      bytes: 0,
      durationSeconds: null,
      maxVolumeDb: null,
      meanVolumeDb: null,
      sha256: null,
      reason: 'File does not exist',
    };
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 512) {
    return {
      valid: false,
      bytes: stat.size,
      durationSeconds: null,
      maxVolumeDb: null,
      meanVolumeDb: null,
      sha256: null,
      reason: `Undersized MP3 (${stat.size} bytes)`,
    };
  }

  const buf = fs.readFileSync(filePath);
  const magic = hasValidAudioMagicBytes(buf);
  if (!magic.ok || magic.mimeType !== 'audio/mpeg') {
    return {
      valid: false,
      bytes: stat.size,
      durationSeconds: null,
      maxVolumeDb: null,
      meanVolumeDb: null,
      sha256: null,
      reason: `Invalid MP3 signature (detected=${magic.mimeType || 'none'})`,
    };
  }

  let durationSeconds: number | null = null;
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=codec_name:format=duration',
        '-of',
        'json',
        filePath,
      ],
      { timeout: 10_000 },
    );
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ codec_name?: string }>;
      format?: { duration?: string };
    };
    const codec = parsed.streams?.[0]?.codec_name;
    if (codec !== 'mp3') {
      return {
        valid: false,
        bytes: stat.size,
        durationSeconds: null,
        maxVolumeDb: null,
        meanVolumeDb: null,
        sha256: null,
        reason: `Unexpected codec=${codec || 'unknown'}`,
      };
    }
    const dur = Number.parseFloat(String(parsed.format?.duration || ''));
    if (!Number.isFinite(dur) || dur < 0.15 || dur > 45) {
      return {
        valid: false,
        bytes: stat.size,
        durationSeconds: Number.isFinite(dur) ? dur : null,
        maxVolumeDb: null,
        meanVolumeDb: null,
        sha256: null,
        reason: `Duration out of range (${dur}s)`,
      };
    }
    durationSeconds = Math.round(dur * 100) / 100;
  } catch (err) {
    return {
      valid: false,
      bytes: stat.size,
      durationSeconds: null,
      maxVolumeDb: null,
      meanVolumeDb: null,
      sha256: null,
      reason: `ffprobe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let maxVolumeDb: number | null = null;
  let meanVolumeDb: number | null = null;
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      ['-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'],
      { timeout: 12_000 },
    );
    const maxMatch = /max_volume:\s*([-\d.]+)\s*dB/i.exec(stderr || '');
    const meanMatch = /mean_volume:\s*([-\d.]+)\s*dB/i.exec(stderr || '');
    maxVolumeDb = maxMatch ? Number.parseFloat(maxMatch[1]) : null;
    meanVolumeDb = meanMatch ? Number.parseFloat(meanMatch[1]) : null;
    if (maxVolumeDb === null || !Number.isFinite(maxVolumeDb) || maxVolumeDb <= -45) {
      return {
        valid: false,
        bytes: stat.size,
        durationSeconds,
        maxVolumeDb,
        meanVolumeDb,
        sha256: null,
        reason: `Audio is silent or too quiet (max_volume=${maxVolumeDb ?? 'unknown'} dB)`,
      };
    }
  } catch (err) {
    return {
      valid: false,
      bytes: stat.size,
      durationSeconds,
      maxVolumeDb: null,
      meanVolumeDb: null,
      sha256: null,
      reason: `volumedetect failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    valid: true,
    bytes: stat.size,
    durationSeconds,
    maxVolumeDb,
    meanVolumeDb,
    sha256,
  };
}

async function transcodeToAcademyMp3(
  rawBuf: Buffer,
  upstreamMimeType: string | undefined,
  destPath: string,
): Promise<void> {
  const wrapped = ensureWavContainerFromPcm(rawBuf, upstreamMimeType);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const ext = wrapped.mimeType === 'audio/mpeg' ? '.mp3' : wrapped.mimeType === 'audio/ogg' ? '.ogg' : '.wav';
  const tmpIn = path.join(path.dirname(destPath), `.tmp-${crypto.randomUUID()}${ext}`);
  const tmpOut = path.join(path.dirname(destPath), `.tmp-${crypto.randomUUID()}.mp3`);

  try {
    fs.writeFileSync(tmpIn, wrapped.buffer);
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        tmpIn,
        '-ar',
        '24000',
        '-ac',
        '1',
        '-codec:a',
        'libmp3lame',
        '-b:a',
        '64k',
        tmpOut,
      ],
      { timeout: 20_000 },
    );
    const metrics = await validateAcademyMp3File(tmpOut);
    if (!metrics.valid) {
      throw new Error(`Transcoded MP3 failed validation: ${metrics.reason}`);
    }
    fs.renameSync(tmpOut, destPath);
  } finally {
    if (fs.existsSync(tmpIn)) {
      try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    }
    if (fs.existsSync(tmpOut)) {
      try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
    }
  }
}

async function synthesizeOneAcademyMp3(opts: {
  speechText: string;
  language: AcademyAudioLang;
  destPath: string;
  voiceName?: string;
}): Promise<{ model: string; voiceName: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('GEMINI_API_KEY is missing'), { status: 503 });
  }

  const voiceName = opts.voiceName || 'Zephyr';
  const style =
    opts.language === 'ar'
      ? 'Warm, crystal-clear, gentle Modern Standard Arabic early-childhood teacher voice for ages 1 to 4. Natural cheerful pacing and crisp letter and word articulation.'
      : 'Warm, crystal-clear, cheerful English early-childhood teacher voice for ages 1 to 4. Natural pacing and crisp phonics pronunciation.';

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });

  const models = [PRIMARY_TTS_MODEL, FALLBACK_TTS_MODEL];
  let lastErr: unknown = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 28_000);
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [{ text: opts.speechText, speechMetadata: { style } }],
            },
          ],
          config: {
            abortSignal: controller.signal,
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        });

        const parts = response.candidates?.[0]?.content?.parts || [];
        const inline = parts.find((p) => Boolean(p?.inlineData?.data))?.inlineData;
        if (!inline?.data) {
          throw new Error(`Empty audio payload from ${model}`);
        }
        const rawBuf = Buffer.from(inline.data, 'base64');
        if (rawBuf.length < 256) {
          throw new Error(`Undersized raw audio payload (${rawBuf.length} bytes) from ${model}`);
        }
        await transcodeToAcademyMp3(rawBuf, inline.mimeType, opts.destPath);
        return { model, voiceName };
      } catch (err) {
        lastErr = err;
        const classified = classifyUpstreamTtsError(err);
        if (!classified.retryable) {
          throw err;
        }
        if (classified.isDailyExhausted) {
          // Move immediately to fallback model if available
          break;
        }
        if (attempt < 4) {
          const waitMs = Math.min(
            20_000,
            Math.max(classified.retryAfterMs || 1500, 1200 * Math.pow(2, attempt - 1)),
          );
          await new Promise((r) => setTimeout(r, waitMs + Math.floor(Math.random() * 400)));
        }
      } finally {
        clearTimeout(timer);
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr || 'Synthesis failed'));
}

export function writeAcademyManifestArtifacts(items: AcademyAudioManifestItem[]): {
  total: number;
  generated: number;
  valid: number;
  failed: number;
  arValid: number;
  enValid: number;
} {
  fs.mkdirSync(ACADEMY_AUDIO_ROOT_DIR, { recursive: true });
  fs.mkdirSync(path.join(ACADEMY_AUDIO_ROOT_DIR, 'ar'), { recursive: true });
  fs.mkdirSync(path.join(ACADEMY_AUDIO_ROOT_DIR, 'en'), { recursive: true });

  const generated = items.filter((i) => i.generationStatus === 'generated').length;
  const validItems = items.filter((i) => i.validationStatus === 'valid');
  const failed = items.filter((i) => i.generationStatus === 'failed' || i.validationStatus === 'invalid').length;
  const arValid = validItems.filter((i) => i.language === 'ar').length;
  const enValid = validItems.filter((i) => i.language === 'en').length;

  const manifestDoc = {
    version: 1,
    generatedAt: new Date().toISOString(),
    summary: {
      totalAssets: items.length,
      generatedAssets: generated,
      validAssets: validItems.length,
      failedAssets: failed,
      arAssets: items.filter((i) => i.language === 'ar').length,
      enAssets: items.filter((i) => i.language === 'en').length,
      arValidAssets: arValid,
      enValidAssets: enValid,
    },
    items,
  };

  const tmpJson = path.join(ACADEMY_AUDIO_ROOT_DIR, `.tmp-manifest-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmpJson, JSON.stringify(manifestDoc, null, 2), 'utf8');
  fs.renameSync(tmpJson, ACADEMY_MANIFEST_JSON_PATH);

  // Also generate the TypeScript client lookup manifest
  const urlByKey: Record<string, string> = {};
  const assetsMeta: Record<string, { url: string; lang: AcademyAudioLang; durationSeconds: number | null }> = {};
  for (const item of validItems) {
    assetsMeta[item.assetId] = {
      url: item.publicUrl,
      lang: item.language,
      durationSeconds: item.durationSeconds,
    };
    for (const k of item.aliasKeys) {
      urlByKey[k] = item.publicUrl;
    }
  }

  const tsContent = `// AUTO-GENERATED BY academyAudioPrepService — DO NOT EDIT MANUALLY
export interface AcademyManifestAssetMeta {
  url: string;
  lang: 'ar' | 'en';
  durationSeconds: number | null;
}

export const ACADEMY_AUDIO_MANIFEST_SUMMARY = {
  totalAssets: ${items.length},
  validAssets: ${validItems.length},
  arValidAssets: ${arValid},
  enValidAssets: ${enValid},
  aliasCount: ${Object.keys(urlByKey).length},
  generatedAt: ${JSON.stringify(manifestDoc.generatedAt)},
} as const;

export const ACADEMY_AUDIO_ASSETS: Record<string, AcademyManifestAssetMeta> = ${JSON.stringify(assetsMeta, null, 2)};

export const ACADEMY_AUDIO_BY_KEY: Record<string, string> = ${JSON.stringify(urlByKey, null, 2)};

export function normalizeAcademyAudioLookupText(raw: string): string {
  return String(raw || '').trim().replace(/\\s+/g, ' ');
}

export function resolveAcademyAudioUrl(text: string, lang: 'ar' | 'en'): string | null {
  const normalized = normalizeAcademyAudioLookupText(text);
  if (!normalized) return null;
  const direct = ACADEMY_AUDIO_BY_KEY[\`\${lang}|\${normalized}\`];
  if (direct) return direct;
  const stripped = normalized
    .replace(/[\\u200D\\uFE0F]/g, '')
    .replace(/\\p{Extended_Pictographic}/gu, '')
    .replace(/\\s+/g, ' ')
    .trim();
  return ACADEMY_AUDIO_BY_KEY[\`\${lang}|\${stripped}\`] || null;
}
`;
  const tmpTs = path.join(path.dirname(ACADEMY_CLIENT_MANIFEST_TS_PATH), `.tmp-manifest-${crypto.randomUUID()}.ts`);
  fs.writeFileSync(tmpTs, tsContent, 'utf8');
  fs.renameSync(tmpTs, ACADEMY_CLIENT_MANIFEST_TS_PATH);

  return {
    total: items.length,
    generated,
    valid: validItems.length,
    failed,
    arValid,
    enValid,
  };
}

export interface AcademyPrepProgress {
  state: 'idle' | 'running' | 'completed' | 'partial_error';
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  processed: number;
  skippedExistingValid: number;
  newlyGenerated: number;
  failed: number;
  currentAssetId: string | null;
  lastError: string | null;
}

const prepProgress: AcademyPrepProgress = {
  state: 'idle',
  startedAt: null,
  finishedAt: null,
  total: 0,
  processed: 0,
  skippedExistingValid: 0,
  newlyGenerated: 0,
  failed: 0,
  currentAssetId: null,
  lastError: null,
};

let activePrepPromise: Promise<AcademyPrepProgress> | null = null;

export function getAcademyPrepProgress(): AcademyPrepProgress {
  return { ...prepProgress };
}

export async function runAcademyAudioBatchPreparation(opts?: {
  limit?: number;
  concurrency?: number;
  onlyValidateExisting?: boolean;
}): Promise<AcademyPrepProgress> {
  if (activePrepPromise) return activePrepPromise;

  activePrepPromise = (async () => {
    const items = collectAcademyAudioManifestItems();
    const limit = typeof opts?.limit === 'number' && opts.limit > 0 ? opts.limit : items.length;
    const concurrency = Math.max(1, Math.min(4, opts?.concurrency ?? 3));

    // Hydrate previous manifest metadata if present so we keep model/voice info on skipped files
    const prevById = new Map<string, Partial<AcademyAudioManifestItem>>();
    if (fs.existsSync(ACADEMY_MANIFEST_JSON_PATH)) {
      try {
        const prevDoc = JSON.parse(fs.readFileSync(ACADEMY_MANIFEST_JSON_PATH, 'utf8')) as {
          items?: AcademyAudioManifestItem[];
        };
        for (const p of prevDoc.items || []) {
          prevById.set(p.assetId, p);
        }
      } catch {
        // ignore corrupt prior manifest
      }
    }

    prepProgress.state = 'running';
    prepProgress.startedAt = new Date().toISOString();
    prepProgress.finishedAt = null;
    prepProgress.total = Math.min(limit, items.length);
    prepProgress.processed = 0;
    prepProgress.skippedExistingValid = 0;
    prepProgress.newlyGenerated = 0;
    prepProgress.failed = 0;
    prepProgress.currentAssetId = null;
    prepProgress.lastError = null;

    let cursor = 0;
    const targetItems = items.slice(0, prepProgress.total);
    let saveCounter = 0;

    async function worker() {
      while (true) {
        const myIdx = cursor++;
        if (myIdx >= targetItems.length) break;

        const item = targetItems[myIdx];
        const absPath = path.resolve(process.cwd(), item.mp3RelativePath);
        prepProgress.currentAssetId = item.assetId;

        // 1. Check if valid MP3 already exists on disk (never regenerate existing valid!)
        const existing = await validateAcademyMp3File(absPath);
        if (existing.valid) {
          const prev = prevById.get(item.assetId);
          item.generationStatus = 'generated';
          item.validationStatus = 'valid';
          item.bytes = existing.bytes;
          item.durationSeconds = existing.durationSeconds;
          item.maxVolumeDb = existing.maxVolumeDb;
          item.sha256 = existing.sha256;
          item.model = prev?.model || PRIMARY_TTS_MODEL;
          item.voiceName = prev?.voiceName || 'Zephyr';
          prepProgress.skippedExistingValid += 1;
          prepProgress.processed += 1;
          continue;
        }

        if (opts?.onlyValidateExisting) {
          item.generationStatus = 'pending';
          item.validationStatus = 'invalid';
          item.errorReason = existing.reason;
          prepProgress.failed += 1;
          prepProgress.processed += 1;
          continue;
        }

        // 2. Synthesize & validate
        try {
          const synth = await synthesizeOneAcademyMp3({
            speechText: item.speechText,
            language: item.language,
            destPath: absPath,
          });
          const check = await validateAcademyMp3File(absPath);
          if (!check.valid) {
            throw new Error(check.reason || 'Post-synthesis validation failed');
          }
          item.generationStatus = 'generated';
          item.validationStatus = 'valid';
          item.bytes = check.bytes;
          item.durationSeconds = check.durationSeconds;
          item.maxVolumeDb = check.maxVolumeDb;
          item.sha256 = check.sha256;
          item.model = synth.model;
          item.voiceName = synth.voiceName;
          item.errorReason = undefined;
          prepProgress.newlyGenerated += 1;
        } catch (err) {
          const safeMsg = (err instanceof Error ? err.message : String(err))
            .replace(/AIza[0-9A-Za-z_-]+/g, '[REDACTED]')
            .slice(0, 1200);
          item.generationStatus = 'failed';
          item.validationStatus = 'invalid';
          item.errorReason = safeMsg;
          prepProgress.failed += 1;
          prepProgress.lastError = `${item.assetId}: ${safeMsg}`;
        }

        prepProgress.processed += 1;
        saveCounter += 1;
        if (saveCounter % 25 === 0) {
          writeAcademyManifestArtifacts(items);
        }

        // Gentle pacing to respect RPM limits
        await new Promise((r) => setTimeout(r, 180));
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    // On final write, validate any remaining items beyond `limit` (when limit < total)
    if (limit < items.length) {
      for (let i = limit; i < items.length; i += 1) {
        const it = items[i];
        const abs = path.resolve(process.cwd(), it.mp3RelativePath);
        const check = await validateAcademyMp3File(abs);
        if (check.valid) {
          it.generationStatus = 'generated';
          it.validationStatus = 'valid';
          it.bytes = check.bytes;
          it.durationSeconds = check.durationSeconds;
          it.maxVolumeDb = check.maxVolumeDb;
          it.sha256 = check.sha256;
        }
      }
    }

    writeAcademyManifestArtifacts(items);
    prepProgress.currentAssetId = null;
    prepProgress.finishedAt = new Date().toISOString();
    prepProgress.state = prepProgress.failed > 0 ? 'partial_error' : 'completed';
    return getAcademyPrepProgress();
  })();

  try {
    return await activePrepPromise;
  } finally {
    activePrepPromise = null;
  }
}

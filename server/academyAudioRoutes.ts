import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type express from 'express';
import { sanitizeShortText } from '../src/utils/validation';
import type { AuthenticatedRequest } from './dbTypes';
import { checkRateLimitPg } from './pgStore';
import { getClientIp } from './security';
import {
  getAcademyPrepProgress,
  runAcademyAudioBatchPreparation,
} from './academyAudioPrepService';
import {
  ACADEMY_AUDIO_PUBLIC_DIR,
  FALLBACK_TTS_MODEL,
  getAcademyAudioCacheKey,
  getOrCreateAcademyAudio,
  PRIMARY_TTS_MODEL,
} from './ttsService';

interface AcademyAudioRouteDeps {
  app: express.Express;
}

export function registerAcademyAudioRoutes({ app }: AcademyAudioRouteDeps) {
  app.get('/api/academy/tts-status', (_req, res) => {
    res.json({
      configured: Boolean(process.env.GEMINI_API_KEY),
      primaryModel: PRIMARY_TTS_MODEL,
      fallbackModel: FALLBACK_TTS_MODEL,
    });
  });

  app.get('/api/academy/prep/status', (req, res) => {
    const ip = getClientIp(req);
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      return res.status(403).json({ error: 'Localhost only' });
    }
    return res.json(getAcademyPrepProgress());
  });

  app.post('/api/academy/prep/run', (req, res) => {
    const ip = getClientIp(req);
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      return res.status(403).json({ error: 'Localhost only' });
    }
    const body = (req.body || {}) as { limit?: number; concurrency?: number; onlyValidateExisting?: boolean };
    void runAcademyAudioBatchPreparation({
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      concurrency: typeof body.concurrency === 'number' ? body.concurrency : 3,
      onlyValidateExisting: Boolean(body.onlyValidateExisting),
    });
    return res.status(202).json({ started: true, status: getAcademyPrepProgress() });
  });

  app.post('/api/academy/tts', async (req: AuthenticatedRequest, res) => {
    const requestId = `acad_${crypto.randomBytes(6).toString('hex')}`;
    const body = (req.body || {}) as { text?: string; lang?: string; language?: string };
    const cleanText = sanitizeShortText(typeof body.text === 'string' ? body.text : '', 320);
    const rawLang = body.lang || body.language;
    const lang: 'ar' | 'en' = rawLang === 'en' ? 'en' : 'ar';

    if (!cleanText) {
      return res.status(400).json({
        error: 'text is required',
        code: 'INVALID_TTS_INPUT',
        retryable: false,
        requestId,
      });
    }

    // Only enforce rate-limiting on uncached synthesis requests; cached disk hits are free & unlimited
    const cacheKey = getAcademyAudioCacheKey(cleanText, lang);
    const hasDiskCache =
      fs.existsSync(path.join(ACADEMY_AUDIO_PUBLIC_DIR, `${cacheKey}.mp3`)) ||
      fs.existsSync(path.join(ACADEMY_AUDIO_PUBLIC_DIR, `${cacheKey}.wav`));

    if (!hasDiskCache) {
      const rateIdentity = req.authSession?.user?.id || getClientIp(req);
      if (!(await checkRateLimitPg(`ai-academy-tts:${rateIdentity}`, 90, 5 * 60_000))) {
        return res.status(429).json({
          error: 'Too many new voice requests in a short window. Please wait a moment and retry.',
          code: 'TTS_RATE_LIMITED',
          retryable: true,
          requestId,
        });
      }
    }

    const result = await getOrCreateAcademyAudio({
      text: cleanText,
      language: lang,
      requestId,
    });

    if (!result.ok) {
      return res.status(result.httpStatus).json({
        error: result.message,
        code: result.code,
        retryable: result.retryable,
        requestId: result.requestId,
        model: result.model,
        httpStatus: result.httpStatus,
        detail: result.sanitizedDetail,
      });
    }

    return res.json({
      ok: true,
      audioUrl: result.audioUrl,
      mimeType: result.mimeType,
      bytes: result.bytes,
      cached: result.cached,
      model: result.model,
      requestId: result.requestId,
    });
  });
}

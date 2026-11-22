import crypto from 'node:crypto';
import {
  ACADEMY_COLORS,
  ACADEMY_SHAPES,
  ARABIC_ALPHABET,
  ENGLISH_ALPHABET,
  NUMBER_TIERS,
} from '../src/data/academyData';
import {
  buildArabicDeepJourney,
  buildColorDeepJourney,
  buildEnglishDeepJourney,
  MATH_DEEP_UNITS,
} from '../src/data/deepCurriculum';
import { ALL_LEVEL1_LESSONS } from '../src/data/level1Curriculum';
import { LEVEL1_QUESTION_BANK } from '../src/data/level1QuestionBank';

export type AcademyAudioLang = 'ar' | 'en';

export interface AcademyAudioUsage {
  screen: string;
  lessonId: string;
  activityStageId: string;
  exactText: string;
}

export interface AcademyAudioManifestItem {
  assetId: string;
  language: AcademyAudioLang;
  exactText: string;
  normalizedKey: string;
  aliasKeys: string[];
  speechText: string;
  mp3RelativePath: string;
  publicUrl: string;
  usages: AcademyAudioUsage[];
  generationStatus: 'pending' | 'generated' | 'failed';
  validationStatus: 'pending' | 'valid' | 'invalid';
  bytes: number;
  durationSeconds: number | null;
  maxVolumeDb: number | null;
  sha256: string | null;
  model: string | null;
  voiceName: string | null;
  errorReason?: string;
}

export function normalizeAcademyKeyText(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function stripEmojisForSpeech(raw: string): string {
  return String(raw || '')
    .replace(/[\u200D\uFE0F]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[—–]/g, '، ')
    .replace(/\s+/g, ' ')
    .trim();
}

const AR_NUMBER_WORDS: Record<number, string> = {
  0: 'صِفْر',
  1: 'وَاحِد',
  2: 'اِثْنَان',
  3: 'ثَلَاثَة',
  4: 'أَرْبَعَة',
  5: 'خَمْسَة',
  6: 'سِتَّة',
  7: 'سَبْعَة',
  8: 'ثَمَانِيَة',
  9: 'تِسْعَة',
  10: 'عَشَرَة',
  11: 'أَحَدَ عَشَر',
  12: 'اِثْنَا عَشَر',
  13: 'ثَلَاثَةَ عَشَر',
  14: 'أَرْبَعَةَ عَشَر',
  15: 'خَمْسَةَ عَشَر',
  16: 'سِتَّةَ عَشَر',
  17: 'سَبْعَةَ عَشَر',
  18: 'ثَمَانِيَةَ عَشَر',
  19: 'تِسْعَةَ عَشَر',
  20: 'عِشْرُون',
};

const EN_NUMBER_WORDS: Record<number, string> = {
  0: 'Zero.',
  1: 'One.',
  2: 'Two.',
  3: 'Three.',
  4: 'Four.',
  5: 'Five.',
  6: 'Six.',
  7: 'Seven.',
  8: 'Eight.',
  9: 'Nine.',
  10: 'Ten.',
  11: 'Eleven.',
  12: 'Twelve.',
  13: 'Thirteen.',
  14: 'Fourteen.',
  15: 'Fifteen.',
  16: 'Sixteen.',
  17: 'Seventeen.',
  18: 'Eighteen.',
  19: 'Nineteen.',
  20: 'Twenty.',
};

const AR_COUNT_OBJECTS: Record<number, string> = {
  0: 'صِفْر، سَلَّةٌ فَارِغَة',
  1: 'تُفَّاحَةٌ وَاحِدَة',
  2: 'نَجْمَتَان',
  3: 'ثَلَاثُ بَالُونَات',
  4: 'أَرْبَعَةُ كَتَاكِيت',
  5: 'خَمْسَةُ دَبَادِيب',
  6: 'سِتُّ فَرَاوِلَات',
  7: 'سَبْعُ سَيَّارَات',
  8: 'ثَمَانِي فَرَاشَات',
  9: 'تِسْعُ زَهَرَات',
  10: 'عَشْرُ نُجُوم',
};

const AR_LETTER_BY_CHAR = new Map<string, (typeof ARABIC_ALPHABET)[number]>(
  ARABIC_ALPHABET.map((entry) => [entry.char, entry]),
);

function buildDeterministicAssetId(lang: AcademyAudioLang, speechText: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`nono-academy-v1|${lang}|${speechText}`)
    .digest('hex')
    .slice(0, 12);
  return `acad-${lang}-${hash}`;
}

export function collectAcademyAudioManifestItems(): AcademyAudioManifestItem[] {
  // Deduplicate by (language + normalized speechText) so identical spoken recordings
  // share a single MP3 asset while preserving every lookup alias and lesson usage.
  const bySpeechKey = new Map<string, AcademyAudioManifestItem>();

  const register = (params: {
    language: AcademyAudioLang;
    exactText: string;
    speechText: string;
    usage: AcademyAudioUsage;
    extraAliases?: string[];
  }) => {
    const normalizedExact = normalizeAcademyKeyText(params.exactText);
    const cleanSpeech = normalizeAcademyKeyText(params.speechText);
    if (!normalizedExact || !cleanSpeech) return;

    const dedupeKey = `${params.language}|${cleanSpeech}`;
    const primaryLookupKey = `${params.language}|${normalizedExact}`;

    let item = bySpeechKey.get(dedupeKey);
    if (!item) {
      const assetId = buildDeterministicAssetId(params.language, cleanSpeech);
      const mp3RelativePath = `public/assets/audio/academy/${params.language}/${assetId}.mp3`;
      const publicUrl = `/assets/audio/academy/${params.language}/${assetId}.mp3`;
      item = {
        assetId,
        language: params.language,
        exactText: normalizedExact,
        normalizedKey: primaryLookupKey,
        aliasKeys: [primaryLookupKey],
        speechText: cleanSpeech,
        mp3RelativePath,
        publicUrl,
        usages: [],
        generationStatus: 'pending',
        validationStatus: 'pending',
        bytes: 0,
        durationSeconds: null,
        maxVolumeDb: null,
        sha256: null,
        model: null,
        voiceName: null,
      };
      bySpeechKey.set(dedupeKey, item);
    }

    if (!item.aliasKeys.includes(primaryLookupKey)) {
      item.aliasKeys.push(primaryLookupKey);
    }
    for (const extra of params.extraAliases || []) {
      const k = `${params.language}|${normalizeAcademyKeyText(extra)}`;
      if (extra && !item.aliasKeys.includes(k)) {
        item.aliasKeys.push(k);
      }
    }

    const alreadyHasUsage = item.usages.some(
      (u) =>
        u.screen === params.usage.screen &&
        u.lessonId === params.usage.lessonId &&
        u.activityStageId === params.usage.activityStageId &&
        u.exactText === normalizedExact,
    );
    if (!alreadyHasUsage) {
      item.usages.push({ ...params.usage, exactText: normalizedExact });
    }
  };

  // 1. Arabic Alphabet Tab (28 cards + slow/normal)
  for (const entry of ARABIC_ALPHABET) {
    const text = `${entry.nameAr}، ${entry.word}`;
    register({
      language: 'ar',
      exactText: text,
      speechText: text,
      usage: {
        screen: 'AcademyScreen:ArabicTab',
        lessonId: entry.id,
        activityStageId: 'letter-card-and-detail',
        exactText: text,
      },
    });
  }

  // 2. English Alphabet Tab (26 cards + Deep English Stage 1-2)
  for (const entry of ENGLISH_ALPHABET) {
    const text = `${entry.upper}. ${entry.word}`;
    register({
      language: 'en',
      exactText: text,
      speechText: `Letter ${entry.upper}. ${entry.word}.`,
      usage: {
        screen: 'AcademyScreen:EnglishTab',
        lessonId: entry.id,
        activityStageId: 'letter-card-and-detail',
        exactText: text,
      },
    });
  }

  // 3. English CVC Word Builder words (AcademyScreen + ENGLISH_ALPHABET cvcExample)
  const cvcWords = Array.from(
    new Set(['CAT', 'SUN', 'DOG', 'HAT', ...ENGLISH_ALPHABET.map((e) => e.cvcExample)]),
  );
  for (const w of cvcWords) {
    const natural = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() + '.';
    register({
      language: 'en',
      exactText: w,
      speechText: natural,
      extraAliases: [w.toLowerCase()],
      usage: {
        screen: 'AcademyScreen:EnglishTab',
        lessonId: `cvc-${w}`,
        activityStageId: 'cvc-word-builder',
        exactText: w,
      },
    });
  }

  // 4. Numbers & Math Tab (0..20 in AR and EN)
  const allNumbers = Array.from(
    new Set([0, ...NUMBER_TIERS.flatMap((tier) => tier.numbers)]),
  ).sort((a, b) => a - b);
  for (const num of allNumbers) {
    const numStr = String(num);
    register({
      language: 'ar',
      exactText: numStr,
      speechText: AR_NUMBER_WORDS[num] || numStr,
      extraAliases: num <= 10 ? [AR_NUMBER_WORDS[num].replace(/[\u064B-\u0652]/g, '')] : [],
      usage: {
        screen: 'AcademyScreen:NumbersTab',
        lessonId: `num-${num}`,
        activityStageId: 'number-card',
        exactText: numStr,
      },
    });
    register({
      language: 'en',
      exactText: numStr,
      speechText: EN_NUMBER_WORDS[num] || numStr,
      usage: {
        screen: 'AcademyScreen:NumbersTab',
        lessonId: `num-${num}`,
        activityStageId: 'number-card',
        exactText: numStr,
      },
    });
  }

  // 5. Colors & Shapes Tab
  for (const col of ACADEMY_COLORS) {
    register({
      language: 'ar',
      exactText: col.name.ar,
      speechText: col.name.ar,
      usage: {
        screen: 'AcademyScreen:ColorsShapesTab',
        lessonId: `color-${col.id}`,
        activityStageId: 'color-card',
        exactText: col.name.ar,
      },
    });
    register({
      language: 'en',
      exactText: col.name.en,
      speechText: `${col.name.en}.`,
      usage: {
        screen: 'AcademyScreen:ColorsShapesTab',
        lessonId: `color-${col.id}`,
        activityStageId: 'color-card',
        exactText: col.name.en,
      },
    });
  }
  for (const sh of ACADEMY_SHAPES) {
    register({
      language: 'ar',
      exactText: sh.name.ar,
      speechText: sh.name.ar,
      usage: {
        screen: 'AcademyScreen:ColorsShapesTab',
        lessonId: `shape-${sh.id}`,
        activityStageId: 'shape-card',
        exactText: sh.name.ar,
      },
    });
    register({
      language: 'en',
      exactText: sh.name.en,
      speechText: `${sh.name.en}.`,
      usage: {
        screen: 'AcademyScreen:ColorsShapesTab',
        lessonId: `shape-${sh.id}`,
        activityStageId: 'shape-card',
        exactText: sh.name.en,
      },
    });
  }

  // 6. All 75 Level 1 Lessons (Stages 1, 2, 3, 5)
  for (const lesson of ALL_LEVEL1_LESSONS) {
    if (lesson.subject === 'arabic') {
      const arMeta = AR_LETTER_BY_CHAR.get(lesson.targetSymbol);
      const letterSpoken = arMeta?.nameAr || lesson.targetSymbol;

      // Stage 1: intro
      register({
        language: 'ar',
        exactText: lesson.characterIntro.ar,
        speechText: lesson.characterIntro.ar.replace(
          new RegExp(`:\\s*${lesson.targetSymbol}$`),
          `: ${letterSpoken}`,
        ),
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-1-welcome-intro',
          exactText: lesson.characterIntro.ar,
        },
      });

      // Stage 2: teachingVocab
      for (const v of lesson.teachingVocab) {
        register({
          language: 'ar',
          exactText: v.text,
          speechText: v.text,
          usage: {
            screen: 'Level1LessonRunner',
            lessonId: lesson.id,
            activityStageId: 'stage-2-visual-see',
            exactText: v.text,
          },
        });
      }

      // Stage 3: normal title & slow symbol+word
      register({
        language: 'ar',
        exactText: lesson.title.ar,
        speechText: lesson.title.ar.replace(`(${lesson.targetSymbol})`, ''),
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-3-audio-hear-normal',
          exactText: lesson.title.ar,
        },
      });
      const slowText = `${lesson.targetSymbol}، ${lesson.teachingVocab[0]?.text || ''}`;
      register({
        language: 'ar',
        exactText: slowText,
        speechText: `${letterSpoken}، ${lesson.teachingVocab[0]?.text || ''}`,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-3-audio-hear-slow',
          exactText: slowText,
        },
      });

      // Stage 5: targetSymbol
      register({
        language: 'ar',
        exactText: lesson.targetSymbol,
        speechText: letterSpoken,
        extraAliases: arMeta ? [arMeta.nameAr] : [],
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-5-listen-select',
          exactText: lesson.targetSymbol,
        },
      });
    } else if (lesson.subject === 'english') {
      // Stage 1: intro
      register({
        language: 'en',
        exactText: lesson.characterIntro.en,
        speechText: lesson.characterIntro.en.replace(
          `uppercase ${lesson.targetSymbol} and lowercase ${lesson.secondarySymbol}`,
          `letter ${lesson.targetSymbol}`,
        ),
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-1-welcome-intro',
          exactText: lesson.characterIntro.en,
        },
      });

      // Stage 2: teachingVocab
      for (const v of lesson.teachingVocab) {
        register({
          language: 'en',
          exactText: v.text,
          speechText: `${v.text}.`,
          usage: {
            screen: 'Level1LessonRunner',
            lessonId: lesson.id,
            activityStageId: 'stage-2-visual-see',
            exactText: v.text,
          },
        });
      }

      // Stage 3: normal title & slow symbol+word
      register({
        language: 'en',
        exactText: lesson.title.en,
        speechText: `Discover Letter ${lesson.targetSymbol}.`,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-3-audio-hear-normal',
          exactText: lesson.title.en,
        },
      });
      const slowText = `${lesson.targetSymbol}، ${lesson.teachingVocab[0]?.text || ''}`;
      register({
        language: 'en',
        exactText: slowText,
        speechText: `Letter ${lesson.targetSymbol}. ${lesson.teachingVocab[0]?.text || ''}.`,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-3-audio-hear-slow',
          exactText: slowText,
        },
      });

      // Stage 5 + lowercase Q08 alias: targetSymbol & secondarySymbol
      register({
        language: 'en',
        exactText: lesson.targetSymbol,
        speechText: `Letter ${lesson.targetSymbol}.`,
        extraAliases: lesson.secondarySymbol ? [lesson.secondarySymbol] : [],
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-5-listen-select',
          exactText: lesson.targetSymbol,
        },
      });
    } else if (lesson.subject === 'numbers') {
      const val = lesson.numberValue ?? 0;
      const arWord = AR_NUMBER_WORDS[val] || lesson.secondarySymbol || String(val);
      const enWord = EN_NUMBER_WORDS[val] || String(val);

      // Stage 1: intro (AR + EN)
      register({
        language: 'ar',
        exactText: lesson.characterIntro.ar,
        speechText: `أهلاً يا صديقي! بوبو يحب العدّ، واليوم نكتشف معاً العدد ${arWord}!`,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-1-welcome-intro',
          exactText: lesson.characterIntro.ar,
        },
      });
      register({
        language: 'en',
        exactText: lesson.characterIntro.en,
        speechText: `Hello friend! Bobo loves counting, and today we discover number ${enWord}`,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-1-welcome-intro',
          exactText: lesson.characterIntro.en,
        },
      });

      // Stage 2: teachingVocab (AR + EN)
      for (const v of lesson.teachingVocab) {
        register({
          language: 'ar',
          exactText: v.text,
          speechText: AR_COUNT_OBJECTS[val] || arWord,
          usage: {
            screen: 'Level1LessonRunner',
            lessonId: lesson.id,
            activityStageId: 'stage-2-visual-see',
            exactText: v.text,
          },
        });
        if (v.secondaryText) {
          register({
            language: 'en',
            exactText: v.secondaryText,
            speechText: enWord,
            usage: {
              screen: 'Level1LessonRunner',
              lessonId: lesson.id,
              activityStageId: 'stage-2-visual-see',
              exactText: v.secondaryText,
            },
          });
        }
      }

      // Stage 3: normal title (AR + EN) & slow cue (AR + EN)
      register({
        language: 'ar',
        exactText: lesson.title.ar,
        speechText: `اكتشف العدد ${arWord}`,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-3-audio-hear-normal',
          exactText: lesson.title.ar,
        },
      });
      register({
        language: 'en',
        exactText: lesson.title.en,
        speechText: `Discover Number ${enWord}`,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-3-audio-hear-normal',
          exactText: lesson.title.en,
        },
      });

      const slowArText = `${lesson.targetSymbol}، ${lesson.teachingVocab[0]?.text || ''}`;
      register({
        language: 'ar',
        exactText: slowArText,
        speechText: `${arWord}، ${AR_COUNT_OBJECTS[val] || arWord}`,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-3-audio-hear-slow',
          exactText: slowArText,
        },
      });
      const slowEnText = `${lesson.targetSymbol}. ${lesson.teachingVocab[0]?.secondaryText || enWord}`;
      register({
        language: 'en',
        exactText: slowEnText,
        speechText: `${enWord}`,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-3-audio-hear-slow',
          exactText: slowEnText,
        },
      });
    } else if (lesson.subject === 'colors') {
      const arColor = lesson.targetSymbol;
      const enColor = lesson.secondarySymbol || lesson.targetSymbol;

      // Color name standalone (includes Black & Brown)
      register({
        language: 'ar',
        exactText: arColor,
        speechText: arColor,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-5-listen-select',
          exactText: arColor,
        },
      });
      register({
        language: 'en',
        exactText: enColor,
        speechText: `${enColor}.`,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-5-listen-select',
          exactText: enColor,
        },
      });

      // Stage 1: intro
      register({
        language: 'ar',
        exactText: lesson.characterIntro.ar,
        speechText: lesson.characterIntro.ar,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-1-welcome-intro',
          exactText: lesson.characterIntro.ar,
        },
      });
      register({
        language: 'en',
        exactText: lesson.characterIntro.en,
        speechText: lesson.characterIntro.en,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-1-welcome-intro',
          exactText: lesson.characterIntro.en,
        },
      });

      // Stage 2: teachingVocab
      for (const v of lesson.teachingVocab) {
        register({
          language: 'ar',
          exactText: v.text,
          speechText: v.text,
          usage: {
            screen: 'Level1LessonRunner',
            lessonId: lesson.id,
            activityStageId: 'stage-2-visual-see',
            exactText: v.text,
          },
        });
        if (v.secondaryText) {
          register({
            language: 'en',
            exactText: v.secondaryText,
            speechText: `${v.secondaryText}.`,
            usage: {
              screen: 'Level1LessonRunner',
              lessonId: lesson.id,
              activityStageId: 'stage-2-visual-see',
              exactText: v.secondaryText,
            },
          });
        }
      }

      // Stage 3: normal title & slow cue
      register({
        language: 'ar',
        exactText: lesson.title.ar,
        speechText: lesson.title.ar,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-3-audio-hear-normal',
          exactText: lesson.title.ar,
        },
      });
      register({
        language: 'en',
        exactText: lesson.title.en,
        speechText: lesson.title.en,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-3-audio-hear-normal',
          exactText: lesson.title.en,
        },
      });

      const slowAr = `${lesson.targetSymbol}، ${lesson.teachingVocab[0]?.text || ''}`;
      register({
        language: 'ar',
        exactText: slowAr,
        speechText: slowAr,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-3-audio-hear-slow',
          exactText: slowAr,
        },
      });
      const slowEn = `${enColor}. ${lesson.teachingVocab[0]?.secondaryText || ''}`;
      register({
        language: 'en',
        exactText: slowEn,
        speechText: slowEn,
        usage: {
          screen: 'Level1LessonRunner',
          lessonId: lesson.id,
          activityStageId: 'stage-3-audio-hear-slow',
          exactText: slowEn,
        },
      });
    }
  }

  // 7. All Level 1 Question Bank Audio Cues (750 questions)
  const lessonById = new Map(ALL_LEVEL1_LESSONS.map((l) => [l.id, l]));
  for (const q of LEVEL1_QUESTION_BANK) {
    if (!q.audioText) continue;
    const lang: AcademyAudioLang = q.audioLang === 'en' ? 'en' : 'ar';
    const lesson = lessonById.get(q.lessonId);
    let speechText = q.audioText;

    if (q.subject === 'arabic' && lesson) {
      const arMeta = AR_LETTER_BY_CHAR.get(lesson.targetSymbol);
      const letterSpoken = arMeta?.nameAr || lesson.targetSymbol;
      if (q.qType === 'visual-id') {
        speechText = `اختر حرف ${letterSpoken}`;
      } else if (q.qType === 'audio-id') {
        speechText = lesson.title.ar.replace(`(${lesson.targetSymbol})`, '');
      } else if (q.qType === 'initial-sound') {
        speechText = q.audioText.replace(`بحرف ${lesson.targetSymbol}`, `بحرف ${letterSpoken}`);
      } else if (q.qType === 'finder') {
        speechText = `ابحث عن حرف ${letterSpoken}`;
      } else if (q.qType === 'letter-picture') {
        speechText = `أي صورة تبدأ بحرف ${letterSpoken}؟`;
      } else if (q.qType === 'odd-one-out') {
        speechText = `اختر الحرف المختلف ${letterSpoken}`;
      } else if (q.qType === 'independent') {
        speechText = letterSpoken;
      }
    } else if (q.subject === 'english' && lesson) {
      if (q.qType === 'visual-id') {
        speechText = `Find letter ${lesson.targetSymbol}.`;
      } else if (
        q.qType === 'audio-id' ||
        q.qType === 'initial-sound' ||
        q.qType === 'finder' ||
        q.qType === 'odd-one-out' ||
        q.qType === 'independent'
      ) {
        speechText = `Letter ${lesson.targetSymbol}.`;
      } else if (q.qType === 'letter-picture') {
        speechText = `Which picture starts with ${lesson.targetSymbol}?`;
      } else {
        speechText = `${q.audioText}.`;
      }
    } else if (q.subject === 'numbers' && lesson) {
      const val = lesson.numberValue ?? 0;
      const arWord = AR_NUMBER_WORDS[val] || String(val);
      const enWord = EN_NUMBER_WORDS[val] || String(val);
      if (lang === 'ar') {
        if (q.qType === 'letter-picture') {
          speechText = `اختر المجموعة التي تمثل ${arWord}`;
        } else if (q.qType === 'visual-id' || q.qType === 'audio-id') {
          speechText = arWord;
        }
      } else {
        speechText = enWord;
      }
    } else if (q.subject === 'colors' && lang === 'en') {
      speechText = `${q.audioText}.`;
    }

    register({
      language: lang,
      exactText: q.audioText,
      speechText,
      usage: {
        screen: 'Level1LessonRunner:Quiz',
        lessonId: q.lessonId,
        activityStageId: `stage-10-quiz-${q.id}`,
        exactText: q.audioText,
      },
    });
  }

  // 8. Deep Journey Lesson Type A: All 8 Color Journeys
  for (const col of ACADEMY_COLORS) {
    const colorData = buildColorDeepJourney(col.id);
    // Stage 1: introLine (AR & EN)
    register({
      language: 'ar',
      exactText: colorData.introLine.ar,
      speechText: `${col.name.ar}! تعال لنكتشف معاً سر هذا اللون الرائع في عالمنا!`,
      usage: {
        screen: 'DeepLessonEngine:Color',
        lessonId: `deep-color-${col.id}`,
        activityStageId: 'stage-1-intro',
        exactText: colorData.introLine.ar,
      },
    });
    register({
      language: 'en',
      exactText: colorData.introLine.en,
      speechText: `${col.name.en}! Let's discover how this wonderful color appears all around us!`,
      usage: {
        screen: 'DeepLessonEngine:Color',
        lessonId: `deep-color-${col.id}`,
        activityStageId: 'stage-1-intro',
        exactText: colorData.introLine.en,
      },
    });
    // Stage 2: realWorldExamples (AR & EN)
    for (let i = 0; i < colorData.realWorldExamples.length; i++) {
      const ex = colorData.realWorldExamples[i];
      register({
        language: 'ar',
        exactText: ex.label.ar,
        speechText: stripEmojisForSpeech(ex.label.ar),
        usage: {
          screen: 'DeepLessonEngine:Color',
          lessonId: `deep-color-${col.id}`,
          activityStageId: `stage-2-example-${i + 1}`,
          exactText: ex.label.ar,
        },
      });
      register({
        language: 'en',
        exactText: ex.label.en,
        speechText: `${stripEmojisForSpeech(ex.label.en)}.`,
        usage: {
          screen: 'DeepLessonEngine:Color',
          lessonId: `deep-color-${col.id}`,
          activityStageId: `stage-2-example-${i + 1}`,
          exactText: ex.label.en,
        },
      });
    }
  }

  // 9. Deep Journey Lesson Type B: All 28 Arabic Letter Journeys
  for (const entry of ARABIC_ALPHABET) {
    const arData = buildArabicDeepJourney(entry.id);
    // Stage 1: introLine.ar
    register({
      language: 'ar',
      exactText: arData.introLine.ar,
      speechText: `أهلاً يا بطل! هذا حرف ال${entry.nameAr}، ${entry.nameAr}`,
      usage: {
        screen: 'DeepLessonEngine:Arabic',
        lessonId: `deep-ar-${entry.id}`,
        activityStageId: 'stage-1-meet',
        exactText: arData.introLine.ar,
      },
    });
    // Stage 2: nameAr
    register({
      language: 'ar',
      exactText: arData.nameAr,
      speechText: arData.nameAr,
      usage: {
        screen: 'DeepLessonEngine:Arabic',
        lessonId: `deep-ar-${entry.id}`,
        activityStageId: 'stage-2-name',
        exactText: arData.nameAr,
      },
    });
    // Stage 2/5/6: examples
    for (let i = 0; i < arData.examples.length; i++) {
      const ex = arData.examples[i];
      register({
        language: 'ar',
        exactText: ex.word,
        speechText: ex.word,
        usage: {
          screen: 'DeepLessonEngine:Arabic',
          lessonId: `deep-ar-${entry.id}`,
          activityStageId: `stage-5-example-${i + 1}`,
          exactText: ex.word,
        },
      });
    }
    // Stage 10: readingSentences across all 3 age bands
    for (const band of ['1-2', '2-3', '3-4'] as const) {
      const rawText = arData.readingSentences[band].ar;
      const speechText =
        band === '1-2'
          ? `${entry.nameAr}، ${entry.word}`
          : band === '2-3'
            ? `أنا أرى ${entry.word}`
            : `تبدأ كلمة ${entry.word} بحرف ${entry.nameAr}، هيا ننطقه معاً!`;
      register({
        language: 'ar',
        exactText: rawText,
        speechText,
        usage: {
          screen: 'DeepLessonEngine:Arabic',
          lessonId: `deep-ar-${entry.id}`,
          activityStageId: `stage-10-reading-${band}`,
          exactText: rawText,
        },
      });
    }
  }

  // 10. Deep Journey Lesson Type C: All 26 English Letter Journeys
  for (const entry of ENGLISH_ALPHABET) {
    const enData = buildEnglishDeepJourney(entry.id);
    register({
      language: 'en',
      exactText: enData.word,
      speechText: `${enData.word}.`,
      usage: {
        screen: 'DeepLessonEngine:English',
        lessonId: `deep-en-${entry.id}`,
        activityStageId: 'stage-5-9-word',
        exactText: enData.word,
      },
    });
    for (const band of ['1-2', '2-3', '3-4'] as const) {
      const rawText = enData.readingSentence[band].en;
      const speechText =
        band === '3-4'
          ? `Sound out the playful word: ${enData.cvcWord.charAt(0).toUpperCase() + enData.cvcWord.slice(1).toLowerCase()}.`
          : rawText;
      register({
        language: 'en',
        exactText: rawText,
        speechText,
        usage: {
          screen: 'DeepLessonEngine:English',
          lessonId: `deep-en-${entry.id}`,
          activityStageId: `stage-10-reading-${band}`,
          exactText: rawText,
        },
      });
    }
  }

  // 11. Deep Journey Lesson Type D: All 3 Math Unit Journeys
  for (const unit of MATH_DEEP_UNITS) {
    register({
      language: 'ar',
      exactText: unit.explanation.ar,
      speechText: unit.explanation.ar,
      usage: {
        screen: 'DeepLessonEngine:Math',
        lessonId: unit.id,
        activityStageId: 'stage-1-concept',
        exactText: unit.explanation.ar,
      },
    });
    register({
      language: 'en',
      exactText: unit.explanation.en,
      speechText: unit.explanation.en,
      usage: {
        screen: 'DeepLessonEngine:Math',
        lessonId: unit.id,
        activityStageId: 'stage-1-concept',
        exactText: unit.explanation.en,
      },
    });
  }

  return Array.from(bySpeechKey.values());
}

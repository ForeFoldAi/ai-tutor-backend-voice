import { Injectable, Logger } from "@nestjs/common";
import { config } from "../../config";
import { voiceLog } from "../../common/logger";
import { floatToInt16, packPcm, PCM_SAMPLE_RATE, resample } from "../../audio/pcm";
import { TtsProvider } from "./providers/tts.provider";
import { FillerCategory } from "./quick-affect";

/**
 * Short spoken acknowledgements played while a slow turn is still working.
 *
 * Purely a perceived-latency device: the clip never becomes an assistant
 * message, never reaches RAG/LLM context, and never emits a transcript.
 */

export type FillerIntent = FillerCategory;

export const FILLER_PHRASES: Record<FillerIntent, readonly string[]> = {
  question: ["Let me look at that.", "Here's the idea.", "Looking at this."],
  followup: ["Sure, let me explain that.", "Okay, let's look at this again."],
  evaluate: ["Let me check that.", "One moment — let me see."],
  confused: ["That's okay — one sec.", "No worries, let me try again."],
  frustrated: ["I hear you — give me a moment.", "Let's slow down together."],
  bored: ["Fair enough — let me switch it up.", "Got it, let's make this fun."],
  excited: ["Love that energy — one moment.", "Nice — let's see."],
  personal: ["Oh nice — let me connect that.", "Good example — one sec."],
  affirmation: ["Nice — building on that.", "Great, let's keep going."],
  closing: [],
  general: ["One moment.", "Let me think.", "Okay."],
};

/** Every distinct phrase, for cache warming. */
export function allFillerPhrases(): string[] {
  return [...new Set(Object.values(FILLER_PHRASES).flat())];
}

/** A ready-to-send wire frame — same format every answer chunk uses. */
export type FillerClip = { phrase: string; frame: Buffer; durationMs: number };

/** Next phrase in rotation. Never returns `lastIndex`, so nothing repeats back to back. */
export function pickPhraseIndex(count: number, lastIndex: number): number {
  if (count <= 0) return -1;
  return (((lastIndex + 1) % count) + count) % count;
}

function hashUtterance(text: string): number {
  let h = 0;
  const s = text.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Seed phrase choice from what the student said; avoid back-to-back repeats. */
export function pickPhraseForTurn(count: number, lastIndex: number, utterance: string): number {
  if (count <= 0) return -1;
  if (count === 1) return 0;
  const seeded = hashUtterance(utterance) % count;
  if (seeded !== lastIndex) return seeded;
  return pickPhraseIndex(count, lastIndex);
}

export function clipDurationMs(sampleCount: number, sampleRate = PCM_SAMPLE_RATE): number {
  return Math.round((sampleCount / sampleRate) * 1000);
}

export function fillerAllowed(opts: { enabled: boolean; used: number; max: number }): boolean {
  return opts.enabled && opts.used < opts.max;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function shouldArmFiller(
  recentTtfaMs: number[],
  delayMs: number,
  minSamples = 3,
): boolean {
  if (recentTtfaMs.length < minSamples) return true;
  return median(recentTtfaMs) > delayMs;
}

export function inFillerCohort(studentId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  let h = 2166136261;
  for (let i = 0; i < studentId.length; i++) {
    h ^= studentId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1000 < rate * 1000;
}

type SessionState = { lastIndex: Partial<Record<FillerIntent, number>>; used: number };

@Injectable()
export class ThinkingFillerService {
  private readonly log = new Logger(ThinkingFillerService.name);
  private readonly cache = new Map<string, FillerClip>();
  private readonly state = new Map<string, SessionState>();
  private warming: Promise<void> | null = null;
  private warmedKey = "";

  constructor(private readonly tts: TtsProvider) {}

  private voiceKey(): string {
    const voice = config.ttsProvider === "edge" ? config.edgeTtsVoice : config.kokoroVoice;
    return `${config.ttsProvider}:${voice}`;
  }

  warm(accessToken: string): void {
    if (!config.thinkingFiller) return;
    const key = this.voiceKey();
    if (this.warmedKey === key || this.warming) return;
    this.warming = this.warmAll(accessToken, key)
      .then(() => {
        this.warmedKey = key;
      })
      .catch((err) => {
        this.log.warn(`filler warm failed: ${err}`);
      })
      .finally(() => {
        this.warming = null;
      });
  }

  private async warmAll(accessToken: string, key: string): Promise<void> {
    const t0 = Date.now();
    let cached = 0;
    for (const phrase of allFillerPhrases()) {
      try {
        const clip = await this.synthesize(phrase, accessToken);
        if (!clip) continue;
        this.cache.set(`${key}:${phrase}`, clip);
        cached += 1;
      } catch (err) {
        this.log.warn(`filler synth "${phrase}": ${err}`);
      }
    }
    voiceLog("filler_cache_warmed", { fillerCached: cached, fillerMs: Date.now() - t0 });
  }

  private async synthesize(phrase: string, accessToken: string): Promise<FillerClip | null> {
    const { pcm, sampleRate } = await this.tts.synthesize(phrase, accessToken);
    if (!pcm.length) return null;
    const at16 = resample(pcm, sampleRate, PCM_SAMPLE_RATE);
    const durationMs = clipDurationMs(at16.length);
    if (durationMs > config.fillerMaxDurationMs) {
      this.log.warn(`filler "${phrase}" is ${durationMs}ms, over the cap — dropped`);
      return null;
    }
    return { phrase, durationMs, frame: packPcm(floatToInt16(at16), PCM_SAMPLE_RATE, false) };
  }

  enabledFor(studentId: string): boolean {
    return config.thinkingFiller && inFillerCohort(studentId, config.fillerSampleRate);
  }

  shouldArm(recentTtfaMs: number[]): boolean {
    if (!config.fillerAdaptive) return true;
    return shouldArmFiller(recentTtfaMs, config.fillerDelayMs);
  }

  take(sessionId: string, intent: FillerIntent = "general", utterance = ""): FillerClip | null {
    const phrases = FILLER_PHRASES[intent] ?? FILLER_PHRASES.general;
    if (!phrases.length) return null;
    const st = this.state.get(sessionId) ?? { lastIndex: {}, used: 0 };
    if (
      !fillerAllowed({
        enabled: config.thinkingFiller,
        used: st.used,
        max: config.fillerMaxPerSession,
      })
    ) {
      return null;
    }
    const key = this.voiceKey();
    const last = st.lastIndex[intent] ?? -1;
    const start = pickPhraseForTurn(phrases.length, last, utterance);
    for (let i = 0; i < phrases.length; i++) {
      const idx = (start + i) % phrases.length;
      if (idx === last && phrases.length > 1) continue;
      const clip = this.cache.get(`${key}:${phrases[idx]}`);
      if (!clip) continue;
      this.state.set(sessionId, {
        lastIndex: { ...st.lastIndex, [intent]: idx },
        used: st.used + 1,
      });
      return clip;
    }
    return null;
  }

  release(sessionId: string): void {
    this.state.delete(sessionId);
  }
}

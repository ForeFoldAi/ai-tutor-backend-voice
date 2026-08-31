import { Injectable, Logger } from "@nestjs/common";
import { config } from "../../config";
import { voiceLog } from "../../common/logger";
import { floatToInt16, packPcm, PCM_SAMPLE_RATE, resample } from "../../audio/pcm";
import { TtsProvider } from "./providers/tts.provider";

/**
 * Short spoken acknowledgements played while a slow turn is still working.
 *
 * Purely a perceived-latency device: the clip never becomes an assistant
 * message, never reaches RAG/LLM context, and never emits a transcript.
 *
 * Synthesis goes through TtsProvider (not Kokoro directly) so the filler uses
 * whatever voice the tutor is actually speaking with — with TTS_PROVIDER=edge
 * that is en-IN, and a Kokoro-only cache would switch accent mid-turn.
 *
 * ponytail: the cache cannot be warmed in onModuleInit because Edge TTS is a
 * call into FastAPI's /auth/voice-tts-pcm, which requires a student JWT that
 * does not exist at boot. It is warmed from the first session instead, so the
 * first turn after a restart may skip the filler (logged as no_clip).
 * Upgrade path: pre-generate the frames offline and load them at startup.
 */

/** Which acknowledgement fits the turn. Derived from intent the tutor already computed. */
export type FillerIntent = "question" | "followup" | "evaluate" | "general";

export const FILLER_PHRASES: Record<FillerIntent, readonly string[]> = {
  question: ["Good question.", "Good one. Let me check."],
  followup: ["Sure, let me explain that.", "Okay, let's look at this again."],
  evaluate: ["Let me see.", "Let me check your answer."],
  general: ["Let me think about that.", "Right, let's break it down."],
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

/**
 * Phase 2 adaptive gating.
 *
 * The delay itself does not need tuning — a filler is already cancelled the
 * instant the answer's first frame ships, so an early timer is self-correcting.
 * What is worth adapting is whether to arm at all: a session whose answers
 * reliably beat the delay only ever produces near-misses, so stop trying.
 */
export function shouldArmFiller(
  recentTtfaMs: number[],
  delayMs: number,
  minSamples = 3,
): boolean {
  if (recentTtfaMs.length < minSamples) return true;
  return median(recentTtfaMs) > delayMs;
}

/**
 * Stable per-student A/B split, so "did the filler help?" can be answered by
 * comparing ttfaMs across cohorts. A student never flips mid-session.
 */
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

  /** Cache identity: re-synthesizes if the engine or voice is switched. */
  private voiceKey(): string {
    const voice = config.ttsProvider === "edge" ? config.edgeTtsVoice : config.kokoroVoice;
    return `${config.ttsProvider}:${voice}`;
  }

  /**
   * Fire-and-forget from session create. Safe to call repeatedly: it warms
   * once per voice, and a failed attempt is retried by the next session.
   */
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
    // Dropped rather than truncated — a clipped word sounds like a bug.
    if (durationMs > config.fillerMaxDurationMs) {
      this.log.warn(`filler "${phrase}" is ${durationMs}ms, over the cap — dropped`);
      return null;
    }
    return { phrase, durationMs, frame: packPcm(floatToInt16(at16), PCM_SAMPLE_RATE, false) };
  }

  /** True when this student is in the cohort that hears fillers at all. */
  enabledFor(studentId: string): boolean {
    return config.thinkingFiller && inFillerCohort(studentId, config.fillerSampleRate);
  }

  /** Phase 2: skip arming for sessions whose answers reliably beat the delay. */
  shouldArm(recentTtfaMs: number[]): boolean {
    if (!config.fillerAdaptive) return true;
    return shouldArmFiller(recentTtfaMs, config.fillerDelayMs);
  }

  /**
   * Next clip for this session, or null when disabled, capped, or not cached.
   * Counts against the session cap only when a clip is actually handed out.
   */
  take(sessionId: string, intent: FillerIntent = "general"): FillerClip | null {
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
    const phrases = FILLER_PHRASES[intent] ?? FILLER_PHRASES.general;
    const key = this.voiceKey();
    const last = st.lastIndex[intent] ?? -1;
    // Walk forward from the rotation position so a partially warmed cache
    // still speaks instead of falling back to silence.
    for (let i = 0; i < phrases.length; i++) {
      const idx = pickPhraseIndex(phrases.length, last + i);
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

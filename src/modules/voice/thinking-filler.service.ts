import { Injectable, Logger } from "@nestjs/common";
import { config } from "../../config";
import { voiceLog } from "../../common/logger";
import { floatToInt16, packPcm, PCM_SAMPLE_RATE, resample } from "../../audio/pcm";
import { LlmClient } from "../llm/llm.client";
import { TtsProvider } from "./providers/tts.provider";
import { FillerCategory } from "./quick-affect";
import {
  FillerPlan,
  fillerSystemPrompt,
  sanitizeLlmFillerPhrase,
} from "./filler-mode";

/**
 * Short spoken acknowledgements played while a slow turn is still working.
 *
 * Prefer a tiny parallel LLM line matched to the student prompt; fall back to
 * canned clips. Never becomes an assistant message / transcript / RAG context.
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

/** Prepared for a turn; budget is charged only when `markUsed` runs on play. */
export type PreparedFiller = {
  clip: FillerClip;
  intent: FillerIntent;
  /** Canned rotation index; -1 for LLM phrases. */
  index: number;
};

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

  constructor(
    private readonly tts: TtsProvider,
    private readonly llm: LlmClient,
  ) {}

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

  /**
   * Pick a canned clip and record it as used. Prefer `peekCanned` + `markUsed`
   * when the clip might be discarded before playback.
   */
  take(sessionId: string, intent: FillerIntent = "general", utterance = ""): FillerClip | null {
    const picked = this.peekCanned(sessionId, intent, utterance);
    if (!picked) return null;
    this.markUsed(sessionId, intent, picked.index);
    return picked.clip;
  }

  private peekCanned(
    sessionId: string,
    intent: FillerIntent,
    utterance: string,
  ): { clip: FillerClip; index: number } | null {
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
      return { clip, index: idx };
    }
    return null;
  }

  /** Call only when the clip is actually going on the wire. */
  markUsed(sessionId: string, intent: FillerIntent, index = -1): void {
    const st = this.state.get(sessionId) ?? { lastIndex: {}, used: 0 };
    const lastIndex = { ...st.lastIndex };
    if (index >= 0) lastIndex[intent] = index;
    this.state.set(sessionId, { lastIndex, used: st.used + 1 });
  }

  /**
   * Kick off LLM+TTS immediately (parallel with the real answer). By the time
   * the arm delay fires, the clip is often ready; otherwise fall back to canned.
   * Does not consume the per-session budget until `markUsed`.
   */
  prepare(sessionId: string, plan: FillerPlan, accessToken: string): Promise<PreparedFiller | null> {
    return this.buildClip(sessionId, plan, accessToken);
  }

  private async buildClip(
    sessionId: string,
    plan: FillerPlan,
    accessToken: string,
  ): Promise<PreparedFiller | null> {
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

    let phrase = "";
    let source: "llm" | "canned" = "canned";
    if (config.llmFiller && config.llmApiKey && plan.mode !== "skip") {
      phrase = await this.llmPhrase(plan);
      if (phrase) source = "llm";
    }
    if (!phrase) {
      const canned = this.peekCanned(sessionId, plan.intent, plan.utterance);
      if (!canned) return null;
      voiceLog("filler_prepared", {
        sessionId,
        fillerPhrase: canned.clip.phrase,
        fillerMs: canned.clip.durationMs,
        fillerIntent: plan.intent,
        fillerReason: "canned",
      });
      return { clip: canned.clip, intent: plan.intent, index: canned.index };
    }

    try {
      const clip = await this.synthesize(phrase, accessToken);
      if (!clip) {
        const canned = this.peekCanned(sessionId, plan.intent, plan.utterance);
        return canned ? { clip: canned.clip, intent: plan.intent, index: canned.index } : null;
      }
      voiceLog("filler_prepared", {
        sessionId,
        fillerPhrase: clip.phrase,
        fillerMs: clip.durationMs,
        fillerIntent: plan.intent,
        fillerReason: source,
      });
      return { clip, intent: plan.intent, index: -1 };
    } catch (err) {
      this.log.warn(`llm filler synth: ${err}`);
      const canned = this.peekCanned(sessionId, plan.intent, plan.utterance);
      return canned ? { clip: canned.clip, intent: plan.intent, index: canned.index } : null;
    }
  }

  private async llmPhrase(plan: FillerPlan): Promise<string> {
    const timeoutMs = config.llmFillerTimeoutMs;
    try {
      const raw = await Promise.race([
        this.llm.complete(
          [
            { role: "system", content: fillerSystemPrompt(plan) },
            { role: "user", content: plan.utterance.slice(0, 240) },
          ],
          32,
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), timeoutMs)),
      ]);
      return sanitizeLlmFillerPhrase(raw);
    } catch (err) {
      this.log.warn(`llm filler: ${err}`);
      return "";
    }
  }

  release(sessionId: string): void {
    this.state.delete(sessionId);
  }
}

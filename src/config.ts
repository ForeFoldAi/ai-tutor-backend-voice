import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

function loadDotEnv(): void {
  for (const p of [resolve(process.cwd(), ".env"), resolve(__dirname, "../.env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m || process.env[m[1]]) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  }
}
loadDotEnv();

export function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

export function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function envBool(name: string, fallback: boolean): boolean {
  const v = env(name).toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Clamped to [0,1]. Unlike envInt, 0 is a meaningful value here. */
export function envRate(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

export const config = {
  port: envInt("PORT", 8080),
  corsOrigins: env("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  jwtSecret: env("JWT_SECRET_KEY", "change-me-in-production"),
  jwtAlg: env("JWT_ALGORITHM", "HS256"),
  redisUrl: env("REDIS_URL", "redis://localhost:6379/0"),
  redisConnectTimeoutMs: envInt("REDIS_CONNECT_TIMEOUT_MS", 5000),
  /** Remote Redis often needs >2s; local dev can lower this. */
  redisCommandTimeoutMs: envInt("REDIS_COMMAND_TIMEOUT_MS", 8000),
  databaseUrl: env("DATABASE_URL"),
  tutorApiUrl: env("TUTOR_API_URL", "http://127.0.0.1:8000").replace(/\/$/, ""),
  llmBaseUrl: env("LLM_BASE_URL", "https://api.mistral.ai/v1").replace(/\/$/, ""),
  llmApiKey: env("LLM_API_KEY") || env("MISTRAL_API_KEY"),
  llmModel: env("LLM_MODEL", "mistral-small-latest"),
  /** Orchestration LLM calls (grade, quiz, recall, summary). */
  llmTimeoutMs: envInt("LLM_TIMEOUT_MS", 10000),
  /** FastAPI RAG: max wait for the response to start (headers), and for each stream chunk after. */
  ragFirstByteTimeoutMs: envInt("RAG_FIRST_BYTE_TIMEOUT_MS", 20000),
  ragIdleTimeoutMs: envInt("RAG_IDLE_TIMEOUT_MS", 20000),
  stunUrl: env("STUN_URL", "stun:stun.l.google.com:19302"),
  turnUrl: env("TURN_URL"),
  turnUsername: env("TURN_USERNAME"),
  turnCredential: env("TURN_CREDENTIAL"),
  /** FastAPI faster-whisper round trip; on timeout the student hears MSG.sttFail. */
  sttTimeoutMs: envInt("STT_TIMEOUT_MS", 8000),
  /** Min captured speech before STT — shorter clips are usually VAD false stops. */
  sttMinUtteranceMs: envInt("STT_MIN_UTTERANCE_MS", 350),
  /** Min RMS on captured PCM — rejects silence/noise Whisper labels as (laughing). */
  sttMinSpeechRms: Number(env("STT_MIN_SPEECH_RMS", "0.008")) || 0.008,
  /** Ignore mic after tutor audio ends — speaker echo otherwise becomes a fake turn. */
  sttPostPlaybackMs: envInt("STT_POST_PLAYBACK_MS", 1000),
  /** Silence that ends a student turn. 900ms cut kids off mid-question while they thought. */
  vadHangMs: envInt("VAD_HANG_MS", 1500),
  /**
   * Speech resumed this soon after a turn ended, before any reply audio, joins that turn.
   * Counted after the VAD_HANG_MS silence, so 2500 tolerates a ~4 s mid-sentence pause; longer
   * glued a repeated or new question onto the previous one while it was still being answered.
   */
  vadMergeMs: envInt("VAD_MERGE_MS", 2500),
  /** Edge (via FastAPI) is the only TTS engine. en-IN-NeerjaNeural | en-IN-PrabhatNeural */
  edgeTtsVoice: env("EDGE_TTS_VOICE", "en-IN-NeerjaNeural"),
  /** Per attempt; one retry follows, so worst case is ~2x this before a voice_error. */
  edgeTtsTimeoutMs: envInt("EDGE_TTS_TIMEOUT_MS", 8000),
  /** Shared secret with FastAPI VOICE_INTERNAL_TOKEN — STT/TTS without a student JWT. */
  voiceInternalToken: env("VOICE_INTERNAL_TOKEN"),
  /** Short cached "let me think" audio played while a slow turn is still working. */
  thinkingFiller: envBool("VOICE_THINKING_FILLER", true),
  fillerDelayMs: envInt("VOICE_FILLER_DELAY_MS", 700),
  fillerMaxDurationMs: envInt("VOICE_FILLER_MAX_DURATION_MS", 2500),
  fillerMaxPerSession: envInt("VOICE_FILLER_MAX_PER_SESSION", 20),
  fillerMaxHandoffMs: envInt("VOICE_FILLER_MAX_HANDOFF_MS", 300),
  /** Stop arming for sessions whose answers reliably beat fillerDelayMs. */
  fillerAdaptive: envBool("VOICE_FILLER_ADAPTIVE", true),
  /** Fraction of students who hear fillers, for measuring the effect. 1 = everyone. */
  fillerSampleRate: envRate("VOICE_FILLER_SAMPLE_RATE", 1),
  /**
   * Parallel tiny LLM line matched to the student prompt; falls back to canned.
   * Off by default: it is one extra LLM call per turn that hits provider rate limits (429)
   * and competes with the actual answer for the same quota.
   */
  llmFiller: envBool("VOICE_LLM_FILLER", false),
  /** Must finish before/around fillerDelayMs or we use the canned clip. */
  llmFillerTimeoutMs: envInt("VOICE_LLM_FILLER_TIMEOUT_MS", 900),
  /** When true, LLM asks check-ins naturally instead of scripted quiz append. */
  naturalCheckins: envBool("VOICE_NATURAL_CHECKINS", false),
  /** Speak each sentence as the LLM writes it instead of waiting for the full answer. */
  streamTts: envBool("VOICE_STREAM_TTS", true),
  streamFirstChunkChars: envInt("VOICE_STREAM_FIRST_CHUNK_CHARS", 40),
  streamChunkChars: envInt("VOICE_STREAM_CHUNK_CHARS", 80),
  sessionTtlSec: envInt("SESSION_TTL_SEC", 1800),
  transcriptRetentionSec: envInt("TRANSCRIPT_RETENTION_SEC", 86400),
  rateLimitPerMin: envInt("RATE_LIMIT_PER_MIN", 30),
  adminSecret: env("ADMIN_SECRET"),
  instanceId: env("INSTANCE_ID") || env("HOSTNAME"),
};

export function iceServers(): { urls: string; username?: string; credential?: string }[] {
  const servers: { urls: string; username?: string; credential?: string }[] = [{ urls: config.stunUrl }];
  if (config.turnUrl && config.turnUsername && config.turnCredential) {
    servers.push({
      urls: config.turnUrl,
      username: config.turnUsername,
      credential: config.turnCredential,
    });
  }
  return servers;
}

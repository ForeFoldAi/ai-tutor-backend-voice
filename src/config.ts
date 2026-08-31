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
  databaseUrl: env("DATABASE_URL"),
  tutorApiUrl: env("TUTOR_API_URL", "http://127.0.0.1:8000").replace(/\/$/, ""),
  llmBaseUrl: env("LLM_BASE_URL", "https://api.mistral.ai/v1").replace(/\/$/, ""),
  llmApiKey: env("LLM_API_KEY") || env("MISTRAL_API_KEY"),
  llmModel: env("LLM_MODEL", "mistral-small-latest"),
  stunUrl: env("STUN_URL", "stun:stun.l.google.com:19302"),
  turnUrl: env("TURN_URL"),
  turnUsername: env("TURN_USERNAME"),
  turnCredential: env("TURN_CREDENTIAL"),
  whisperModel: env("WHISPER_MODEL", "Xenova/whisper-tiny.en"),
  /** kokoro (local, en-US/en-GB) | edge (Microsoft, has en-IN voices) */
  ttsProvider: env("TTS_PROVIDER", "kokoro").toLowerCase(),
  kokoroVoice: env("KOKORO_VOICE", "af_heart"),
  kokoroDtype: env("KOKORO_DTYPE", "q8"),
  edgeTtsVoice: env("EDGE_TTS_VOICE", "en-IN-NeerjaNeural"),
  edgeTtsRate: env("EDGE_TTS_RATE", "+0%"),
  edgeTtsTimeoutMs: envInt("EDGE_TTS_TIMEOUT_MS", 15000),
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

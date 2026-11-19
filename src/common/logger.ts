import { Logger } from "@nestjs/common";

const log = new Logger("voice");

export type VoiceLog = {
  conversationId?: string;
  studentId?: string;
  sessionId?: string;
  classLevel?: string;
  subject?: string;
  sttMs?: number;
  ragMs?: number;
  llmMs?: number;
  ttsMs?: number;
  totalMs?: number;
  retrievedIds?: string[];
  retrievedPages?: number[];
  tutorAction?: string;
  questionType?: string;
  evaluation?: string;
  fillerPhrase?: string;
  fillerMs?: number;
  fillerReason?: string;
  fillerCached?: number;
  fillerIntent?: string;
  /** A/B arm: false means this student never hears fillers. */
  fillerCohort?: boolean;
  /** Time from turn start to the first answer frame — the perceived latency. */
  ttfaMs?: number;
  /** Whether the answer was spoken sentence-by-sentence as it was generated. */
  streamed?: boolean;
  isRecall?: boolean;
  retrievalRewrote?: boolean;
  synthetic?: boolean;
  /** Voiced audio in a dropped utterance (VAD frames, hang excluded). */
  voicedMs?: number;
  /** Mean Whisper avg_logprob of a dropped transcript. */
  sttConfidence?: number;
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
};

/**
 * Structured voice telemetry. Never includes transcripts/audio.
 * Optionally ships latency counters to FastAPI monitoring (fail-open).
 */
export function voiceLog(event: string, fields: VoiceLog): void {
  // Never forward conversation/audio payloads if callers attach extras.
  const unsafe = fields as VoiceLog & Record<string, unknown>;
  const {
    transcript: _transcript,
    audio: _audio,
    pcm: _pcm,
    recording: _recording,
    ...safe
  } = unsafe;
  void _transcript;
  void _audio;
  void _pcm;
  void _recording;
  log.log({ event, ...safe });
  void shipVoiceMetrics(event, safe);
}

async function shipVoiceMetrics(event: string, fields: VoiceLog): Promise<void> {
  const enabled = (process.env.MONITORING_ENABLED || "").toLowerCase();
  if (enabled !== "1" && enabled !== "true" && enabled !== "yes") return;
  const tutorApi = (process.env.TUTOR_API_URL || "").replace(/\/$/, "");
  const token = process.env.MONITORING_INGEST_TOKEN || process.env.VOICE_INTERNAL_TOKEN || "";
  if (!tutorApi || !token) return;
  try {
    await fetch(`${tutorApi}/auth/admin/monitoring/ingest/voice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Monitoring-Token": token,
        "X-Voice-Token": token,
      },
      body: JSON.stringify({
        event,
        session_id: fields.sessionId,
        student_id: fields.studentId,
        stt_ms: fields.sttMs,
        tts_ms: fields.ttsMs,
        rag_ms: fields.ragMs,
        ttfa_ms: fields.ttfaMs,
        total_ms: fields.totalMs,
        error: fields.error,
        model: fields.model,
        prompt_tokens: fields.promptTokens,
        completion_tokens: fields.completionTokens,
      }),
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    // Fail-open: monitoring must never break voice turns.
  }
}

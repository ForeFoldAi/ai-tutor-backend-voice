import { Injectable } from "@nestjs/common";
import { config } from "../../../config";
import { int16ToWav, PCM_SAMPLE_RATE } from "../../../audio/pcm";
import { ISTTProvider, SttHints } from "../interfaces/voice-provider";

/**
 * Whisper STT, by way of FastAPI's faster-whisper (CTranslate2 int8).
 *
 * Not in-process: transformers.js runs ONNX synchronously on the Node main
 * thread (stalling every session's VAD and audio) and cannot take a
 * vocabulary prompt. faster-whisper is several times faster on CPU and the
 * chapter-aware initial prompt is what fixes "joint family" -> "your own family".
 */
@Injectable()
export class WhisperSttProvider implements ISTTProvider {
  async transcribe(pcm: Int16Array, hints: SttHints = {}): Promise<string> {
    const headers: Record<string, string> = {};
    if (config.voiceInternalToken) headers["X-Voice-Token"] = config.voiceInternalToken;
    else if (hints.token) headers.Authorization = `Bearer ${hints.token}`;
    else throw new Error("stt needs VOICE_INTERNAL_TOKEN or a student access token");

    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(int16ToWav(pcm, PCM_SAMPLE_RATE))], { type: "audio/wav" }), "utt.wav");
    form.append("language", "en");
    if (hints.subject) form.append("subject_name", hints.subject);
    if (hints.prompt) form.append("prompt", hints.prompt);

    const res = await fetch(`${config.tutorApiUrl}/auth/voice-transcribe`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(config.sttTimeoutMs),
    });
    if (!res.ok) throw new Error(`stt http ${res.status}`);
    const body = (await res.json()) as { transcript?: string };
    return String(body.transcript || "").trim();
  }
}

export type VoiceSessionHandle = { id: string };

export interface IVoiceProvider {
  startSession(): Promise<VoiceSessionHandle>;
  stopSession(): Promise<void>;
  interrupt(): Promise<void>;
}

export type SttHints = {
  /** Student JWT, used only when VOICE_INTERNAL_TOKEN is unset. */
  token?: string;
  subject?: string;
  /** Lesson vocabulary (chapter / topic) to bias decoding. */
  prompt?: string;
};

export interface ISTTProvider {
  /** Mono 16 kHz PCM. */
  transcribe(pcm: Int16Array, hints?: SttHints): Promise<string>;
}

export interface ITTSProvider {
  /** `accessToken` is only used by providers that call back into FastAPI. */
  synthesize(
    text: string,
    accessToken?: string,
  ): Promise<{ pcm: Float32Array; sampleRate: number }>;
}

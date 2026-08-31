export type VoiceSessionHandle = { id: string };

export interface IVoiceProvider {
  startSession(): Promise<VoiceSessionHandle>;
  stopSession(): Promise<void>;
  interrupt(): Promise<void>;
}

export interface ISTTProvider {
  transcribe(pcm: Float32Array, sampleRate: number): Promise<string>;
}

export interface ITTSProvider {
  /** `accessToken` is only used by providers that call back into FastAPI. */
  synthesize(
    text: string,
    accessToken?: string,
  ): Promise<{ pcm: Float32Array; sampleRate: number }>;
}

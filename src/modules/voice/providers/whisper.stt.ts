import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { config } from "../../../config";
import { resample } from "../../../audio/pcm";
import { ISTTProvider } from "../interfaces/voice-provider";

@Injectable()
export class WhisperSttProvider implements ISTTProvider, OnModuleInit {
  private readonly log = new Logger(WhisperSttProvider.name);
  private pipe: ((input: unknown, opts?: unknown) => Promise<unknown>) | null = null;
  private loading: Promise<void> | null = null;

  async onModuleInit(): Promise<void> {
    this.warm().catch((err) => this.log.warn(`whisper preload: ${err}`));
  }

  private async warm(): Promise<void> {
    if (this.pipe) return;
    if (!this.loading) {
      this.loading = (async () => {
        const { pipeline } = await import("@huggingface/transformers");
        const asr = await pipeline("automatic-speech-recognition", config.whisperModel);
        this.pipe = (input: unknown, opts?: unknown) => asr(input as never, opts as never) as Promise<unknown>;
        this.log.log(`whisper ready ${config.whisperModel}`);
      })();
    }
    await this.loading;
  }

  async transcribe(pcm: Float32Array, sampleRate: number): Promise<string> {
    await this.warm();
    if (!this.pipe) throw new Error("stt unavailable");
    const audio = sampleRate === 16000 ? pcm : resample(pcm, sampleRate, 16000);
    const opts = {
      return_timestamps: false,
      chunk_length_s: 30,
      stride_length_s: 5,
      language: "english",
      task: "transcribe",
    };
    let out: unknown;
    try {
      out = await this.pipe({ array: audio, sampling_rate: 16000 }, opts);
    } catch {
      try {
        out = await this.pipe({ array: audio, sampling_rate: 16000 });
      } catch {
        out = await this.pipe(audio);
      }
    }
    if (typeof out === "string") return out.trim();
    const text = (out as { text?: string })?.text || "";
    return text.trim();
  }
}

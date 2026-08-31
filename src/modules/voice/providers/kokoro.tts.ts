import { createRequire } from "module";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { config } from "../../../config";
import { ITTSProvider } from "../interfaces/voice-provider";

const nodeRequire = createRequire(__filename);

type Kokoro = {
  generate: (
    text: string,
    opts: { voice: string },
  ) => Promise<{ audio?: Float32Array; sampling_rate?: number }>;
};

@Injectable()
export class KokoroTtsProvider implements ITTSProvider, OnModuleInit {
  private readonly log = new Logger(KokoroTtsProvider.name);
  private tts: Kokoro | null = null;
  private loading: Promise<void> | null = null;

  async onModuleInit(): Promise<void> {
    this.warm().catch((err) => this.log.warn(`kokoro preload: ${err}`));
  }

  private async warm(): Promise<void> {
    if (this.tts) return;
    if (!this.loading) {
      this.loading = (async () => {
        const { KokoroTTS } = nodeRequire("kokoro-js") as {
          KokoroTTS: { from_pretrained: (id: string, opts: object) => Promise<Kokoro> };
        };
        this.tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
          dtype: config.kokoroDtype,
          device: "cpu",
        });
        this.log.log("kokoro ready");
      })();
    }
    await this.loading;
  }

  async synthesize(text: string): Promise<{ pcm: Float32Array; sampleRate: number }> {
    await this.warm();
    if (!this.tts) throw new Error("tts unavailable");
    const spoken = text.replace(/[*#_]/g, " ").replace(/\s+/g, " ").trim();
    const audio = await this.tts.generate(spoken, { voice: config.kokoroVoice });
    return { pcm: audio.audio || new Float32Array(0), sampleRate: audio.sampling_rate || 24000 };
  }
}

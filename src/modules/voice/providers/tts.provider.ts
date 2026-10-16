import { Injectable, Logger } from "@nestjs/common";
import { ITTSProvider } from "../interfaces/voice-provider";
import { EdgeTtsProvider } from "./edge.tts";

/**
 * Edge (en-IN) is the only voice. A failed chunk is retried once; if that
 * fails too the error propagates and the student sees the text with a
 * voice_error hint. There is deliberately no fallback engine: a different
 * accent mid-answer is worse than a missing sentence.
 */
@Injectable()
export class TtsProvider implements ITTSProvider {
  private readonly log = new Logger(TtsProvider.name);

  constructor(private readonly edge: EdgeTtsProvider) {}

  async synthesize(text: string, accessToken = ""): Promise<{ pcm: Float32Array; sampleRate: number }> {
    try {
      return await this.edge.synthesize(text, accessToken);
    } catch (err) {
      if (/http 40[13]/.test(String(err))) throw err;
      this.log.warn(`edge tts failed, retrying once: ${err}`);
      await new Promise((r) => setTimeout(r, 300));
      return this.edge.synthesize(text, accessToken);
    }
  }
}

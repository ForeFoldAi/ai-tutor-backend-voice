import { Injectable, Logger } from "@nestjs/common";
import { config } from "../../../config";
import { ITTSProvider } from "../interfaces/voice-provider";
import { EdgeTtsProvider } from "./edge.tts";
import { KokoroTtsProvider } from "./kokoro.tts";

/**
 * Picks the TTS engine from TTS_PROVIDER at call time.
 *
 *   kokoro (default) — local, in-process, en-US/en-GB only
 *   edge             — Microsoft read-aloud, has en-IN voices, network call
 *
 * Edge is an unofficial endpoint, so a failure there falls back to Kokoro
 * rather than dropping the turn — the student hears a US accent instead of
 * silence. The warning says so out loud, because a silent downgrade would
 * look like "I set TTS_PROVIDER=edge and the accent never changed".
 */
@Injectable()
export class TtsProvider implements ITTSProvider {
  private readonly log = new Logger(TtsProvider.name);

  constructor(
    private readonly kokoro: KokoroTtsProvider,
    private readonly edge: EdgeTtsProvider,
  ) {}

  async synthesize(
    text: string,
    accessToken = "",
  ): Promise<{ pcm: Float32Array; sampleRate: number }> {
    if (config.ttsProvider !== "edge") return this.kokoro.synthesize(text);
    try {
      return await this.edge.synthesize(text, accessToken);
    } catch (err) {
      if (!config.ttsEdgeFallback) throw err;
      this.log.warn(`edge tts failed, falling back to kokoro (${config.kokoroVoice}): ${err}`);
      return this.kokoro.synthesize(text);
    }
  }
}

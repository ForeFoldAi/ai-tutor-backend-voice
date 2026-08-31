import { Injectable, Logger } from "@nestjs/common";
import { config } from "../../../config";
import { ITTSProvider } from "../interfaces/voice-provider";

/**
 * Indian English TTS, by way of the FastAPI backend's existing Edge TTS stack.
 *
 * Why not talk to Microsoft directly from here: the read-aloud endpoint refuses
 * every raw-PCM output format ("Unsupported Edge output format") and only emits
 * MP3/Opus, so a direct client would need an MP3 decoder in Node — there is no
 * ffmpeg on the host and nothing installed that decodes it. It also gates on a
 * Sec-MS-GEC token derived from a Chromium version string that Microsoft
 * rotates; the Python edge-tts package tracks that for us and the FastAPI side
 * already depends on it. So: POST the text, get PCM16 @16kHz back, which is
 * already this pipeline's wire format.
 *
 * Costs a localhost round trip per chunk and requires FastAPI to be up — which
 * it must be regardless, since every RAG answer goes through it.
 */
@Injectable()
export class EdgeTtsProvider implements ITTSProvider {
  private readonly log = new Logger(EdgeTtsProvider.name);

  async synthesize(
    text: string,
    token = "",
  ): Promise<{ pcm: Float32Array; sampleRate: number }> {
    const spoken = text.replace(/[*#_]/g, " ").replace(/\s+/g, " ").trim();
    if (!spoken) return { pcm: new Float32Array(0), sampleRate: 16000 };

    const res = await fetch(`${config.tutorApiUrl}/auth/voice-tts-pcm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text: spoken, voice: config.edgeTtsVoice }),
      signal: AbortSignal.timeout(config.edgeTtsTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`edge tts http ${res.status}`);
    }
    const sampleRate = Number(res.headers.get("X-Sample-Rate")) || 16000;
    const buf = Buffer.from(await res.arrayBuffer());
    return { pcm: pcmToFloat(buf), sampleRate };
  }
}

/** The endpoint returns mono signed 16-bit little-endian PCM. */
function pcmToFloat(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 0x8000;
  return out;
}

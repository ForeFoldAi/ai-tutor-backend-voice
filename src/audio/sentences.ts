/**
 * Incremental sentence splitter for streaming TTS.
 *
 * The buffered path (splitSentences in voice.service) can only run once the
 * whole answer exists. This one is fed LLM tokens as they arrive and hands back
 * chunks the moment one is worth synthesizing, so the first audio goes out
 * while the model is still writing.
 *
 * The first chunk flushes at a lower threshold on purpose: time-to-first-audio
 * is what the student perceives, and later chunks have the earlier ones playing
 * to hide their synthesis time.
 */

export const FIRST_CHUNK_MIN_CHARS = 40;
export const CHUNK_MIN_CHARS = 80;
/** Force a break in run-on text so an unpunctuated list can't stall the stream. */
export const CHUNK_MAX_CHARS = 320;

export class SentenceStream {
  private buf = "";
  private emitted = 0;

  constructor(
    private readonly firstMin: number = FIRST_CHUNK_MIN_CHARS,
    private readonly min: number = CHUNK_MIN_CHARS,
    private readonly max: number = CHUNK_MAX_CHARS,
  ) {}

  /** Feed a token; returns whichever chunks are now complete. */
  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    for (;;) {
      const threshold = this.emitted === 0 ? this.firstMin : this.min;
      const cut = this.cutPoint(threshold);
      if (cut < 0) break;
      const chunk = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (!chunk) continue;
      out.push(chunk);
      this.emitted += 1;
    }
    return out;
  }

  /** Whatever is left once the stream closes. */
  flush(): string {
    const rest = this.buf.trim();
    this.buf = "";
    if (rest) this.emitted += 1;
    return rest;
  }

  get chunkCount(): number {
    return this.emitted;
  }

  /**
   * Index to cut at: the first sentence end past `min`, or a word break once
   * the buffer runs past `max` without any punctuation.
   */
  private cutPoint(min: number): number {
    // A terminator only counts as a boundary when whitespace follows it —
    // otherwise "3." mid-number, or a sentence still being typed, splits early.
    const re = /[.!?]\s/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf)) !== null) {
      const end = m.index + 1;
      if (end >= min) return end;
    }
    if (this.buf.length >= this.max) {
      const space = this.buf.lastIndexOf(" ", this.max);
      return space > min ? space : this.max;
    }
    return -1;
  }
}

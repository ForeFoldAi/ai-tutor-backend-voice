import { Injectable, Logger } from "@nestjs/common";
import { config } from "../../config";
import { SentenceStream } from "../../audio/sentences";
import { ChatTurn, SessionScope } from "../tutor/interfaces";

export type RagResult = {
  answer: string;
  retrievedIds: string[];
  pages: number[];
  ms: number;
};

export type RagAskOptions = {
  token: string;
  query: string;
  scope: SessionScope;
  history: ChatTurn[];
  signal?: AbortSignal;
};

export type RagStreamHandlers = {
  /** Fired per speakable chunk while the model is still generating. */
  onSentence?: (sentence: string) => void;
  /**
   * Fired when FastAPI post-processes and replaces the answer it already
   * streamed. Anything emitted through onSentence before this is stale.
   */
  onReplace?: (clean: string) => void;
};

/** Same collection key FastAPI builds in POST /auth/chat */
export function collectionName(board: string, classLevel: string, subject: string): string {
  return `${board}_${classLevel}_${subject}`.replace(/ /g, "_");
}

type NdjsonEvent = {
  type?: string;
  content?: string;
  images?: { id?: string; page?: number }[];
};

@Injectable()
export class RagClient {
  private readonly log = new Logger(RagClient.name);

  /** Buffered call — unchanged behavior for callers that cannot stream. */
  async ask(opts: RagAskOptions): Promise<RagResult> {
    return this.askStream(opts, {});
  }

  /**
   * Existing FastAPI chapter RAG. Never hits /ws/voice or /voice-stream.
   *
   * The endpoint has always been NDJSON streaming; this reads it incrementally
   * instead of buffering the whole body, so TTS can start on sentence one.
   */
  async askStream(opts: RagAskOptions, handlers: RagStreamHandlers): Promise<RagResult> {
    const started = Date.now();
    const body = {
      query: opts.query,
      board: opts.scope.board,
      class_level: opts.scope.classLevel,
      subject_name: opts.scope.subject,
      chapter_ids: opts.scope.chapterIds,
      chapter: opts.scope.chapter || opts.scope.chapterNames[0] || "",
      chapter_names: opts.scope.chapterNames,
      conversation_history: opts.history.slice(-8),
      agent_mode: "ask",
      voice_mode: true,
    };
    const res = await fetch(`${config.tutorApiUrl}/auth/chat/stream`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      this.log.warn(`rag http ${res.status}`);
      throw new Error("rag failed");
    }

    let answer = "";
    const retrievedIds: string[] = [];
    const pages: number[] = [];
    const sentences = new SentenceStream(config.streamFirstChunkChars, config.streamChunkChars);

    const onLine = (line: string): void => {
      if (!line.trim()) return;
      let ev: NdjsonEvent;
      try {
        ev = JSON.parse(line) as NdjsonEvent;
      } catch {
        return; /* skip bad ndjson line */
      }
      if (ev.type === "token" && ev.content) {
        answer += ev.content;
        if (handlers.onSentence) {
          for (const chunk of sentences.push(ev.content)) handlers.onSentence(chunk);
        }
      }
      if (ev.type === "clean_answer" && ev.content) {
        answer = ev.content;
        handlers.onReplace?.(ev.content);
      }
      if (ev.type === "related_images") {
        for (const img of ev.images || []) {
          if (img.id) retrievedIds.push(String(img.id));
          if (img.page) pages.push(img.page);
        }
      }
    };

    const reader = res.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let nl = pending.indexOf("\n");
        while (nl >= 0) {
          onLine(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
          nl = pending.indexOf("\n");
        }
      }
      onLine(pending);
    } else {
      // No readable body (undici fallback): behave exactly as the old client.
      for (const line of (await res.text()).split("\n")) onLine(line);
    }

    if (handlers.onSentence) {
      const rest = sentences.flush();
      if (rest) handlers.onSentence(rest);
    }
    return { answer: answer.trim(), retrievedIds, pages, ms: Date.now() - started };
  }
}

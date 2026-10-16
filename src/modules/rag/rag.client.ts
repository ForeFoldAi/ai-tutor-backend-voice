import { Injectable, Logger } from "@nestjs/common";
import { config } from "../../config";
import { SentenceStream } from "../../audio/sentences";
import { ChatTurn, NestFollowupIntent, RagRelatedImage, RagVoiceMeta, SessionScope } from "../tutor/interfaces";

export type RagResult = {
  answer: string;
  retrievedIds: string[];
  pages: number[];
  images: RagRelatedImage[];
  ms: number;
  voiceMeta?: RagVoiceMeta;
};

export type RagAskOptions = {
  token: string;
  query: string;
  scope: SessionScope;
  history: ChatTurn[];
  signal?: AbortSignal;
  tutorState?: string;
  explainedPoints?: string[];
  quizPending?: boolean;
  quizQuestion?: string;
  quizAttempts?: number;
  nestIntent?: NestFollowupIntent;
  /** closing | ack | intro — FastAPI skips chapter RAG; LLM still replies. */
  dialogueAct?: string;
  fillerPhrasePlayed?: string;
  affectTrajectory?: string[];
  /** Ephemeral student upload ids from POST /auth/tutor/images */
  imageIds?: string[];
};

export type AssistantAskOptions = {
  token: string;
  query: string;
  agentMode: string;
  history: ChatTurn[];
  signal?: AbortSignal;
  imageIds?: string[];
};

/** FastAPI rejected the bearer token (expired / wrong secret). */
export class RagAuthError extends Error {
  constructor() {
    super("rag auth");
    this.name = "RagAuthError";
  }
}

export type RagStreamHandlers = {
  /** Fired per speakable chunk while the model is still generating. */
  onSentence?: (sentence: string) => void;
  /**
   * Fired when FastAPI post-processes and replaces the answer it already
   * streamed. Anything emitted through onSentence before this is stale.
   */
  onReplace?: (clean: string) => void;
  /** Cumulative textbook figures for this turn (fires again only when new ones arrive). */
  onRelatedImages?: (images: RagRelatedImage[]) => void;
};

/** Same collection key FastAPI builds in POST /auth/chat */
export function collectionName(board: string, classLevel: string, subject: string): string {
  return `${board}_${classLevel}_${subject}`.replace(/ /g, "_");
}

type NdjsonEvent = {
  type?: string;
  content?: string;
  images?: RagRelatedImage[];
  tutor_state?: string;
  explained_points?: string[];
  affect_summary?: string;
  affect_hint?: string;
  affect_primary?: string;
  affect_trajectory?: string[];
};

function normalizeRelatedImages(raw: unknown): RagRelatedImage[] {
  if (!Array.isArray(raw)) return [];
  const out: RagRelatedImage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const url = String(row.url || "").trim();
    if (!url) continue;
    out.push({
      url,
      caption: row.caption != null ? String(row.caption) : null,
      page: typeof row.page === "number" ? row.page : row.page != null ? Number(row.page) : null,
      textbook_upload_id: row.textbook_upload_id != null ? String(row.textbook_upload_id) : undefined,
      relevance: typeof row.relevance === "number" ? row.relevance : undefined,
      subtopic: row.subtopic != null ? String(row.subtopic) : null,
      title: row.title != null ? String(row.title) : null,
      figure_number: row.figure_number != null ? String(row.figure_number) : null,
      file_name: row.file_name != null ? String(row.file_name) : null,
      content_kind: row.content_kind != null ? String(row.content_kind) : null,
    });
  }
  return out;
}

/** Later batches add figures; they never drop ones already shown. De-duplicated by URL. */
export function mergeImages(prev: RagRelatedImage[], batch: RagRelatedImage[]): RagRelatedImage[] {
  const seen = new Set(prev.map((i) => i.url));
  return [...prev, ...batch.filter((i) => !seen.has(i.url) && seen.add(i.url))];
}

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
    const body: Record<string, unknown> = {
      query: opts.query,
      board: opts.scope.board,
      class_level: opts.scope.classLevel,
      subject_name: opts.scope.subject,
      chapter_ids: opts.scope.chapterIds,
      chapter: opts.scope.chapter || opts.scope.chapterNames[0] || "",
      chapter_names: opts.scope.chapterNames,
      conversation_history: opts.history.slice(-14),
      agent_mode: "ask",
      voice_mode: true,
    };
    if (opts.tutorState) body.tutor_state = opts.tutorState;
    if (opts.explainedPoints?.length) body.explained_points = opts.explainedPoints;
    if (opts.quizPending) body.quiz_pending = true;
    if (opts.quizQuestion) body.quiz_question = opts.quizQuestion;
    if (opts.quizAttempts) body.quiz_attempts = opts.quizAttempts;
    if (opts.nestIntent && opts.nestIntent !== "none") body.nest_intent = opts.nestIntent;
    if (opts.dialogueAct) body.dialogue_act = opts.dialogueAct;
    if (opts.fillerPhrasePlayed) body.filler_phrase_played = opts.fillerPhrasePlayed;
    if (opts.affectTrajectory?.length) body.affect_trajectory = opts.affectTrajectory;
    if (opts.imageIds?.length) body.image_ids = opts.imageIds;

    let answer = "";
    const retrievedIds: string[] = [];
    const pages: number[] = [];
    let images: RagRelatedImage[] = [];
    let voiceMeta: RagVoiceMeta | undefined;
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
        const batch = normalizeRelatedImages(ev.images);
        const merged = mergeImages(images, batch);
        if (merged.length > images.length) {
          images = merged;
          handlers.onRelatedImages?.(images);
        }
        for (const img of batch) {
          const id = img.textbook_upload_id && img.file_name ? `${img.textbook_upload_id}/${img.file_name}` : "";
          if (id) retrievedIds.push(id);
          if (img.page) pages.push(img.page);
        }
      }
      if (ev.type === "done") {
        voiceMeta = {
          tutor_state: ev.tutor_state,
          explained_points: ev.explained_points,
          affect_summary: ev.affect_summary,
          affect_hint: ev.affect_hint,
          affect_primary: ev.affect_primary,
          affect_trajectory: ev.affect_trajectory,
        };
      }
    };

    await this.streamNdjson("rag", "/auth/chat/stream", opts.token, body, opts.signal, onLine);

    if (handlers.onSentence) {
      const rest = sentences.flush();
      if (rest) handlers.onSentence(rest);
    }
    return { answer: answer.trim(), retrievedIds, pages, images, ms: Date.now() - started, voiceMeta };
  }

  /**
   * POST and feed each NDJSON line to `onLine`. Bounded twice: the response must
   * start within ragFirstByteTimeoutMs and then never stall longer than
   * ragIdleTimeoutMs, otherwise a hung FastAPI blocks the session's turn queue.
   * A timeout rejects without aborting `signal`, so callers treat it as a
   * failure to apologise for, not a barge-in to discard.
   */
  private async streamNdjson(
    label: string,
    path: string,
    token: string,
    body: unknown,
    signal: AbortSignal | undefined,
    onLine: (line: string) => void,
  ): Promise<void> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer = setTimeout(() => ctl.abort(new Error(`${label} timeout`)), config.ragFirstByteTimeoutMs);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(new Error(`${label} stalled`)), config.ragIdleTimeoutMs);
    };
    try {
      const res = await fetch(`${config.tutorApiUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) {
        this.log.warn(`${label} http ${res.status}`);
        if (res.status === 401 || res.status === 403) throw new RagAuthError();
        throw new Error(`${label} failed`);
      }
      bump();
      const reader = res.body?.getReader();
      if (!reader) {
        // No readable body (undici fallback): behave exactly as the old client.
        for (const line of (await res.text()).split("\n")) onLine(line);
        return;
      }
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bump();
        pending += decoder.decode(value, { stream: true });
        let nl = pending.indexOf("\n");
        while (nl >= 0) {
          onLine(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
          nl = pending.indexOf("\n");
        }
      }
      onLine(pending);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Same body as the Ask AI Tutor text client — no voice_mode / chapter fields.
   * POST /auth/student/assistant/chat/stream
   */
  async askAssistantStream(opts: AssistantAskOptions, handlers: RagStreamHandlers): Promise<RagResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      query: opts.query,
      conversation_history: opts.history.slice(-8).map((t) => ({
        role: t.role,
        content: t.content,
      })),
      agent_mode: opts.agentMode || "free",
    };
    if (opts.imageIds?.length) body.image_ids = opts.imageIds;

    let answer = "";
    const sentences = new SentenceStream(config.streamFirstChunkChars, config.streamChunkChars);

    const onLine = (line: string): void => {
      if (!line.trim()) return;
      let ev: NdjsonEvent;
      try {
        ev = JSON.parse(line) as NdjsonEvent;
      } catch {
        return;
      }
      if (ev.type === "token" && ev.content) {
        answer += ev.content;
        if (handlers.onSentence) {
          for (const chunk of sentences.push(ev.content)) handlers.onSentence(chunk);
        }
      }
    };

    await this.streamNdjson(
      "assistant",
      "/auth/student/assistant/chat/stream",
      opts.token,
      body,
      opts.signal,
      onLine,
    );

    if (handlers.onSentence) {
      const rest = sentences.flush();
      if (rest) handlers.onSentence(rest);
    }
    return {
      answer: answer.trim(),
      retrievedIds: [],
      pages: [],
      images: [],
      ms: Date.now() - started,
    };
  }
}

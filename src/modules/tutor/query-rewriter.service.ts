import { Injectable } from "@nestjs/common";
import { ChatTurn } from "./interfaces";
import {
  followupIntent,
  groundChapterQuery,
  isRecallQuestion,
  rewriteRetrievalQuery,
} from "./query-rewriter";
import { LlmClient } from "../llm/llm.client";

@Injectable()
export class QueryRewriterService {
  constructor(private readonly llm: LlmClient) {}

  /**
   * Retrieval-only rewrite. Never use the result as the student's spoken
   * message — VoiceService keeps the raw utterance for history + LLM.
   */
  async rewrite(current: string, history: ChatTurn[], chapterName = ""): Promise<string> {
    const q = current.trim();
    // Meta/recall must stay literal — textbook rewrite would hijack them.
    if (isRecallQuestion(q)) return q;

    // "explain this chapter" has no topical terms for the vector search to
    // match, so anchor it to the chapter title before anything else runs.
    const grounded = groundChapterQuery(q, chapterName);
    if (grounded !== q) return grounded;

    const heuristic = rewriteRetrievalQuery(q, history);
    const intent = followupIntent(q);
    if (intent !== "normal") return heuristic;
    if (heuristic !== q) return heuristic;
    if (q.split(/\s+/).length >= 8) return q;
    const prev = history.filter((t) => t.role === "user").slice(-2);
    if (prev.length < 1) return q;
    try {
      const out = await this.llm.complete(
        [
          {
            role: "system",
            content:
              "Rewrite the student's latest utterance into a standalone textbook search query. " +
              "If they are asking about the conversation itself (what they asked earlier, repeat that), " +
              "return their utterance unchanged. Return only the query.",
          },
          {
            role: "user",
            content: `Earlier: ${prev.map((p) => p.content).join(" | ")}\nLatest: ${q}`,
          },
        ],
        60,
      );
      return (out || heuristic).trim() || heuristic;
    } catch {
      return heuristic;
    }
  }
}

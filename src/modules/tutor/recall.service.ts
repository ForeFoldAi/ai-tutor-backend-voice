import { Injectable, Logger } from "@nestjs/common";
import { LlmClient } from "../llm/llm.client";
import { ChatTurn } from "./interfaces";

/**
 * Answers questions about the conversation itself from the session transcript,
 * instead of retrieving from the textbook. The history is already kept in
 * ConversationMemoryService — nothing was reading it back to the student.
 */
@Injectable()
export class RecallService {
  private readonly log = new Logger(RecallService.name);

  constructor(private readonly llm: LlmClient) {}

  async answer(question: string, history: ChatTurn[], summary = ""): Promise<string> {
    const recent = history.slice(-8);
    if (recent.length === 0) {
      return "We just started, so we haven't covered anything yet. What would you like to learn?";
    }
    const transcript = recent
      .map((t) => `${t.role === "user" ? "Student" : "Tutor"}: ${t.content}`)
      .join("\n");
    try {
      const out = await this.llm.complete(
        [
          {
            role: "system",
            content:
              "You are a tutor being asked about the conversation you are having, not about the textbook. " +
              "Answer only from the transcript. Be brief and spoken-friendly (one or two sentences). " +
              "When quoting what the student asked, quote it back closely. " +
              "If the transcript does not contain the answer, say so plainly.",
          },
          {
            role: "user",
            content:
              (summary ? `Earlier summary: ${summary}\n\n` : "") +
              `Transcript:\n${transcript}\n\nStudent now asks: ${question}`,
          },
        ],
        120,
      );
      if (out) return out;
    } catch (err) {
      this.log.warn(`recall llm failed: ${err}`);
    }
    // Deterministic fallback covers the common case without the LLM.
    const lastUser = [...recent].reverse().find((t) => t.role === "user");
    return lastUser
      ? `You asked: "${lastUser.content}"`
      : "I don't have that earlier part of our chat any more.";
  }
}

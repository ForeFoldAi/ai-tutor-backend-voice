import { Injectable } from "@nestjs/common";
import { ChatTurn } from "../tutor/interfaces";
import { LlmClient } from "../llm/llm.client";

@Injectable()
export class ConversationSummaryService {
  constructor(private readonly llm: LlmClient) {}

  async maybeFold(messages: ChatTurn[], existing: string): Promise<string> {
    if (messages.length < 10) return existing;
    const older = messages.slice(0, -6);
    try {
      return await this.llm.complete(
        [
          {
            role: "system",
            content: "Summarize this tutoring dialogue in 2 short sentences. Facts only.",
          },
          { role: "user", content: `${existing}\n${older.map((m) => `${m.role}: ${m.content}`).join("\n")}` },
        ],
        80,
      );
    } catch {
      return existing || older.map((m) => m.content).join(" ").slice(0, 400);
    }
  }
}

import { Injectable } from "@nestjs/common";
import { LlmClient } from "../llm/llm.client";
import type { ChatTurn, QuizItem, RagRelatedImage } from "./interfaces";

@Injectable()
export class QuestionGeneratorService {
  constructor(private readonly llm: LlmClient) {}

  async fromTextbook(concept: string, groundedText: string, difficulty: number): Promise<{
    question: string;
    expected: string;
  }> {
    const raw = await this.llm.complete(
      [
        {
          role: "system",
          content:
            'Write ONE short spoken check question for a Class 1–10 student from the textbook excerpt. JSON: {"question":"...","expected":"..."} Difficulty 1=very easy, 5=advanced. No markdown.',
        },
        {
          role: "user",
          content: `Difficulty ${difficulty}. Concept: ${concept}\nExcerpt:\n${groundedText.slice(0, 1200)}`,
        },
      ],
      120,
    );
    try {
      const json = JSON.parse(raw.replace(/```json|```/g, "").trim()) as {
        question?: string;
        expected?: string;
      };
      if (json.question) {
        return { question: json.question.trim(), expected: (json.expected || "").trim() };
      }
    } catch {
      /* fall through */
    }
    return {
      question: `Can I ask you a quick question? What is the most important idea about ${concept}?`,
      expected: groundedText.slice(0, 200),
    };
  }

  /**
   * Quiz built only from what the tutor said this session. [] when nothing has been taught yet.
   * A question may point at a figure only if that figure was shown this session.
   */
  async quizFromSession(transcript: ChatTurn[], summary: string, figures: RagRelatedImage[], n = 3): Promise<QuizItem[]> {
    const taught = transcript.filter((t) => t.role === "assistant" && t.content.length > 60);
    if (!taught.length && !summary.trim()) return [];
    const count = taught.length < 2 && !summary.trim() ? 1 : n;
    const talk = transcript.map((t) => `${t.role === "user" ? "Student" : "Tutor"}: ${t.content}`).join("\n");
    const figs = figures
      .map((f, i) => `${i}: ${[f.figure_number && `Figure ${f.figure_number}`, f.caption || f.title].filter(Boolean).join(" — ")}`)
      .join("\n");
    try {
      const raw = await this.llm.complete(
        [
          {
            role: "system",
            content:
              `Write ${count} short spoken quiz question(s) for a school student, using ONLY facts the Tutor actually said in this session. ` +
              "No new topics, no facts from outside the transcript, no page numbers. Do not mention a map, figure or picture unless you set figure_index to one from the list. " +
              "For math, use numbers the session worked with and give the exact final answer. " +
              'JSON only: [{"question":"...","expected":"...","figure_index":null}]',
          },
          {
            role: "user",
            content: `Earlier summary: ${summary || "(none)"}\n\nTranscript:\n${talk.slice(-4000)}\n\nFigures shown on screen:\n${figs || "(none)"}`,
          },
        ],
        400,
      );
      const rows = JSON.parse(raw.replace(/```json|```/g, "").trim()) as {
        question?: string;
        expected?: string;
        figure_index?: number | null;
      }[];
      return rows
        .filter((r) => r.question?.trim())
        .slice(0, count)
        .map((r) => ({
          question: r.question!.trim(),
          expected: (r.expected || "").trim(),
          figure: r.figure_index != null ? figures[Number(r.figure_index)] : undefined,
          attempts: 0,
          done: false,
        }));
    } catch {
      return [];
    }
  }
}

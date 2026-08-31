import { Injectable } from "@nestjs/common";
import { LlmClient } from "../llm/llm.client";

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
}

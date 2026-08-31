import { Injectable } from "@nestjs/common";
import { AnswerGrade } from "./interfaces";
import { LlmClient } from "../llm/llm.client";

const STOP = new Set(["a", "an", "the", "and", "or", "to", "of", "for", "in", "on", "is"]);

export function tokenSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

/** Overlap heuristic — LLM path is used when an expected answer exists. */
export function gradeByOverlap(expected: string, student: string): AnswerGrade {
  if (!student.trim()) return "UNCERTAIN";
  if (!expected.trim()) return "UNCERTAIN";
  const e = tokenSet(expected);
  const s = tokenSet(student);
  if (e.size === 0) return "UNCERTAIN";
  let hit = 0;
  for (const w of s) if (e.has(w)) hit++;
  const recall = hit / e.size;
  const precision = s.size ? hit / s.size : 0;
  if (recall >= 0.75 && precision >= 0.5) return "CORRECT";
  if (recall >= 0.35) return "PARTIALLY_CORRECT";
  if (hit === 0) return "INCORRECT";
  return "PARTIALLY_CORRECT";
}

@Injectable()
export class AnswerEvaluatorService {
  constructor(private readonly llm: LlmClient) {}

  async grade(expected: string, student: string, concept: string): Promise<AnswerGrade> {
    const fallback = gradeByOverlap(expected, student);
    if (!expected.trim()) return fallback;
    try {
      const raw = await this.llm.complete(
        [
          {
            role: "system",
            content:
              'Classify the student answer as CORRECT, PARTIALLY_CORRECT, INCORRECT, or UNCERTAIN. JSON only: {"grade":"..."}',
          },
          {
            role: "user",
            content: `Concept: ${concept}\nExpected: ${expected}\nStudent: ${student}`,
          },
        ],
        40,
      );
      const m = raw.match(/CORRECT|PARTIALLY_CORRECT|INCORRECT|UNCERTAIN/);
      return (m?.[0] as AnswerGrade) || fallback;
    } catch {
      return fallback;
    }
  }
}

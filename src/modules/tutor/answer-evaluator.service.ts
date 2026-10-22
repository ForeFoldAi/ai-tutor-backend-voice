import { Injectable } from "@nestjs/common";
import { AnswerGrade, QuizItem } from "./interfaces";
import { LlmClient } from "../llm/llm.client";
import type { QuizGrade, QuizOutcome } from "./tutor-orchestrator.service";

const STOP = new Set(["a", "an", "the", "and", "or", "to", "of", "for", "in", "on", "is"]);
const GRADES = /PARTIALLY_CORRECT|INCORRECT|CORRECT|UNCERTAIN/;

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

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Every number in the text, digits or spoken ("two hundred fifty six"). */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  let cur = 0;
  let total = 0;
  let inWords = false;
  const flush = () => {
    if (inWords) out.push(total + cur);
    cur = total = 0;
    inWords = false;
  };
  for (const tok of (text || "").toLowerCase().replace(/(\d),(\d)/g, "$1$2").match(/-?\d+(?:\.\d+)?|[a-z]+/g) || []) {
    if (/\d/.test(tok)) {
      flush();
      out.push(Number(tok));
    } else if (tok in UNITS) {
      cur += UNITS[tok];
      inWords = true;
    } else if (tok === "hundred" && inWords) {
      cur *= 100;
    } else if (tok === "thousand" && inWords) {
      total += cur * 1000;
      cur = 0;
    } else if (tok !== "and" || !inWords) {
      flush();
    }
  }
  flush();
  return out;
}

/**
 * Exact grade when the expected answer is a single number and the student said one.
 * null → not a numeric question; let the LLM judge.
 */
export function gradeNumeric(expected: string, student: string): AnswerGrade | null {
  const e = numbersIn(expected);
  const s = numbersIn(student);
  if (e.length !== 1 || !s.length) return null;
  return Math.abs(e[0] - s[s.length - 1]) < 1e-6 ? "CORRECT" : "INCORRECT";
}

@Injectable()
export class AnswerEvaluatorService {
  constructor(private readonly llm: LlmClient) {}

  async grade(expected: string, student: string, question: string): Promise<AnswerGrade> {
    const exact = gradeNumeric(expected, student);
    if (exact) return exact;
    const fallback = gradeByOverlap(expected, student);
    try {
      const raw = await this.llm.complete(
        [
          {
            role: "system",
            content:
              'Classify the student answer to the question as CORRECT, PARTIALLY_CORRECT, INCORRECT, or UNCERTAIN. If no expected answer is given, judge from the question itself. JSON only: {"grade":"..."}',
          },
          {
            role: "user",
            content: `Question: ${question}\nExpected: ${expected || "(not given)"}\nStudent: ${student}`,
          },
        ],
        40,
      );
      return (raw.match(GRADES)?.[0] as AnswerGrade) || fallback;
    } catch {
      return fallback;
    }
  }

  /** Grade one utterance against every open item — the student may answer one, some, or all. */
  async gradeQuiz(quiz: QuizItem[], open: number[], student: string): Promise<QuizGrade[]> {
    if (!open.length) return [];
    const first = async (): Promise<QuizGrade[]> => [
      { index: open[0], grade: await this.grade(quiz[open[0]].expected, student, quiz[open[0]].question) },
    ];
    if (open.length === 1) return first();
    try {
      const list = open
        .map((i) => `Q${i + 1}: ${quiz[i].question}\nExpected: ${quiz[i].expected || "(judge from the question)"}`)
        .join("\n");
      const raw = await this.llm.complete(
        [
          {
            role: "system",
            content:
              'A student is answering a spoken quiz. Decide which of the listed questions their reply answers (one, several, or all) and grade only those as CORRECT, PARTIALLY_CORRECT, INCORRECT or UNCERTAIN. Skip questions they did not address. JSON only: [{"q":1,"grade":"..."}]',
          },
          { role: "user", content: `${list}\n\nStudent: ${student}` },
        ],
        120,
      );
      const rows = JSON.parse(raw.replace(/```json|```/g, "").trim()) as { q?: number; grade?: string }[];
      const grades = rows.flatMap((r) => {
        const index = Number(r.q) - 1;
        const grade = String(r.grade || "").match(GRADES)?.[0] as AnswerGrade | undefined;
        return open.includes(index) && grade ? [{ index, grade }] : [];
      });
      return grades.length ? grades : first();
    } catch {
      return first();
    }
  }

  /** Spoken reaction to this turn's grades; the verdicts are fixed — the LLM only words them. */
  async quizFeedback(opts: {
    quiz: QuizItem[];
    outcomes: QuizOutcome[];
    next: number;
    student: string;
    classLevel: string;
  }): Promise<string> {
    const { quiz, outcomes, next } = opts;
    const many = quiz.length > 1;
    const label = (i: number) => (many ? `Question ${i + 1}` : "The question");
    const lines = outcomes.map((o) => {
      const q = quiz[o.index];
      const fig = q.figure ? ` Point them to ${q.figure.figure_number ? `Figure ${q.figure.figure_number}` : "the figure"} shown on screen.` : "";
      if (o.grade === "CORRECT") return `${label(o.index)} ("${q.question}"): CORRECT. Praise briefly.`;
      if (o.revealed) {
        return `${label(o.index)} ("${q.question}"): wrong again. Say the correct answer${q.expected ? ` (${q.expected})` : ""} in one line.`;
      }
      return `${label(o.index)} ("${q.question}"): not right yet, first try${q.expected ? ` (answer: ${q.expected} — do NOT say it)` : ""}. Give ONE short hint and invite another try.${fig}`;
    });
    const correct = quiz.filter((q) => q.grade === "CORRECT").length;
    // A hint already ends on "try again" — don't stack a second question on it.
    const hinted = outcomes.some((o) => !quiz[o.index].done);
    const close =
      next >= 0
        ? hinted
          ? ""
          : `Then ask ${label(next)} again: "${quiz[next].question}"`
        : many
          ? `Quiz finished: they got ${correct} of ${quiz.length}. Say the score warmly${quiz.some((q) => q.revealed) ? " and suggest revising the ones they missed" : ""}.`
          : "";
    try {
      const reply = await this.llm.complete(
        [
          {
            role: "system",
            content:
              `You are a warm teacher speaking aloud to a ${opts.classLevel || "school"} student during a quiz. ` +
              "Plain spoken sentences only, no markdown or lists, under 60 words. Use exactly the verdicts and answers given — never re-grade, never change a number, never add new facts.",
          },
          { role: "user", content: `Student said: "${opts.student}"\n${lines.join("\n")}\n${close}` },
        ],
        160,
      );
      if (reply.trim()) return reply.trim();
    } catch {
      /* fall through */
    }
    const said = outcomes.map((o) => {
      const q = quiz[o.index];
      if (o.grade === "CORRECT") return `${label(o.index)}: exactly right!`;
      if (o.revealed) return `${label(o.index)}: not quite. The answer is ${q.expected || "in what we just covered"}.`;
      return `${label(o.index)}: not quite yet. Have another go.`;
    });
    if (next >= 0 && !hinted) said.push(`Now, ${label(next).toLowerCase()}: ${quiz[next].question}`);
    if (next < 0 && many) said.push(`You got ${correct} out of ${quiz.length}.`);
    return said.join(" ");
  }
}

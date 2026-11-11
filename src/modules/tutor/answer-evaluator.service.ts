import { Injectable } from "@nestjs/common";
import { AnswerGrade, QuizItem } from "./interfaces";
import { LlmClient } from "../llm/llm.client";
import { quizScore, spokenScore } from "./tutor-orchestrator.service";
import type { QuizGrade, QuizOutcome } from "./tutor-orchestrator.service";

const STOP = new Set(["a", "an", "the", "and", "or", "to", "of", "for", "in", "on", "is"]);
const GRADES = /NOT_AN_ANSWER|PARTIALLY_CORRECT|INCORRECT|CORRECT|UNCERTAIN/;

const GRADING_RULES =
  "Grade by meaning, not wording: a paraphrase, synonym or simpler phrasing of the expected idea is CORRECT. " +
  "PARTIALLY_CORRECT when it gets part of the idea (one of several reasons, the right idea said vaguely). " +
  "INCORRECT only when it is a real attempt that is wrong. " +
  "NOT_AN_ANSWER when the student is not attempting this question at all: a statement about a different topic, " +
  "a new question, a complaint, or a request. UNCERTAIN only when the reply is too garbled to judge.";

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
              "Classify the student reply to the question as CORRECT, PARTIALLY_CORRECT, INCORRECT, NOT_AN_ANSWER or UNCERTAIN. " +
              GRADING_RULES +
              ' If no expected answer is given, judge from the question itself. JSON only: {"grade":"..."}',
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
              "A student is answering a spoken quiz. Decide which of the listed questions their reply answers (one, several, or all) and grade only those as CORRECT, PARTIALLY_CORRECT, INCORRECT or UNCERTAIN. " +
              GRADING_RULES +
              ' Skip questions they did not address. If the reply attempts none of them, return [{"q":0,"grade":"NOT_AN_ANSWER"}]. JSON only: [{"q":1,"grade":"..."}]',
          },
          { role: "user", content: `${list}\n\nStudent: ${student}` },
        ],
        120,
      );
      const rows = JSON.parse(raw.replace(/```json|```/g, "").trim()) as { q?: number; grade?: string }[];
      if (rows.length && rows.every((r) => /NOT_AN_ANSWER/.test(String(r.grade || "")))) {
        return [{ index: open[0], grade: "NOT_AN_ANSWER" }];
      }
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
    /** The tutor's last explanation — the only source a hint or an unstored answer may use. */
    lesson?: string;
  }): Promise<string> {
    const { quiz, outcomes, next } = opts;
    const many = quiz.length > 1;
    const label = (i: number) => (many ? `Question ${i + 1}` : "The question");
    const lines = outcomes.map((o) => {
      const q = quiz[o.index];
      const fig = q.figure ? ` Point them to ${q.figure.figure_number ? `Figure ${q.figure.figure_number}` : "the figure"} shown on screen.` : "";
      if (o.grade === "CORRECT") return `${label(o.index)} ("${q.question}"): CORRECT. Praise briefly.`;
      if (o.grade === "PARTIALLY_CORRECT") {
        return `${label(o.index)} ("${q.question}"): PARTLY CORRECT, counts as half. Say what they got right, then add the missing part${q.expected ? ` (full answer: ${q.expected})` : ""} in one line.`;
      }
      if (o.grade === "UNCERTAIN") {
        return `${label(o.index)} ("${q.question}"): could not make out the answer. Ask them kindly to say it again; do not count it as wrong.`;
      }
      if (o.revealed) {
        return q.expected
          ? `${label(o.index)} ("${q.question}"): wrong again. Say the correct answer (${q.expected}) in one line.`
          : `${label(o.index)} ("${q.question}"): wrong again. Give the answer in one line ONLY if the tutor's last explanation states it; otherwise do not name any answer, just say you'll go over it together.`;
      }
      return `${label(o.index)} ("${q.question}"): not right yet, first try${q.expected ? ` (answer: ${q.expected} — do NOT say it)` : ""}. Give ONE short hint taken from the tutor's last explanation and invite another try.${fig}`;
    });
    const lesson = (opts.lesson || "").trim().slice(-1200);
    const score = spokenScore(quizScore(quiz));
    // A hint already ends on "try again" — don't stack a second question on it.
    const hinted = outcomes.some((o) => !quiz[o.index].done);
    const close =
      next >= 0
        ? hinted
          ? ""
          : `Then ask ${label(next)}: "${quiz[next].question}"`
        : many
          ? `Quiz finished: they scored ${score} out of ${quiz.length}. Say the score warmly${quiz.some((q) => q.revealed) ? " and suggest revising the ones they missed" : ""}. Do not ask a new question.`
          : "";
    const messages = [
      {
        role: "system" as const,
        content:
          `You are a warm teacher speaking aloud to a ${opts.classLevel || "school"} student during a quiz. ` +
          "Plain spoken sentences only, no markdown, lists or quotation marks, under 60 words. Use exactly the verdicts and answers given — never re-grade, never change a number, never add new facts. " +
          "Never invent an answer or bring in a topic or subject that is not in the tutor's last explanation.",
      },
      {
        role: "user" as const,
        content:
          `${lesson ? `Tutor's last explanation: "${lesson}"\n` : ""}` +
          `Student said: "${opts.student}"\n${lines.join("\n")}\n${close}`,
      },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const reply = await this.llm.complete(messages, 160);
        if (reply.trim()) return cleanSpoken(reply);
      } catch (err) {
        console.warn("[quiz_feedback] llm failed", { attempt, error: (err as Error)?.message });
      }
    }
    return cleanSpoken(fallbackFeedback(quiz, outcomes, next, score));
  }
}

/** Speakable text: no quotation marks, no doubled punctuation ("idea.." → "idea."). */
export function cleanSpoken(text: string): string {
  return (text || "")
    .replace(/["“”]/g, "")
    .replace(/(^|\s)'([^']+)'(?=[\s.,!?]|$)/g, "$1$2")
    .replace(/\.{2,}/g, ".")
    .replace(/([.!?])\s*\./g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** First content word of the expected answer — a hint that doesn't give the answer away. */
function hintWord(expected: string): string {
  const words = [...tokenSet(expected)].filter((w) => w.length > 3 && !/^\d+$/.test(w));
  return words[0] || "";
}

/** Spoken without the LLM. "The question: exactly right!" sounds like a form, so only number them in a multi-question quiz. */
export function fallbackFeedback(quiz: QuizItem[], outcomes: QuizOutcome[], next: number, score: string): string {
  const many = quiz.length > 1;
  const label = (i: number) => (many ? `Question ${i + 1}` : "The question");
  const lead = (i: number) => (many ? `${label(i)}: ` : "");
  const strip = (s: string) => s.replace(/[.!?\s]+$/, "");
  const said = outcomes.map((o) => {
    const q = quiz[o.index];
    if (o.grade === "CORRECT") return `${lead(o.index)}Exactly right!`;
    if (o.grade === "PARTIALLY_CORRECT") {
      return q.expected ? `${lead(o.index)}Almost! The full answer is ${strip(q.expected)}.` : `${lead(o.index)}Almost, that's partly right!`;
    }
    if (o.grade === "UNCERTAIN") return `${lead(o.index)}Sorry, I didn't catch that. Can you say your answer again?`;
    if (o.revealed) {
      return q.expected
        ? `${lead(o.index)}Not quite. The answer is ${strip(q.expected)}.`
        : `${lead(o.index)}Not quite. Let's go over it together.`;
    }
    const hint = hintWord(q.expected);
    return hint
      ? `${lead(o.index)}Not quite yet. Here's a hint: think about ${hint}. ${q.question}`
      : `${lead(o.index)}Not quite yet. Think again about what we just learned. ${q.question}`;
  });
  const hinted = outcomes.some((o) => !quiz[o.index].done);
  if (next >= 0 && !hinted) said.push(`Now, ${label(next).toLowerCase()}: ${quiz[next].question}`);
  if (next < 0 && many) said.push(`You got ${score} out of ${quiz.length}.`);
  return said.join(" ");
}

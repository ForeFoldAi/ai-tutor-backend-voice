import { Injectable } from "@nestjs/common";
import { TutorAction, AnswerGrade, QuizItem } from "./interfaces";
import { followupIntent, isRecallQuestion } from "./query-rewriter";
import { classifyReplyIntent } from "./reply-intent";

/** Clear refusals / topic pivots while a check question is open. */
const REFUSAL_OR_PIVOT =
  /^(no|nope|nah|stop|wait|never\s*mind|not\s+that|something\s+else|different\s+topic|i\s+don'?t\s+want)\b/i;

/** "Is it 9?", "I think sixteen" — an answer phrased as a question is still an answer. */
const HEDGED_ANSWER = /^(is\s+it|it'?s|maybe|i\s+think|i\s+guess|probably)\b/i;
const NUMBER_WORD =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|half)\b/i;

export function looksLikeAnswer(utterance: string): boolean {
  const q = utterance.trim();
  if (HEDGED_ANSWER.test(q)) return true;
  if (/^(what|why|how|who|where|when|explain|define|tell|can)\b/i.test(q)) return false;
  return q.split(/\s+/).length <= 4 && (/\d/.test(q) || NUMBER_WORD.test(q));
}

export function looksLikeNewQuestion(utterance: string): boolean {
  const q = utterance.trim();
  if (!q) return false;
  if (isRecallQuestion(q)) return true;
  if (/\?$/.test(q)) return true;
  return /^(what|why|how|explain|define|who|where|when|tell\s+me|can\s+you)\b/i.test(q);
}

export function decideAction(opts: {
  utterance: string;
  awaitingAnswer: boolean;
  turnsSinceCheck: number;
  lastAssistant?: string;
}): TutorAction {
  const intent = classifyReplyIntent(opts.utterance, opts.awaitingAnswer);

  if (intent === "CLOSING") return "ANSWER";

  const fi = followupIntent(opts.utterance);
  if (fi === "simplify") return "SIMPLIFY";
  if (fi === "example") return "PROVIDE_EXAMPLE";
  if (fi === "quiz") return "START_QUIZ";

  if (opts.awaitingAnswer) {
    // "I don't know" uses up an attempt on the open question (hint, then reveal).
    if (intent === "DONT_KNOW") return "EVALUATE";
    if (!isRecallQuestion(opts.utterance) && looksLikeAnswer(opts.utterance)) return "EVALUATE";
    if (looksLikeNewQuestion(opts.utterance)) return "EXPLAIN";
    if (REFUSAL_OR_PIVOT.test(opts.utterance.trim())) return "ANSWER";
    if (intent === "WRONG_ANSWER") return "EVALUATE";
    if (intent === "UNCLEAR") return "REQUEST_CLARIFICATION";
    return "EVALUATE";
  }

  if (intent === "DONT_KNOW") return "SIMPLIFY";

  if (looksLikeNewQuestion(opts.utterance)) return "EXPLAIN";
  return "ANSWER";
}

export function afterExplainShouldCheck(
  snap: { awaitingAnswer: boolean; turnsSinceCheck: number },
  assistantText: string,
  action?: TutorAction,
): boolean {
  // A recall answer ("you asked X") is not a taught concept — never
  // follow it with a comprehension check.
  if (action === "EXPLAIN" || action === "RECALL") return false;
  if (snap.awaitingAnswer) return false;
  if (assistantText.trim().endsWith("?")) return false;
  return snap.turnsSinceCheck >= 2 && assistantText.length > 80;
}

export function afterEvaluate(grade: AnswerGrade): TutorAction {
  if (grade === "CORRECT") return "CONTINUE_LESSON";
  if (grade === "PARTIALLY_CORRECT") return "GIVE_HINT";
  if (grade === "INCORRECT") return "SIMPLIFY";
  return "REQUEST_CLARIFICATION";
}

export type QuizGrade = { index: number; grade: AnswerGrade };
export type QuizOutcome = QuizGrade & { revealed: boolean };

export function openQuizIndexes(quiz: QuizItem[]): number[] {
  return quiz.flatMap((q, i) => (q.done ? [] : [i]));
}

/**
 * Apply this turn's grades. Correct closes an item; a miss uses an attempt and
 * the second miss reveals the answer. Items the student didn't address stay open.
 * `next` is the lowest-numbered open item, or -1 when the quiz is finished.
 */
export function applyQuizGrades(
  quiz: QuizItem[],
  grades: QuizGrade[],
): { quiz: QuizItem[]; outcomes: QuizOutcome[]; next: number } {
  const out = quiz.map((q) => ({ ...q }));
  const outcomes: QuizOutcome[] = [];
  for (const { index, grade } of grades) {
    const item = out[index];
    if (!item || item.done) continue;
    item.grade = grade;
    if (grade === "CORRECT") {
      item.done = true;
    } else {
      item.attempts += 1;
      if (item.attempts >= 2) item.done = item.revealed = true;
    }
    outcomes.push({ index, grade, revealed: !!item.revealed });
  }
  const next = out.findIndex((q) => !q.done);
  return { quiz: out, outcomes, next };
}

@Injectable()
export class TutorOrchestratorService {
  decide = decideAction;
  shouldCheck = afterExplainShouldCheck;
  afterEvaluate = afterEvaluate;
}

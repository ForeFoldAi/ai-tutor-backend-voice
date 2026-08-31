import { Injectable } from "@nestjs/common";
import { TutorAction, TutorSnapshot } from "./interfaces";
import { followupIntent, isRecallQuestion } from "./query-rewriter";
import { AnswerGrade } from "./interfaces";

/** Clear refusals / topic pivots while a check question is open. */
const REFUSAL_OR_PIVOT =
  /^(no|nope|nah|stop|wait|never\s*mind|not\s+that|something\s+else|different\s+topic|i\s+don'?t\s+want)\b/i;

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
  grade?: AnswerGrade;
  turnsSinceCheck: number;
  lastAssistant?: string;
}): TutorAction {
  const intent = followupIntent(opts.utterance);
  if (intent === "simplify") return "SIMPLIFY";
  if (intent === "example") return "PROVIDE_EXAMPLE";
  if (intent === "quiz") return "START_QUIZ";
  if (opts.awaitingAnswer) {
    // Don't grade a new question, recall, or clear refusal as the quiz answer.
    if (looksLikeNewQuestion(opts.utterance) || REFUSAL_OR_PIVOT.test(opts.utterance.trim())) {
      if (looksLikeNewQuestion(opts.utterance)) return "EXPLAIN";
      return "ANSWER";
    }
    return "EVALUATE";
  }
  if (looksLikeNewQuestion(opts.utterance)) return "EXPLAIN";
  return "ANSWER";
}

export function afterExplainShouldCheck(
  snap: TutorSnapshot,
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

@Injectable()
export class TutorOrchestratorService {
  decide = decideAction;
  shouldCheck = afterExplainShouldCheck;
  afterEvaluate = afterEvaluate;
}

import { Injectable } from "@nestjs/common";
import { TutorAction, AnswerGrade } from "./interfaces";
import { followupIntent, isRecallQuestion } from "./query-rewriter";
import { classifyReplyIntent } from "./reply-intent";

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
    if (intent === "DONT_KNOW") return "SIMPLIFY";
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

@Injectable()
export class TutorOrchestratorService {
  decide = decideAction;
  shouldCheck = afterExplainShouldCheck;
  afterEvaluate = afterEvaluate;
}

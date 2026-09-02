import { NestFollowupIntent } from "../tutor/interfaces";
import { AFFIRM_RE, CLOSING_RE, CONFUSION_RE } from "../tutor/reply-intent";

export type QuickAffectPrimary =
  | "confused"
  | "frustrated"
  | "bored"
  | "excited"
  | "curious"
  | "affirmation"
  | "personal"
  | "closing"
  | "neutral";

export type QuickAffectResult = {
  primary: QuickAffectPrimary;
  fillerCategory: FillerCategory;
  confidence: number;
  skipFiller: boolean;
};

export type FillerCategory =
  | "question"
  | "followup"
  | "evaluate"
  | "confused"
  | "frustrated"
  | "bored"
  | "excited"
  | "personal"
  | "affirmation"
  | "closing"
  | "general";

const FRUSTRATION_RE =
  /\b(frustrat|annoyed|fed\s+up|give\s+up|stupid|hate\s+this|this\s+sucks|can'?t\s+do\s+this|so\s+hard|impossible)\b/i;
const BOREDOM_RE =
  /\b(bor(?:ed|ing)|tired\s+of|something\s+else|don'?t\s+care|whatever|skip\s+this|move\s+on)\b/i;
const EXCITEMENT_RE =
  /\b(wow|amazing|awesome|cool|love\s+that|so\s+cool|excited|that'?s\s+great|brilliant|fantastic)\b/i;
const CURIOUS_RE = /\b(how\s+does|why\s+does|tell\s+me\s+more|curious|wonder|what\s+if|can\s+you\s+explain)\b/i;
const PERSONAL_RE =
  /\b(i\s+was|it\s+was|when\s+i|where\s+i|one\s+day|yesterday|last\s+(?:week|month)|near\s+my|at\s+my\s+house|my\s+home)\b/i;
const QUESTION_RE = /^(what|who|where|when|why|how|can|could|would|is|are|do|does)\b/i;

export function quickAffect(utterance: string): QuickAffectResult {
  const q = (utterance || "").trim();
  if (!q) {
    return { primary: "neutral", fillerCategory: "general", confidence: 0.3, skipFiller: false };
  }
  if (CLOSING_RE.test(q)) {
    return { primary: "closing", fillerCategory: "closing", confidence: 0.92, skipFiller: true };
  }
  if (CONFUSION_RE.test(q)) {
    return { primary: "confused", fillerCategory: "confused", confidence: 0.9, skipFiller: false };
  }
  if (FRUSTRATION_RE.test(q)) {
    return { primary: "frustrated", fillerCategory: "frustrated", confidence: 0.88, skipFiller: false };
  }
  if (BOREDOM_RE.test(q)) {
    return { primary: "bored", fillerCategory: "bored", confidence: 0.85, skipFiller: false };
  }
  if (EXCITEMENT_RE.test(q)) {
    return { primary: "excited", fillerCategory: "excited", confidence: 0.85, skipFiller: false };
  }
  if (AFFIRM_RE.test(q)) {
    return { primary: "affirmation", fillerCategory: "affirmation", confidence: 0.9, skipFiller: false };
  }
  if (PERSONAL_RE.test(q)) {
    return { primary: "personal", fillerCategory: "personal", confidence: 0.82, skipFiller: false };
  }
  if (CURIOUS_RE.test(q) && q.split(/\s+/).length >= 4) {
    return { primary: "curious", fillerCategory: "question", confidence: 0.75, skipFiller: false };
  }
  if (QUESTION_RE.test(q) || q.includes("?")) {
    return { primary: "curious", fillerCategory: "question", confidence: 0.7, skipFiller: false };
  }
  return { primary: "neutral", fillerCategory: "general", confidence: 0.4, skipFiller: false };
}

function isActualQuestion(utterance: string): boolean {
  const q = (utterance || "").trim();
  return Boolean(q) && (QUESTION_RE.test(q) || q.includes("?"));
}

export function fillerIntentForTurn(
  utterance: string,
  action: string,
  intent: NestFollowupIntent | string,
  quizPending: boolean,
): { intent: FillerCategory; skip: boolean } {
  const affect = quickAffect(utterance);
  if (affect.skipFiller) return { intent: "closing", skip: true };

  // Emotion / tone beats action type — don't say "Good question" to a confused student.
  if (affect.fillerCategory !== "general" && affect.confidence >= 0.65) {
    return { intent: affect.fillerCategory, skip: false };
  }

  if (action === "EVALUATE" || quizPending) return { intent: "evaluate", skip: false };
  if (action === "SIMPLIFY" || intent === "simplify") return { intent: "confused", skip: false };
  if (intent === "example" || intent === "repeat") return { intent: "followup", skip: false };

  if (isActualQuestion(utterance)) return { intent: "question", skip: false };

  return { intent: "general", skip: false };
}

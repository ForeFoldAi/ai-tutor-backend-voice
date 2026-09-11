/**
 * Decide what kind of thinking-filler a student turn needs.
 * Mode drives the LLM ack; intent is the canned-phrase fallback bucket.
 */
import { NestFollowupIntent } from "../tutor/interfaces";
import {
  CLOSING_RE,
  isBareAcknowledgement,
  isGreetingOnly,
  isUnderstandingPraise,
} from "../tutor/reply-intent";
import { FillerCategory, fillerIntentForTurn, quickAffect } from "./quick-affect";
import { topicFromQuestion } from "../tutor/query-rewriter";

export type FillerMode =
  | "skip"
  | "affirmation"
  | "greeting"
  | "confused"
  | "frustrated"
  | "bored"
  | "excited"
  | "personal"
  | "question"
  | "followup"
  | "evaluate"
  | "social"
  | "general";

export type FillerPlan = {
  skip: boolean;
  mode: FillerMode;
  /** Canned FILLER_PHRASES bucket when LLM filler is late/unavailable. */
  intent: FillerCategory;
  utterance: string;
  topic: string;
  chapter: string;
};

const MODE_TO_INTENT: Record<Exclude<FillerMode, "skip">, FillerCategory> = {
  affirmation: "affirmation",
  greeting: "general",
  confused: "confused",
  frustrated: "frustrated",
  bored: "bored",
  excited: "excited",
  personal: "personal",
  question: "question",
  followup: "followup",
  evaluate: "evaluate",
  social: "general",
  general: "general",
};

/** Cap spoken topic so TTS stays under the filler duration budget. */
export function shortTopic(raw: string, maxWords = 4): string {
  const t = (raw || "")
    .replace(/[*#_/`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  return t.split(/\s+/).slice(0, maxWords).join(" ");
}

export function resolveTopic(opts: {
  utterance: string;
  currentConcept?: string;
  chapter?: string;
}): string {
  const fromSession = shortTopic(opts.currentConcept || "");
  const fromChapter = shortTopic(opts.chapter || "");
  const extracted = shortTopic(topicFromQuestion(opts.utterance || ""));
  const u = (opts.utterance || "").trim().toLowerCase();
  // Short follow-ups ("again?", "that part") have no topic in the words.
  if (extracted && extracted.toLowerCase() !== u && extracted.split(/\s+/).length <= 6) {
    if (!/^(again|that|this|it|please|yes|ok|okay)$/i.test(extracted)) return extracted;
  }
  return fromSession || fromChapter;
}

/**
 * Sanitize model output into a speakable filler line.
 * Returns "" when the model answered / rambled — caller falls back to canned.
 */
export function sanitizeLlmFillerPhrase(raw: string, maxWords = 10): string {
  let s = (raw || "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[*#_]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // First line only — models sometimes add a second sentence.
  s = s.split(/[\n.!?]/)[0]?.trim() || "";
  if (!s) return "";
  const words = s.split(/\s+/);
  if (words.length > maxWords) s = words.slice(0, maxWords).join(" ");
  if (s.length > 72) return "";
  // Reject mini-answers / teaching leakage.
  if (
    /\b(because|therefore|step\s*\d|formula|equals|means that|the answer)\b/i.test(s) ||
    /[=∫√]/.test(s)
  ) {
    return "";
  }
  return s;
}

export function fillerSystemPrompt(plan: FillerPlan): string {
  const topicLine = plan.topic ? `Known topic: ${plan.topic}` : "Known topic: (none)";
  const chapterLine = plan.chapter ? `Chapter: ${plan.chapter}` : "Chapter: (none)";
  const modeHint: Record<Exclude<FillerMode, "skip">, string> = {
    affirmation: "Student understood or praised your explanation. Warm ack only — do not teach.",
    greeting: "Student is greeting you. Greet back briefly — do not teach.",
    confused: "Student is confused or wants it simpler. Reassure; name the topic if known.",
    frustrated: "Student is frustrated. Empathize briefly; stay calm.",
    bored: "Student is bored. Acknowledge; hint you will switch it up.",
    excited: "Student is excited. Match energy briefly.",
    personal: "Student shared something personal. Acknowledge warmly.",
    question: "Student asked a question. Acknowledge you are looking at their topic.",
    followup: "Student asked a follow-up. Acknowledge you are continuing.",
    evaluate: "Student answered a check question. Say you are checking it.",
    social: "Normal chat, not a textbook ask. Brief human ack.",
    general: "Hold the line briefly while you think.",
  };
  return (
    "You write ONE short spoken filler for a school voice tutor while the real reply loads.\n" +
    "Hard rules: max 10 words; no answer; no question; no markdown; plain speech only.\n" +
    `Mode: ${plan.mode}. ${modeHint[plan.mode as Exclude<FillerMode, "skip">] || modeHint.general}\n` +
    `${topicLine}\n${chapterLine}\n` +
    "Output only the filler line."
  );
}

export function resolveFillerPlan(opts: {
  utterance: string;
  action: string;
  followup: NestFollowupIntent | string;
  quizPending: boolean;
  currentConcept?: string;
  chapter?: string;
}): FillerPlan {
  const utterance = (opts.utterance || "").trim();
  const chapter = shortTopic(opts.chapter || "", 6);
  const topic = resolveTopic({
    utterance,
    currentConcept: opts.currentConcept,
    chapter: opts.chapter,
  });
  const base = {
    utterance,
    topic,
    chapter,
  };

  if (!utterance || CLOSING_RE.test(utterance)) {
    return { ...base, skip: true, mode: "skip", intent: "closing" };
  }

  // Short okay / got it — main reply is instant; thinking filler feels wrong.
  if (isBareAcknowledgement(utterance) && !isUnderstandingPraise(utterance)) {
    return { ...base, skip: true, mode: "skip", intent: "closing" };
  }

  // Praise / "I understood very well" — warm bridge, never "let me think about X".
  if (isUnderstandingPraise(utterance)) {
    return { ...base, skip: false, mode: "affirmation", intent: "affirmation" };
  }

  if (isGreetingOnly(utterance)) {
    return { ...base, skip: false, mode: "greeting", intent: "general" };
  }

  const { intent, skip } = fillerIntentForTurn(
    utterance,
    opts.action,
    opts.followup,
    opts.quizPending,
  );
  if (skip) return { ...base, skip: true, mode: "skip", intent: "closing" };

  const intentToMode: Partial<Record<FillerCategory, Exclude<FillerMode, "skip">>> = {
    question: "question",
    followup: "followup",
    evaluate: "evaluate",
    confused: "confused",
    frustrated: "frustrated",
    bored: "bored",
    excited: "excited",
    personal: "personal",
    affirmation: "affirmation",
    general: "general",
  };
  let mode: Exclude<FillerMode, "skip"> = intentToMode[intent] || "general";
  // Short non-question chat ("that was hard yesterday") — social, not topic think.
  if (
    mode === "general" &&
    utterance.length < 48 &&
    !/[?]/.test(utterance) &&
    quickAffect(utterance).primary === "neutral"
  ) {
    mode = "social";
  }

  return {
    ...base,
    skip: false,
    mode,
    intent: MODE_TO_INTENT[mode],
  };
}

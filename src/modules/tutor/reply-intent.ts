/**
 * Student reply intent for voice turn routing (hints only — LLM writes the reply).
 * Keep regex lists in sync with ai-tutor-backend/app/services/voice_tutor.py
 * (classify_reply_intent + _CLOSING / _CONFUSION / _AFFIRM) and voice_ack.py.
 */

export type ReplyIntent = "CLOSING" | "DONT_KNOW" | "WRONG_ANSWER" | "NEW_QUESTION" | "UNCLEAR";

/** Non-teaching dialogue acts → FastAPI skips RAG; LLM still answers. */
export type DialogueAct = "closing" | "ack" | "intro";

/** End session / thanks / leave — no new quiz. */
export const CLOSING_RE =
  /\b(thank\s*you|thanks|thank\s*u|okay?\s*,?\s*got\s+it|i\s+understand\s+now|that'?s\s+all|i'?m\s+done|no\s+more\s+questions?|bye|goodbye|see\s+you|have\s+(?:some\s+)?work|gotta\s+go|got\s+to\s+go)\b/i;

/** Uncertainty / confusion — never grade as a wrong quiz answer. */
export const CONFUSION_RE =
  /\b(confused|don'?t\s+understand|not\s+clear|what\s+do\s+you\s+mean|huh|no\s+idea|no\s+clue|(?:don'?t|dont)\s+know|not\s+sure|i\s+don'?t\s+get|still\s+confused|too\s+hard|lost|didn'?t\s+get)\b/i;

export const AFFIRM_RE =
  /^(yes|yeah|yep|yup|ok|okay|sure|right|correct|exactly|got\s+it|i\s+understand|understood|makes\s+sense)[.!?]*$/i;

const ACK_RE =
  /^(laughing|laughs|laughter|haha+|ha\s+ha|hehe+|lol|lmao|okay|ok|yes|yeah|yep|yup|sure|right|hmm+|mm+|mhm+|uh-?huh|wow|whoa|interesting|nice|cool|i\s+see|got\s+it|makes\s+sense|i\s+understand|understood)$/i;

/** Real requests for teaching — not bare reactions. */
const ACK_EDU_RE =
  /\b(tell\s+me\s+more|explain|why|what|who|where|when|how|continue|go\s+on|more\s+about|did\s+it|does\s+it|quiz|simplify|(?:give|another|an|more|some)\s+examples?|examples?\s+(?:of|please|from))\b/i;

/** Praise of the tutor's example — ack, not "give me an example". */
const EXAMPLE_PRAISE_RE =
  /^(?:(?:ok|okay|yes|yeah|yep|sure)\s+)?(?:a\s+)?(?:nice|good|great|cool|lovely)\s+example(?:\s+(?:thanks|thank\s+you))?$/i;

/** Self-intro — not a curriculum topic. */
const PERSONAL_INTRO_RE =
  /^(?:(?:hi|hello|hey)[,!]?\s+)?(?:i(?:'m|\s+am)|my\s+name\s+is|this\s+is)\s+/i;

function ackNorm(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[()[\]{}.,!?"'`~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Bare laugh / okay / wow — not a question and not a quiz answer. */
export function isBareAcknowledgement(utterance: string): boolean {
  const q = ackNorm(utterance);
  if (!q) return false;
  if (EXAMPLE_PRAISE_RE.test(q)) return true;
  if (ACK_EDU_RE.test(q)) return false;
  return ACK_RE.test(q);
}

export function isPersonalIntro(utterance: string): boolean {
  const q = ackNorm(utterance);
  return q.length > 0 && q.length <= 80 && PERSONAL_INTRO_RE.test(q);
}

/**
 * Routing signal for Nest → FastAPI: skip chapter retrieval, LLM still replies.
 * null → normal teach path (RAG on).
 */
export function dialogueActForUtterance(
  utterance: string,
  quizPending: boolean,
): DialogueAct | null {
  const q = (utterance || "").trim();
  if (!q) return null;
  if (CLOSING_RE.test(q)) return "closing";
  if (isPersonalIntro(q)) return "intro";
  if (!quizPending && isBareAcknowledgement(q)) return "ack";
  if (quizPending && isBareAcknowledgement(q)) return "ack";
  return null;
}

/** @deprecated LLM writes acks — kept for tests / filler skip only. */
export function ackReply(utterance: string): string {
  const q = ackNorm(utterance);
  if (/laugh|haha|hehe|lol/.test(q)) return "Glad you're enjoying it!";
  if (/wow|whoa|interesting|nice|cool|good\s+example|nice\s+example/.test(q)) {
    return "Glad you found that helpful.";
  }
  return "Alright.";
}

export function classifyReplyIntent(utterance: string, quizPending: boolean): ReplyIntent {
  const q = (utterance || "").trim();
  if (!q || !/[a-zA-Z0-9]/.test(q)) return "UNCLEAR";
  if (CLOSING_RE.test(q)) return "CLOSING";
  if (CONFUSION_RE.test(q)) return "DONT_KNOW";
  if (quizPending && !AFFIRM_RE.test(q)) {
    return isBareAcknowledgement(q) ? "UNCLEAR" : "WRONG_ANSWER";
  }
  return "NEW_QUESTION";
}

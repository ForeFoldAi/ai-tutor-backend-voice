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

/**
 * Student understood / liked the explanation — real classroom reactions.
 * Keep short (≤16 words) so "good explanation of cells, now what is…" stays a question.
 */
const UNDERSTANDING_PRAISE_RE =
  /\b(?:(?:really\s+|very\s+|so\s+)?(?:good|great|nice|clear|helpful|excellent|awesome|wonderful|perfect)\s+(?:explanation|example|teaching|job|one)|well\s+explained|explained\s+(?:it\s+)?well|(?:i\s+)?(?:really\s+)?(?:understood?|got\s+it|understand)(?:\s+(?:it|that|this|everything))?(?:\s+(?:very\s+well|clearly|now|fully|better))?|(?:it\s+)?(?:was\s+|is\s+)?(?:very\s+|really\s+)?(?:clear|helpful)(?:\s+(?:for\s+me|to\s+me))?|makes\s+(?:perfect\s+|more\s+)?sense|that\s+helped(?:\s+(?:a\s+lot|me|a\s+ton))?|crystal\s+clear|now\s+i\s+(?:get|understand)\s+it|i\s+get\s+it\s+now)\b/i;

/** Self-intro — not a curriculum topic. */
const PERSONAL_INTRO_RE =
  /^(?:(?:hi|hello|hey)[,!]?\s+)?(?:i(?:'m|\s+am)|my\s+name\s+is|this\s+is)\s+/i;

/** Greeting-only — no teaching ask yet. */
export const GREETING_ONLY_RE =
  /^(?:hi|hello|hey|good\s+morning|good\s+afternoon|good\s+evening)(?:\s+(?:there|teacher|sir|madam|ma'?am))?[.!]*$/i;

function ackNorm(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[()[\]{}.,!?"'`~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Good explanation", "I understood very well", etc. — reaction, not a topic ask. */
export function isUnderstandingPraise(utterance: string): boolean {
  const q = ackNorm(utterance);
  if (!q) return false;
  if (ACK_EDU_RE.test(q)) return false;
  if (q.split(/\s+/).length > 16) return false;
  return UNDERSTANDING_PRAISE_RE.test(q);
}

/** Bare laugh / okay / wow / praise — not a question and not a quiz answer. */
export function isBareAcknowledgement(utterance: string): boolean {
  const q = ackNorm(utterance);
  if (!q) return false;
  if (EXAMPLE_PRAISE_RE.test(q)) return true;
  if (isUnderstandingPraise(q)) return true;
  if (ACK_EDU_RE.test(q)) return false;
  return ACK_RE.test(q);
}

export function isGreetingOnly(utterance: string): boolean {
  return GREETING_ONLY_RE.test(ackNorm(utterance));
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
  if (isTeachRequest(q)) return null;
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

/** Offers and tag questions — "yes" to these is not a quiz answer. */
const OFFER_RE =
  /^(?:(?:so|okay|ok|now|great|alright)[,!]?\s+)?(?:want|do\s+you\s+want|would\s+you\s+like|shall\s+(?:i|we)|should\s+(?:i|we)|can\s+i|may\s+i|ready|any\s+(?:other\s+|more\s+)?questions?|does\s+(?:that|this)\s+make\s+sense|got\s+it|right|okay|ok|isn'?t\s+it|na)\b/i;

/**
 * Questions about the student, not about the lesson: a reply to these is a new
 * request, and grading it produced "not quite yet, have another go" for "What
 * is Vijayanagar?". Includes the "did you mean X?" mishearing check.
 */
const NON_CHECK_RE = new RegExp(
  [
    String.raw`\bdid\s+you\s+(?:mean|say)\b`,
    String.raw`\b(?:what|which)\s+(?:part|topic|bit|area|one)s?\b.*\b(?:tricky|confus|stuck|interest|explore|like|want|start|feel|hard|difficult|next)`,
    String.raw`^(?:so|okay|ok|now|great|alright)?[,!]?\s*(?:does|did|is|was)\s+(?:that|this|it)\s+(?:help|give|make|clear|clarify|answer|sound|feel|work)`,
    String.raw`^(?:do|did|can|could)\s+you\s+(?:see|picture|imagine|follow|understand|get)\s+(?:it|that|this|them|now)\b`,
    String.raw`^do\s+you\s+(?:want|need)\b`,
    String.raw`\b(?:what|anything)\s+else\b`,
    String.raw`\bwhat\s+would\s+you\s+like\b`,
    String.raw`\b(?:or|shall\s+we|want\s+to)\s+(?:move|go|try|continue|look)\b`,
    String.raw`\bhow\s+(?:about|does\s+that\s+sound)\b`,
    String.raw`\bany\s+(?:other\s+|more\s+)?(?:doubts?|questions?)\b`,
    // Choices ("Which of these four forms do you want to explore first?") have no right answer.
    String.raw`\b(?:do|would)\s+you\s+(?:want|like|prefer|wish)\b`,
    String.raw`\b(?:shall|should)\s+(?:we|i)\b`,
    String.raw`\b(?:explore|learn|cover|discuss|start\s+with|begin\s+with|look\s+at)\s+(?:first|next)\b`,
  ].join("|"),
  "i",
);

/**
 * Requests to be taught ("keep teaching me this lesson") and protests about a
 * misheard turn ("I did not say anything") — never answers to an open check question.
 */
const TEACH_REQUEST_RE =
  /\b(?:teach(?:ing)?\s+(?:me|us|this|the|it)|keep\s+(?:on\s+)?(?:teaching|going|explaining)|continue\s+(?:with\s+)?(?:the\s+|this\s+)?(?:lesson|teaching|explaining|explanation|chapter|topic)|(?:start|begin|resume)\s+(?:the\s+|this\s+)?(?:lesson|chapter|teaching|topic)|(?:explain|tell\s+me\s+about)\s+(?:the|this)\s+(?:lesson|chapter|topic)|(?:move|go)\s+on|next\s+(?:topic|part|point|section))\b/i;
const NOT_AN_ANSWER_RE =
  /\b(?:i\s+(?:did\s*n[o']?t|didn'?t|have\s*n[o']?t|haven'?t|never)\s+(?:say|said|ask|asked|answer|answered|speak|spoke)|(?:that'?s|that\s+is)\s+not\s+what\s+i\s+(?:said|asked))\b/i;

export function isTeachRequest(utterance: string): boolean {
  const q = (utterance || "").trim();
  return TEACH_REQUEST_RE.test(q) || NOT_AN_ANSWER_RE.test(q);
}

/**
 * The check question a tutor reply leaves open, or "".
 * Looks at the last two sentences — replies often end on "Just guess!" after the question.
 * Keep in sync with pending_question() in ai-tutor-backend/app/services/voice_tutor.py.
 */
export function pendingQuestion(reply: string): string {
  const sentences = (reply || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-2);
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i];
    if (s.includes("?") && !OFFER_RE.test(s) && !NON_CHECK_RE.test(s)) return s;
  }
  return "";
}

export function classifyReplyIntent(utterance: string, quizPending: boolean): ReplyIntent {
  const q = (utterance || "").trim();
  if (!q || !/[a-zA-Z0-9]/.test(q)) return "UNCLEAR";
  if (CLOSING_RE.test(q)) return "CLOSING";
  if (CONFUSION_RE.test(q)) return "DONT_KNOW";
  if (isTeachRequest(q)) return "NEW_QUESTION";
  if (quizPending && !AFFIRM_RE.test(q)) {
    return isBareAcknowledgement(q) ? "UNCLEAR" : "WRONG_ANSWER";
  }
  return "NEW_QUESTION";
}

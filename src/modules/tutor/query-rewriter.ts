import type { ChatTurn } from "./interfaces";

const FOLLOWUP = /^(why|how|what about|and)\b/i;
const DEIXIS = /\b(it|they|them|this|that|those|these)\b/i;
const SIMPLIFY = /\b(simpler|simply|easier|too hard|don'?t understand|explain that)\b/i;
const EXAMPLE = /\b(example|for instance)\b/i;
const ASK_ME = /\b(ask me|quiz me|test me)\b/i;

export function lastUserQuestion(history: ChatTurn[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].content.trim();
  }
  return "";
}

export function topicFromQuestion(q: string): string {
  const m = q.match(/\b(?:what is|what's|whats|explain|define)\s+(.+?)\??$/i);
  if (m) return m[1].replace(/^(a|an|the)\s+/i, "").trim();
  return q.replace(/\?+$/, "").trim();
}

/** Deterministic rewrite. LLM fallback is optional in QueryRewriterService. */
export function rewriteRetrievalQuery(current: string, history: ChatTurn[]): string {
  const q = current.trim();
  if (!q) return q;
  const prev = lastUserQuestion(history.filter((t) => t.content !== q));
  if (!prev) return q;
  const topic = topicFromQuestion(prev);
  if (!topic || topic.toLowerCase() === q.toLowerCase()) return q;
  if (DEIXIS.test(q) || FOLLOWUP.test(q)) {
    return q
      .replace(/\bit\b/gi, topic)
      .replace(/\bthis\b/gi, topic)
      .replace(/\bthat\b/gi, topic)
      .replace(/\bthey\b/gi, topic)
      .replace(/\bthem\b/gi, topic);
  }
  return q;
}

const CHAPTER_DEIXIS = /\b(?:this|the|that)\s+(?:chapter|unit|lesson|topic)\b/i;
/** Words that carry no retrievable topic — what's left after these is the real subject. */
const REQUEST_FILLER =
  /\b(?:can|could|would|you|please|me|my|about|explain|explaining|tell|telling|describe|discuss|summari\w*|give|teach|start|begin|go|through|want|need|know|learn|understand|whole|entire|full|briefly|brief|short|quick|little|bit|some|thing|things|what|which|who|is|are|was|were|it|its|this|that|the|a|an|of|on|in|for|to|and|or|i|we|us|chapter|unit|lesson|topic|do|does|did|have|has|had|will|shall|let|s|t)\b/gi;

/**
 * Strip the invisible control characters that PDF extraction leaves in chapter
 * titles (Class 8 English Unit 1 is stored as "Unit 1 - Wit and Wisdom\b"), plus
 * the leading unit/chapter numbering, which is pure ordinal noise in a search
 * query. Mirrors clean_display_label() on the FastAPI side.
 */
export function cleanChapterName(name: string): string {
  return (name || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F\u00AD\u200B-\u200F\uFEFF]/g, "")
    .replace(/^\s*(?:unit|chapter|ch\.?|lesson)\s*\d+\s*[-–—:.]?\s*/i, "")
    .trim();
}

/**
 * Is the student asking for the chapter as a whole, with no topic of their own?
 * ("Can you explain me about this chapter?", "Summarise the unit.")
 */
export function isChapterOverviewRequest(q: string): boolean {
  if (!CHAPTER_DEIXIS.test(q)) return false;
  const rest = q
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(REQUEST_FILLER, " ")
    .trim();
  return rest.split(/\s+/).filter(Boolean).length === 0;
}

/**
 * Anchor a chapter-level question to the chapter's actual title.
 *
 * "Can you explain me about this chapter?" contains no topical terms at all, so
 * the vector search has nothing to match on and returns whatever is nearest to
 * generic instructional phrasing — which in a textbook is the exercises
 * ("Answer the following questions", "Fill in the blanks"). The tutor then has
 * no real content to ground on and fills the gap from the model's own
 * knowledge, inventing details that are not in the book.
 *
 * The chapter title is already in the session scope; this puts it into the query.
 */
export function groundChapterQuery(current: string, chapterName: string): string {
  const q = current.trim();
  const name = cleanChapterName(chapterName);
  if (!name || !q) return q;
  if (isChapterOverviewRequest(q)) {
    return `${name}: overview, main themes and key ideas`;
  }
  if (CHAPTER_DEIXIS.test(q)) return q.replace(CHAPTER_DEIXIS, name);
  return q;
}

export function followupIntent(q: string): "simplify" | "example" | "quiz" | "normal" {
  if (SIMPLIFY.test(q)) return "simplify";
  if (EXAMPLE.test(q)) return "example";
  if (ASK_ME.test(q)) return "quiz";
  return "normal";
}

const RECALL_VERB =
  /\b(ask(?:ed)?|say|said|tell|told|talk(?:ed|ing)?|discuss(?:ed|ing)?|mention(?:ed)?|cover(?:ed)?)\b/i;
const RECALL_REF = /\b(before|earlier|previous(?:ly)?|last|just now|so far|again)\b/i;
const RECALL_WHO = /\b(i|we|you|my|our)\b/i;
/** Explicit meta forms that omit a classic recall verb ("ask/said/…"). */
const RECALL_META =
  /\b(?:(?:what|which)\s+(?:was|is|were|are)\s+(?:my|the)\s+last\s+question\b|(?:my|the)\s+last\s+question\b|what\s+did\s+i\s+(?:just\s+)?ask\b|repeat\s+(?:my\s+)?(?:last\s+)?question\b|can\s+you\s+repeat\s+my\b)/i;

/**
 * Is the student asking about the conversation itself rather than the chapter?
 * ("What question did I ask before?", "What were we discussing?", "Repeat that.")
 *
 * These must not reach the retrieval path: the rewriter's job is to turn any
 * utterance into a standalone textbook query, so it happily rewrites "what did
 * I ask you before" into a search for chapter content and the student gets a
 * lesson instead of an answer.
 *
 * Conservative: verb+ref+who, or an explicit meta phrase. A miss falls through
 * to retrieval; a false positive would hijack a textbook question like
 * "What did Tenali Rama say?".
 */
export function isRecallQuestion(q: string): boolean {
  const s = q.trim();
  if (!s) return false;
  if (/^(repeat|say that again)\b/i.test(s)) return true;
  if (RECALL_META.test(s)) return true;
  return RECALL_VERB.test(s) && RECALL_REF.test(s) && RECALL_WHO.test(s);
}

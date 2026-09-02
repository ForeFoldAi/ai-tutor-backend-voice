const WHISPER_JUNK = new Set([
  "blank audio",
  "blank_audio",
  "inaudible",
  "music",
  "applause",
  "silence",
  "laughs",
  "laughter",
  "laughing",
  "mumbling",
  "murmuring",
  "murmur",
  "chattering",
  "chatter",
  "whispering",
  "whispers",
  "whisper",
  "clear throat",
  "clears throat",
  "cough",
  "coughs",
  "sigh",
  "sighs",
  "breathing",
  "background noise",
  "background",
  "static",
  "noise",
  "bell",
  "bells",
  "ding",
  "dings",
  "chime",
  "beep",
  "click",
  "clicks",
  "typing",
  "footsteps",
  "crowd",
  "thank you for watching",
  "thanks for watching",
  "subscribe",
  "subtitles by",
  "amara org",
  "and guess what",
  "for a specific update editor",
  "speaking in foreign language",
  "speaking foreign language",
  "foreign language",
]);

/** Whisper YouTube/silence hallucinations that look like English sentences. */
const HALLUCINATION_RE = [
  /^and guess what\??$/i,
  /^for a specific update editor\.?$/i,
  /speaking in (a )?foreign language/i,
  /subtitles? by/i,
];

const SHORT_OK = new Set(["ok", "okay", "yes", "no", "hi", "hey", "bye", "stop", "wait", "why", "how"]);

/** Whisper often hallucinates bracketed stage directions on silence/noise. */
const BRACKET_ONLY_RE = /^[\[(]([^[\]()]{1,64})[\])]\.?$/i;

function junkKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[ .,!?-]+|[ .,!?-]+$/g, "");
}

function isBracketNoise(text: string): boolean {
  // ponytail: students never speak in parentheses; Whisper does on silence
  return BRACKET_ONLY_RE.test((text || "").trim());
}

export function isMeaningfulTranscript(text: string): boolean {
  const raw = (text || "").trim();
  if (raw.length < 2) return false;
  if (isBracketNoise(raw)) return false;
  const key = junkKey(raw);
  if (WHISPER_JUNK.has(key)) return false;
  if (HALLUCINATION_RE.some((re) => re.test(raw) || re.test(key))) return false;
  if (!/[a-zA-Z0-9]/.test(raw)) return false;
  const words = raw.split(/\s+/).map((w) => w.replace(/^[^\w]+|[^\w]+$/g, "")).filter(Boolean);
  if (!words.length) return false;
  if (words.length === 1) {
    const w = junkKey(words[0]);
    if (WHISPER_JUNK.has(w)) return false;
    return SHORT_OK.has(w) || w.length >= 4;
  }
  return words.some((w) => w.length >= 2);
}

const PHRASE_FIXES: Array<[RegExp, string]> = [
  [/\bphoto\s+synthesis\b/gi, "photosynthesis"],
  [/\bphoto\s+synesis\b/gi, "photosynthesis"],
  [/\bchloro\s+plast(s)?\b/gi, "chloroplast$1"],
  [/\bmulti\s+plication\b/gi, "multiplication"],
  [/\bmultiply\s+cation\b/gi, "multiplication"],
  [/\bdivi\s+sion\b/gi, "division"],
  [/\bex\s+squared\b/gi, "x squared"],
  [/\bwhy\s+squared\b/gi, "y squared"],
  [/\bex\s+cubed\b/gi, "x cubed"],
  [/\bmito\s+chondria\b/gi, "mitochondria"],
  [/\bnu\s+cleus\b/gi, "nucleus"],
];

const WORD_FIXES: Record<string, string> = {
  photosynthisis: "photosynthesis",
  photosynthsis: "photosynthesis",
  cloroplast: "chloroplast",
  multipication: "multiplication",
  eqation: "equation",
  denomenator: "denominator",
  numirator: "numerator",
  mitocondria: "mitochondria",
  mitachondria: "mitochondria",
};

/** Conservative term cleanup only — does not rewrite names or place names. */
export function postprocessTranscript(text: string, subjectName = ""): string {
  const raw = (text || "").trim();
  if (!raw) return "";
  let out = raw;
  for (const [pattern, repl] of PHRASE_FIXES) {
    out = out.replace(pattern, repl);
  }
  if (subjectName.toLowerCase().includes("math")) {
    out = out.replace(/(\d)\s+into\s+(\d)/gi, "$1 * $2");
    out = out.replace(/\bmultiplied\s+by\b/gi, "*");
    out = out.replace(/\bdivided\s+by\b/gi, "/");
  }
  return out
    .split(/\s+/)
    .map((w) => {
      const core = w.replace(/^[^\w]+|[^\w]+$/g, "");
      const repl = WORD_FIXES[core.toLowerCase()];
      return repl ? w.replace(core, repl) : w;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when STT mostly repeats the tutor's last spoken line (speaker echo). */
export function isLikelyEcho(user: string, assistant: string): boolean {
  const u = junkKey(user);
  const a = junkKey(assistant);
  if (u.length < 12 || a.length < 12) return false;
  if (a.includes(u)) return true;
  const probe = a.slice(0, Math.min(80, a.length));
  if (probe.length >= 24 && u.includes(probe)) return true;
  const uw = u.split(" ").filter((w) => w.length > 2);
  if (uw.length < 4) return false;
  const aset = new Set(a.split(" ").filter((w) => w.length > 2));
  const hit = uw.filter((w) => aset.has(w)).length;
  return hit / uw.length >= 0.7;
}

/** RMS of int16 PCM — gate silence/noise before Whisper hallucinates. */
export function pcmSpeechRms(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i] / 32768;
    sum += x * x;
  }
  return Math.sqrt(sum / pcm.length);
}

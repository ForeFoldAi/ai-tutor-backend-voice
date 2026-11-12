/**
 * Read chemical formulas aloud the classroom way: H₂O -> "H 2 O", Ca(OH)₂ -> "C A O H whole 2".
 *
 * Edge TTS silently drops Unicode subscripts (H₂O came out as "HO") and slurs packed
 * symbols ("NaCl" as one word), so each element symbol is spelled letter by letter.
 * Mirrors chemistry_to_speech in ai-tutor-backend/app/services/chem_speech.py.
 */

const ELEMENTS = new Set(
  `H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn
  Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce
  Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn
  Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl
  Mc Lv Ts Og`.split(/\s+/),
);

const SUB = "₀₁₂₃₄₅₆₇₈₉";
const SUP: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5",
  "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "-",
};

const LATEX_WRAP_RE = /\\(?:ce|text|mathrm|rm|textrm|mathbf)\s*\{([^{}]*)\}/g;

const FORMULA_RE = new RegExp(
  "(?<![A-Za-z0-9_.])" +
    "(\\d+)?" +
    "((?=\\(?[A-Z])(?:\\((?=[A-Z])|[A-Z][a-z]?|\\d+|[₀-₉]+|_\\{?\\d+\\}?|\\))+)" +
    "(\\^\\{?\\d*[+-]\\}?|[⁰¹²³⁴⁵⁶⁷⁸⁹]*[⁺⁻])?" +
    "(\\((?:aq|s|l|g)\\))?" +
    "(?![A-Za-z0-9])",
  "g",
);

const STATES: Record<string, string> = {
  "(aq)": "aqueous",
  "(s)": "solid",
  "(l)": "liquid",
  "(g)": "gas",
};

const count = (s: string, ch: string): number => s.split(ch).length - 1;

function spell(core: string, charged: boolean): string | null {
  const s = [...core]
    .map((c) => (SUB.includes(c) ? String(SUB.indexOf(c)) : c))
    .join("")
    .replace(/[_{}]/g, "");
  const words: string[] = [];
  let i = 0;
  let depth = 0;
  let elements = 0;
  let twoLetter = 0;
  let hasDigit = false;
  while (i < s.length) {
    const c = s[i];
    if (c === "(") {
      depth += 1;
      i += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth < 0) return null;
      if (/\d/.test(s[i + 1] ?? "")) words.push("whole");
      i += 1;
    } else if (/\d/.test(c)) {
      let j = i;
      while (j < s.length && /\d/.test(s[j])) j += 1;
      if (!words.length) return null;
      words.push(String(Number(s.slice(i, j))));
      hasDigit = true;
      i = j;
    } else {
      const pair = s.slice(i, i + 2);
      if (pair.length === 2 && /[a-z]/.test(pair[1]) && ELEMENTS.has(pair)) {
        words.push(pair.toUpperCase().split("").join(" "));
        twoLetter += 1;
        i += 2;
      } else if (ELEMENTS.has(c)) {
        words.push(c);
        i += 1;
      } else {
        return null;
      }
      elements += 1;
    }
  }
  if (depth || !elements) return null;
  // Without a digit only accept clear compounds (NaCl, HCl, NaOH) — never plain words
  // or acronyms like "No", "IS", "OK".
  if (!hasDigit && !charged && !(elements >= 2 && twoLetter)) return null;
  return words.join(" ");
}

function chargeWords(charge: string): string {
  const c = [...charge].map((ch) => SUP[ch] ?? ch).join("").replace(/[\^{}]/g, "");
  const sign = c.endsWith("+") ? "plus" : "minus";
  const n = c.slice(0, -1);
  return n ? `${n} ${sign}` : sign;
}

export function chemistrySpeech(text: string): string {
  if (!text || !/[A-Z]/.test(text)) return text;
  let converted = 0;
  let t = text.replace(LATEX_WRAP_RE, "$1");
  t = t.replace(
    FORMULA_RE,
    (whole: string, coef?: string, body = "", charge?: string, state?: string) => {
      let core = body;
      let lead = "";
      let trail = "";
      // Parentheses around the formula are prose, not part of it: "(H2O)", "(CO2 and".
      while (core.startsWith("(") && count(core, "(") > count(core, ")")) {
        lead += "(";
        core = core.slice(1);
      }
      while (core.endsWith(")") && count(core, ")") > count(core, "(")) {
        trail = ")" + trail;
        core = core.slice(0, -1);
      }
      if (core.startsWith("(") && core.endsWith(")") && !charge && !coef) {
        const inner = core.slice(1, -1);
        if (!inner.includes("(") && !inner.includes(")")) {
          lead += "(";
          trail = ")" + trail;
          core = inner;
        }
      }
      const spelled = core ? spell(core, Boolean(charge)) : null;
      if (spelled === null) return whole;
      let out = spelled;
      if (charge) out += ` ${chargeWords(charge)}`;
      if (state) out += ` ${STATES[state]}`;
      if (coef) out = `${Number(coef)} ${out}`;
      converted += 1;
      return `${lead}${out}${trail}`;
    },
  );
  if (converted) {
    t = t
      .replace(/\\(?:rightleftharpoons|leftrightharpoons|rightleftarrows)\b/g, " ⇌ ")
      .replace(/\\(?:rightarrow|longrightarrow|to)\b/g, " → ")
      .replace(/\s*(?:⇌|⇄|<=>|<->)\s*/g, " is in equilibrium with ")
      .replace(/\s*(?:→|⟶|-->|->)\s*/g, " gives ")
      .replace(/\s*[↑↓]/g, "");
  }
  return t;
}

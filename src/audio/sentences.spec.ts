import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SentenceStream, speakable } from "./sentences";

/** Feed one character at a time — the worst case an LLM token stream can produce. */
function drip(text: string, s: SentenceStream): string[] {
  const out: string[] = [];
  for (const ch of text) out.push(...s.push(ch));
  const rest = s.flush();
  if (rest) out.push(rest);
  return out;
}

describe("streaming sentence split", () => {
  it("loses no text regardless of how tokens are chopped", () => {
    const text =
      "Photosynthesis is how plants make food. They use sunlight, water and carbon dioxide. " +
      "The leaves contain chlorophyll, which is the green pigment. Oxygen is released as a by-product.";
    const chunks = drip(text, new SentenceStream());
    assert.equal(chunks.join(" "), text.trim());
  });

  it("emits the first chunk sooner than later ones", () => {
    const s = new SentenceStream(40, 80);
    const chunks = drip(
      "Plants make their own food using sunlight. This process is called photosynthesis " +
        "and it happens inside the leaves. Oxygen is released as a by-product of it all.",
      s,
    );
    assert.ok(chunks.length >= 2, "should have streamed more than one chunk");
    assert.ok(chunks[0].length < 80, `first chunk should flush early: ${chunks[0]}`);
  });

  it("waits for a sentence to finish before emitting it", () => {
    const s = new SentenceStream(10, 10);
    // No trailing whitespace yet, so the sentence may still be growing.
    assert.deepEqual(s.push("The cell wall is rigid."), []);
    assert.deepEqual(s.push(" "), ["The cell wall is rigid."]);
  });

  it("does not split inside a numbered list or decimal", () => {
    const s = new SentenceStream(5, 5);
    const chunks = drip("Water boils at 99.9 degrees here! Step 1. Heat it.", s);
    assert.ok(
      chunks.every((c) => !c.endsWith("99.")),
      `split inside a decimal: ${JSON.stringify(chunks)}`,
    );
    assert.equal(chunks.join(" "), "Water boils at 99.9 degrees here! Step 1. Heat it.");
  });

  it("breaks run-on text so an unpunctuated answer cannot stall the stream", () => {
    const runOn = "word ".repeat(200).trim();
    const s = new SentenceStream(40, 80, 100);
    const chunks = drip(runOn, s);
    assert.ok(chunks.length > 1, "never flushed");
    for (const c of chunks) assert.ok(c.length <= 100, `chunk over the cap: ${c.length}`);
    assert.equal(chunks.join(" "), runOn);
  });

  it("flush is idempotent and empty input yields nothing", () => {
    const s = new SentenceStream();
    assert.deepEqual(s.push(""), []);
    assert.equal(s.flush(), "");
    assert.equal(s.flush(), "");
    assert.equal(s.chunkCount, 0);
  });
});

describe("speakable", () => {
  const NOT_SPEECH = /[*_~`$#|\\{}]|\bFig\b/;

  it("leaves ordinary spoken text untouched", () => {
    const plain = "The Hoysalas ruled from Dwarasamudra, isn't it? Let's look at why.";
    assert.equal(speakable(plain), plain);
  });

  it("keeps hyphens and apostrophes that belong to the words", () => {
    assert.equal(speakable("It's a well-known trade route."), "It's a well-known trade route.");
  });

  it("strips every markup form Edge TTS would read out loud", () => {
    const cases = [
      "**Bold** and *italic* and _under_ text",
      "# A heading\n- first point\n- second point",
      "Use `code` and ```a block``` here",
      "See [the map](https://example.com/map.png) now",
      "| col | col |",
      "> quoted line",
    ];
    for (const c of cases) {
      const out = speakable(c);
      assert.ok(!NOT_SPEECH.test(out), `markup survived: ${JSON.stringify(out)}`);
      assert.ok(out.length > 0, `everything was stripped: ${JSON.stringify(c)}`);
    }
  });

  it("says math aloud instead of spelling out symbols", () => {
    assert.equal(speakable("Area is $x^2$ units."), "Area is x squared units.");
    assert.equal(speakable("Volume is $r^3$."), "Volume is r cubed.");
    assert.ok(!NOT_SPEECH.test(speakable("\\frac{a}{b} is a fraction")));
    // Live voice reply for "square of 549" — Edge said "a b superscript 2" and "550 to 1".
    assert.equal(speakable("Use (a – b)² = a² – 2ab + b²."), "Use (a minus b) squared equals a squared minus 2ab plus b squared.");
    assert.equal(speakable("Think of 549 as (550 – 1)."), "Think of 549 as (550 minus 1).");
    assert.equal(speakable("302,500 - 1,100 + 1 = 301,401"), "302,500 minus 1,100 plus 1 equals 301,401");
    assert.equal(speakable("2 × 550 × 1 = 1,100"), "2 times 550 times 1 equals 1,100");
    assert.equal(speakable("√144 = 12 and 12 ÷ 4 = 3"), "square root of 144 equals 12 and 12 divided by 4 equals 3");
    // A prose dash is a pause, not "minus".
    assert.equal(speakable("Science starts with curiosity – just like you."), "Science starts with curiosity – just like you.");
  });

  it("drops figure and page pointers that are not meant to be spoken", () => {
    assert.equal(speakable("Look at the map (Fig. 2.3) again."), "Look at the map again.");
    assert.equal(speakable("It is shown there (see Figure 4.1)."), "It is shown there.");
  });

  it("returns empty for markup with no words, so the chunk is skipped", () => {
    assert.equal(speakable("***"), "");
    assert.equal(speakable("   "), "");
  });

  it("does not speak markdown headings or horizontal rules as dashes", () => {
    assert.equal(speakable("### Examples from your textbook:"), "Examples from your textbook:");
    assert.equal(speakable("Intro\n---\nBody text here."), "Intro. Body text here.");
    assert.equal(
      speakable("### Heading\n- bullet\n---\nMore"),
      "Heading. bullet. More",
    );
    const out = speakable("| --- | --- |");
    assert.ok(!/-{2,}/.test(out), `table rule survived: ${JSON.stringify(out)}`);
  });
});

describe("step-by-step answers", () => {
  const lcm =
    "To find the LCM of 45 and 50, follow these steps:\n\n1. First, find the prime factors of each number.\n- 45 = 3 × 3 × 5 = 3² × 5\n- 50 = 2 × 5 × 5 = 2 × 5²\n\n2. Take the highest power of each prime number from both lists.\n- Highest power of 2: 2¹\n- Highest power of 3: 3²\n\n3. Multiply these together to get the LCM.\n- LCM = 2¹ × 3² × 5² = 450\n\nSo, the LCM of 45 and 50 is 450.";

  it("pauses between list lines instead of running them together", () => {
    const spoken = drip(lcm, new SentenceStream(40, 80)).map(speakable).join(" ");
    assert.match(spoken, /3 squared times 5\. 50 equals /);
    assert.match(spoken, /2: 2\. Highest power of 3/);
    assert.doesNotMatch(spoken, /minus 50/, "a list bullet is not a minus sign");
  });

  it("never ends a chunk on a step number", () => {
    for (const chunk of drip(lcm, new SentenceStream(40, 80))) {
      assert.doesNotMatch(chunk, /(?:^|\n)\s*\d+\.$/, chunk);
    }
  });
});

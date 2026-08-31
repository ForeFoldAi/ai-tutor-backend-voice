import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SentenceStream } from "./sentences";

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

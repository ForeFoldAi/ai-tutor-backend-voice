import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fillerIntentForTurn, quickAffect } from "./quick-affect";

describe("quickAffect", () => {
  it("detects confusion", () => {
    const r = quickAffect("I don't get it, this is too hard");
    assert.equal(r.primary, "confused");
    assert.equal(r.fillerCategory, "confused");
  });

  it("detects boredom", () => {
    const r = quickAffect("This is boring, can we do something else?");
    assert.equal(r.primary, "bored");
  });

  it("detects excitement", () => {
    const r = quickAffect("Wow that's so cool! How does a rain gauge work?");
    assert.equal(r.primary, "excited");
  });

  it("skips filler on closing", () => {
    const r = quickAffect("Thanks, I'm done");
    assert.equal(r.skipFiller, true);
  });

  it("detects weather question as curious", () => {
    const r = quickAffect("What is weather?");
    assert.equal(r.fillerCategory, "question");
  });
});

describe("fillerIntentForTurn", () => {
  it("never uses general for confused utterance", () => {
    const { intent } = fillerIntentForTurn("I don't get it", "EXPLAIN", "none", false);
    assert.equal(intent, "confused");
  });

  it("skips filler on closing", () => {
    const { skip } = fillerIntentForTurn("Thanks bye", "ANSWER", "none", false);
    assert.equal(skip, true);
  });

  it("uses evaluate when quiz pending", () => {
    const { intent } = fillerIntentForTurn("thermometer", "EVALUATE", "none", true);
    assert.equal(intent, "evaluate");
  });

  it("does not use question filler for neutral explain requests", () => {
    const { intent } = fillerIntentForTurn("tell me about mughals", "EXPLAIN", "none", false);
    assert.equal(intent, "general");
  });

  it("uses question filler only for actual questions", () => {
    const { intent } = fillerIntentForTurn("What is weather?", "EXPLAIN", "none", false);
    assert.equal(intent, "question");
  });

  it("uses confused filler for simplify action", () => {
    const { intent } = fillerIntentForTurn("again please", "SIMPLIFY", "simplify", false);
    assert.equal(intent, "confused");
  });

  it("uses excited filler over explain action", () => {
    const { intent } = fillerIntentForTurn("Wow that's so cool!", "EXPLAIN", "none", false);
    assert.equal(intent, "excited");
  });
});

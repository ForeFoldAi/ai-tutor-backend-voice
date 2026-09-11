import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fillerSystemPrompt,
  resolveFillerPlan,
  resolveTopic,
  sanitizeLlmFillerPhrase,
  shortTopic,
} from "./filler-mode";

describe("sanitizeLlmFillerPhrase", () => {
  it("keeps a short ack", () => {
    assert.equal(sanitizeLlmFillerPhrase("Looking at photosynthesis."), "Looking at photosynthesis");
  });

  it("rejects teaching leakage", () => {
    assert.equal(sanitizeLlmFillerPhrase("Because plants make food from sunlight"), "");
  });

  it("caps word count", () => {
    const out = sanitizeLlmFillerPhrase("one two three four five six seven eight nine ten eleven twelve");
    assert.equal(out.split(/\s+/).length, 10);
  });
});

describe("resolveTopic", () => {
  it("prefers the asked topic over session", () => {
    assert.match(
      resolveTopic({
        utterance: "What is photosynthesis?",
        currentConcept: "fractions",
        chapter: "Nutrition in Plants",
      }),
      /photosynthesis/i,
    );
  });

  it("falls back to session concept for short follow-ups", () => {
    assert.equal(
      resolveTopic({
        utterance: "again please",
        currentConcept: "photosynthesis",
        chapter: "Nutrition in Plants",
      }),
      "photosynthesis",
    );
  });
});

describe("resolveFillerPlan", () => {
  it("skips bare okay", () => {
    const p = resolveFillerPlan({
      utterance: "okay",
      action: "ANSWER",
      followup: "none",
      quizPending: false,
    });
    assert.equal(p.skip, true);
  });

  it("uses affirmation for understanding praise", () => {
    for (const u of [
      "good explanation",
      "I understood it very well",
      "that helped a lot",
      "makes perfect sense",
      "it was very clear for me",
    ]) {
      const p = resolveFillerPlan({
        utterance: u,
        action: "ANSWER",
        followup: "none",
        quizPending: false,
        currentConcept: "photosynthesis",
      });
      assert.equal(p.skip, false, u);
      assert.equal(p.mode, "affirmation", u);
    }
  });

  it("uses greeting mode for hello", () => {
    const p = resolveFillerPlan({
      utterance: "Hi",
      action: "ANSWER",
      followup: "none",
      quizPending: false,
    });
    assert.equal(p.mode, "greeting");
    assert.equal(p.skip, false);
  });

  it("uses confused mode with session topic", () => {
    const p = resolveFillerPlan({
      utterance: "I don't get it",
      action: "SIMPLIFY",
      followup: "simplify",
      quizPending: false,
      currentConcept: "photosynthesis",
    });
    assert.equal(p.mode, "confused");
    assert.equal(p.topic, "photosynthesis");
  });

  it("uses question mode for topic asks", () => {
    const p = resolveFillerPlan({
      utterance: "What is a fraction?",
      action: "EXPLAIN",
      followup: "none",
      quizPending: false,
    });
    assert.equal(p.mode, "question");
    assert.match(p.topic, /fraction/i);
  });

  it("skips closing thanks", () => {
    const p = resolveFillerPlan({
      utterance: "Thanks bye",
      action: "ANSWER",
      followup: "none",
      quizPending: false,
    });
    assert.equal(p.skip, true);
  });

  it("builds a mode-aware system prompt", () => {
    const p = resolveFillerPlan({
      utterance: "What is weather?",
      action: "EXPLAIN",
      followup: "none",
      quizPending: false,
      chapter: "Weather",
    });
    const sys = fillerSystemPrompt(p);
    assert.match(sys, /Mode: question/);
    assert.match(sys, /max 10 words/i);
  });
});

describe("shortTopic", () => {
  it("trims long labels", () => {
    assert.equal(shortTopic("one two three four five six", 4), "one two three four");
  });
});

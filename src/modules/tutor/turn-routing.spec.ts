import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAction } from "./tutor-orchestrator.service";
import { resolveTurnPipeline } from "./turn-routing";

describe("turn routing", () => {
  const recallPhrases = [
    "What was my last question?",
    "What is my last question?",
    "What did I ask?",
    "What did I just ask?",
    "What question did I ask before?",
    "Can you repeat my last question?",
    "what was my last question",
    "WHAT WAS MY LAST QUESTION???",
  ];

  for (const q of recallPhrases) {
    it(`routes recall: ${q}`, () => {
      const action = decideAction({ utterance: q, awaitingAnswer: true, turnsSinceCheck: 2 });
      assert.equal(resolveTurnPipeline(q, action), "recall", "must not enter RAG/evaluate");
    });
  }

  it("affirmation is not recall", () => {
    const q = "I think it's simple.";
    assert.equal(resolveTurnPipeline(q, "EXPLAIN"), "rag");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rewriteRetrievalQuery, followupIntent, topicFromQuestion } from "./query-rewriter";
import { gradeByOverlap } from "./answer-evaluator.service";
import { nextDifficulty } from "./difficulty-manager.service";
import { afterEvaluate, afterExplainShouldCheck, decideAction, looksLikeNewQuestion } from "./tutor-orchestrator.service";
import { defaultSnapshot } from "./tutor-state.service";
import { turnStillActive } from "./turn-commit";
import { isRecallQuestion } from "./query-rewriter";

describe("query rewrite", () => {
  it("rewrites photosynthesis follow-up", () => {
    const q = rewriteRetrievalQuery("Why does it need sunlight?", [
      { role: "user", content: "What is photosynthesis?" },
      { role: "assistant", content: "Photosynthesis is how plants make food." },
    ]);
    assert.match(q.toLowerCase(), /photosynthesis/);
    assert.match(q.toLowerCase(), /sunlight/);
  });

  it("extracts topic", () => {
    assert.equal(topicFromQuestion("What is a fraction?").toLowerCase(), "fraction");
  });

  it("detects simplify / example / quiz", () => {
    assert.equal(followupIntent("Can you explain that more simply?"), "simplify");
    assert.equal(followupIntent("Give me an example."), "example");
    assert.equal(followupIntent("Ask me a question."), "quiz");
  });

  it("does not treat a clear topic change as deixis rewrite", () => {
    const q = rewriteRetrievalQuery("What is photosynthesis?", [
      { role: "user", content: "What was the Battle of Talikota?" },
      { role: "assistant", content: "It was a battle in 1565." },
    ]);
    assert.equal(q, "What is photosynthesis?");
  });
});

describe("answer evaluation", () => {
  const expected = "Plants use sunlight, water and carbon dioxide to make food.";
  it("marks full answer correct", () => {
    assert.equal(
      gradeByOverlap(expected, "Plants use sunlight water and carbon dioxide to make food"),
      "CORRECT",
    );
  });
  it("marks partial sunlight-only as partial", () => {
    assert.equal(gradeByOverlap(expected, "Plants use sunlight to make food."), "PARTIALLY_CORRECT");
  });
  it("marks unrelated incorrect", () => {
    assert.equal(gradeByOverlap(expected, "The moon is made of cheese."), "INCORRECT");
  });
});

describe("difficulty", () => {
  it("increases after two correct", () => {
    const out = nextDifficulty({
      difficulty: 3,
      consecutiveCorrect: 2,
      consecutiveIncorrect: 0,
      simplifyRequested: false,
    });
    assert.equal(out.difficulty, 4);
  });
  it("decreases after two incorrect", () => {
    const out = nextDifficulty({
      difficulty: 3,
      consecutiveCorrect: 0,
      consecutiveIncorrect: 2,
      simplifyRequested: false,
    });
    assert.equal(out.difficulty, 2);
  });
  it("simplifies on request", () => {
    const out = nextDifficulty({
      difficulty: 4,
      consecutiveCorrect: 1,
      consecutiveIncorrect: 0,
      simplifyRequested: true,
    });
    assert.equal(out.difficulty, 3);
  });
});

describe("orchestrator", () => {
  it("explains a direct question", () => {
    assert.equal(
      decideAction({ utterance: "What is photosynthesis?", awaitingAnswer: false, turnsSinceCheck: 0 }),
      "EXPLAIN",
    );
  });
  it("evaluates when awaiting an answer", () => {
    assert.equal(
      decideAction({ utterance: "Sunlight and water", awaitingAnswer: true, turnsSinceCheck: 1 }),
      "EVALUATE",
    );
  });
  it("does not evaluate a new question while awaiting", () => {
    assert.equal(
      decideAction({
        utterance: "What is photosynthesis?",
        awaitingAnswer: true,
        turnsSinceCheck: 1,
      }),
      "EXPLAIN",
    );
  });
  it("does not evaluate a clear refusal while awaiting", () => {
    assert.equal(
      decideAction({ utterance: "no stop", awaitingAnswer: true, turnsSinceCheck: 1 }),
      "ANSWER",
    );
  });
  it("maps grades to next action", () => {
    assert.equal(afterEvaluate("CORRECT"), "CONTINUE_LESSON");
    assert.equal(afterEvaluate("PARTIALLY_CORRECT"), "GIVE_HINT");
    assert.equal(afterEvaluate("INCORRECT"), "SIMPLIFY");
  });
  it("does not check after every sentence", () => {
    const snap = defaultSnapshot();
    snap.turnsSinceCheck = 0;
    assert.equal(afterExplainShouldCheck(snap, "A".repeat(100)), false);
    snap.turnsSinceCheck = 2;
    assert.equal(afterExplainShouldCheck(snap, "A".repeat(100)), true);
    assert.equal(afterExplainShouldCheck(snap, "A".repeat(100), "EXPLAIN"), false);
  });
  it("looksLikeNewQuestion covers meta and textbook openers", () => {
    assert.equal(looksLikeNewQuestion("What was my last question?"), true);
    assert.equal(looksLikeNewQuestion("What is photosynthesis?"), true);
    assert.equal(looksLikeNewQuestion("Sunlight and water"), false);
  });
});

describe("turn commit gate", () => {
  it("rejects aborted and stale turns", () => {
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(turnStillActive(aborted.signal, 1, 1), false);
    assert.equal(turnStillActive(undefined, 1, 2), false);
    assert.equal(turnStillActive(undefined, 3, 3), true);
  });
});

describe("recall vs textbook routing signal", () => {
  it("meta last-question is recall; chapter name is not", () => {
    assert.equal(isRecallQuestion("What was my last question?"), true);
    assert.equal(isRecallQuestion("What is a chapter name?"), false);
  });
});

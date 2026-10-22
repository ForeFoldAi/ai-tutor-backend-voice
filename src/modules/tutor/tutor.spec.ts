import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rewriteRetrievalQuery, followupIntent, topicFromQuestion } from "./query-rewriter";
import { gradeByOverlap, gradeNumeric, numbersIn } from "./answer-evaluator.service";
import { nextDifficulty } from "./difficulty-manager.service";
import { classifyReplyIntent } from "./reply-intent";
import {
  afterEvaluate,
  afterExplainShouldCheck,
  applyQuizGrades,
  decideAction,
  looksLikeNewQuestion,
  openQuizIndexes,
} from "./tutor-orchestrator.service";
import type { QuizItem } from "./interfaces";
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

  it("rewrites who-started-it against the prior topic", () => {
    const q = rewriteRetrievalQuery("Who started it?", [
      { role: "user", content: "Tell me about the Delhi Sultanate." },
      { role: "assistant", content: "It was a series of dynasties." },
    ]);
    assert.match(q.toLowerCase(), /delhi sultanate/);
  });

  it("resolves it in did-it-control follow-up", () => {
    const q = rewriteRetrievalQuery("Did it control all of India?", [
      { role: "user", content: "What was the Delhi Sultanate?" },
      { role: "assistant", content: "It was a series of dynasties in north India." },
    ]);
    assert.match(q.toLowerCase(), /delhi sultanate/);
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
  it("I don't know uses up an attempt while awaiting", () => {
    assert.equal(
      decideAction({ utterance: "I don't know.", awaitingAnswer: true, turnsSinceCheck: 1 }),
      "EVALUATE",
    );
    assert.equal(classifyReplyIntent("I don't know.", true), "DONT_KNOW");
  });
  it("simplifies I don't know when nothing is open", () => {
    assert.equal(
      decideAction({ utterance: "I don't know.", awaitingAnswer: false, turnsSinceCheck: 1 }),
      "SIMPLIFY",
    );
  });
  it("grades an answer phrased as a question", () => {
    for (const u of ["Is it 9?", "maybe sixteen?", "16?", "I think it's 16"]) {
      assert.equal(decideAction({ utterance: u, awaitingAnswer: true, turnsSinceCheck: 1 }), "EVALUATE", u);
    }
    assert.equal(
      decideAction({ utterance: "What is 2 + 3?", awaitingAnswer: true, turnsSinceCheck: 1 }),
      "EXPLAIN",
    );
  });
  it("starts a quiz on conduct-a-quiz", () => {
    assert.equal(followupIntent("Please, please conduct a quiz."), "quiz");
    assert.equal(
      decideAction({ utterance: "Please conduct a quiz", awaitingAnswer: false, turnsSinceCheck: 0 }),
      "START_QUIZ",
    );
  });
  it("treats goodbye as answer not evaluate", () => {
    assert.equal(
      decideAction({ utterance: "Bye bye.", awaitingAnswer: true, turnsSinceCheck: 3 }),
      "ANSWER",
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

describe("quiz state", () => {
  const quiz = (): QuizItem[] =>
    ["Q1", "Q2", "Q3"].map((question) => ({ question, expected: "", attempts: 0, done: false }));

  it("answering one question keeps the rest open", () => {
    const r = applyQuizGrades(quiz(), [{ index: 0, grade: "CORRECT" }]);
    assert.deepEqual(openQuizIndexes(r.quiz), [1, 2]);
    assert.equal(r.next, 1);
  });
  it("answering all at once finishes the quiz", () => {
    const r = applyQuizGrades(quiz(), [
      { index: 0, grade: "CORRECT" },
      { index: 1, grade: "CORRECT" },
      { index: 2, grade: "CORRECT" },
    ]);
    assert.equal(r.next, -1);
  });
  it("a wrong answer stays open once, then is revealed", () => {
    let r = applyQuizGrades(quiz(), [{ index: 1, grade: "INCORRECT" }]);
    assert.equal(r.quiz[1].done, false);
    assert.equal(r.outcomes[0].revealed, false);
    r = applyQuizGrades(r.quiz, [{ index: 1, grade: "INCORRECT" }]);
    assert.equal(r.quiz[1].done, true);
    assert.equal(r.outcomes[0].revealed, true);
    assert.equal(r.next, 0);
  });
});

describe("numeric grading", () => {
  it("2^4: 9 is wrong, sixteen is right", () => {
    assert.equal(gradeNumeric("16", "is it 9"), "INCORRECT");
    assert.equal(gradeNumeric("16", "sixteen"), "CORRECT");
    assert.equal(gradeNumeric("16", "2 to the 4 is 16"), "CORRECT");
  });
  it("reads Indian grouping and spoken hundreds", () => {
    assert.equal(gradeNumeric("1,728", "one thousand seven hundred and twenty eight"), "CORRECT");
    assert.deepEqual(numbersIn("two hundred fifty six"), [256]);
  });
  it("leaves non-numeric answers to the LLM", () => {
    assert.equal(gradeNumeric("x = -2 or x = 2", "2"), null);
    assert.equal(gradeNumeric("photosynthesis", "sunlight"), null);
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

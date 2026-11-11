/**
 * Regressions from the Chapter 2 "Reshaping India's Political Map" voice transcript.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { quizCount } from "./query-rewriter";
import { asksForShortAnswers, classifyReplyIntent, isNonAnswer } from "./reply-intent";
import {
  afterExplainShouldCheck,
  applyQuizGrades,
  decideAction,
  isNotAnAnswer,
  quizScore,
  spokenScore,
} from "./tutor-orchestrator.service";
import { cleanSpoken, fallbackFeedback } from "./answer-evaluator.service";
import { cleanQuestion } from "./question-generator.service";
import type { QuizItem } from "./interfaces";

const quiz = (n: number): QuizItem[] =>
  Array.from({ length: n }, (_, i) => ({
    question: `Question ${i + 1}?`,
    expected: ["Babur founded the Mughal empire", "Akbar", "Cholas"][i] ?? "answer",
    attempts: 0,
    done: false,
  }));

describe("quiz size comes from the student's words", () => {
  it("reads digits and number words, clamped", () => {
    assert.equal(quizCount("ask me 5 questions"), 5);
    assert.equal(quizCount("give me two quick questions"), 2);
    assert.equal(quizCount("quiz me"), null);
    assert.equal(quizCount("ask me 40 questions"), 10);
  });
});

describe("non-answers while a quiz is open", () => {
  const complaints = [
    "are you sure?",
    "my teacher said something different",
    "you're confusing me",
    "that's not right",
    "you said something different before",
    "Which of the following was a Mughal ruler? Option A Babur Option B Ashoka",
    "true or false the Cholas ruled Delhi",
  ];
  for (const turn of complaints) {
    it(`"${turn}" is not graded`, () => {
      assert.equal(isNonAnswer(turn), true);
      assert.equal(classifyReplyIntent(turn, true), "NEW_QUESTION");
      assert.equal(decideAction({ utterance: turn, awaitingAnswer: true, turnsSinceCheck: 0 }), "EXPLAIN");
    });
  }
  it("a real answer is still graded", () => {
    assert.equal(isNonAnswer("Babur"), false);
    assert.equal(decideAction({ utterance: "it was Babur", awaitingAnswer: true, turnsSinceCheck: 0 }), "EVALUATE");
  });
  it("NOT_AN_ANSWER grades skip the quiz entirely", () => {
    assert.equal(isNotAnAnswer([{ index: 0, grade: "NOT_AN_ANSWER" }]), true);
    const { quiz: q, outcomes, next } = applyQuizGrades(quiz(2), [{ index: 0, grade: "NOT_AN_ANSWER" }]);
    assert.deepEqual(outcomes, []);
    assert.equal(q[0].attempts, 0);
    assert.equal(next, 0);
  });
});

describe("partial credit and scoring", () => {
  it("partly correct closes the item and scores a half", () => {
    const { quiz: q } = applyQuizGrades(quiz(3), [
      { index: 0, grade: "CORRECT" },
      { index: 1, grade: "PARTIALLY_CORRECT" },
      { index: 2, grade: "CORRECT" },
    ]);
    assert.ok(q.every((i) => i.done));
    assert.equal(quizScore(q), 2.5);
    assert.equal(spokenScore(2.5), "2 and a half");
    assert.equal(spokenScore(0.5), "a half");
  });
  it("uncertain costs no attempt; second miss reveals", () => {
    let q = applyQuizGrades(quiz(1), [{ index: 0, grade: "UNCERTAIN" }]).quiz;
    assert.equal(q[0].attempts, 0);
    q = applyQuizGrades(q, [{ index: 0, grade: "INCORRECT" }]).quiz;
    assert.equal(q[0].done, false);
    q = applyQuizGrades(q, [{ index: 0, grade: "INCORRECT" }]).quiz;
    assert.equal(q[0].revealed, true);
    assert.equal(quizScore(q), 0);
  });
});

describe("no new check question after the quiz ends", () => {
  const long = "Here is a long explanation about the Mughal empire and how it grew across India over time.";
  for (const action of ["CONTINUE_LESSON", "ASK_QUESTION", "GIVE_HINT"] as const) {
    it(action, () => {
      assert.equal(afterExplainShouldCheck({ awaitingAnswer: false, turnsSinceCheck: 5 }, long, action), false);
    });
  }
});

describe("spoken feedback", () => {
  it("strips quotes and doubled periods", () => {
    assert.equal(cleanSpoken('The answer is "Babur".. Great job.'), "The answer is Babur. Great job.");
  });
  it("first miss gives a hint and re-asks instead of a canned line", () => {
    const items = quiz(1);
    const { quiz: q, outcomes, next } = applyQuizGrades(items, [{ index: 0, grade: "INCORRECT" }]);
    const text = fallbackFeedback(q, outcomes, next, "0");
    assert.match(text, /hint/i);
    assert.match(text, /Question 1\?/);
    assert.doesNotMatch(text, /Have another go/i);
  });
  it("quiz questions never refer to the tutor", () => {
    assert.equal(cleanQuestion("The tutor mentioned a puzzle. Who founded the Mughal empire?"), "Who founded the Mughal empire?");
  });
});

describe("standing short-answer preference", () => {
  it("detects the request", () => {
    assert.equal(asksForShortAnswers("stop giving such long answers"), true);
    assert.equal(asksForShortAnswers("tell me about Akbar"), false);
  });
});

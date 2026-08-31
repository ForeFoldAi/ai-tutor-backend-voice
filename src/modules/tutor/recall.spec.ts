import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRecallQuestion } from "./query-rewriter";

describe("recall detection", () => {
  it("catches questions about the conversation", () => {
    for (const q of [
      "What question I asked you before?",
      "What did I ask you earlier?",
      "What were we discussing before?",
      "What was the last thing you said?",
      "What did you tell me just now?",
      "Repeat that.",
      "Say that again",
      "What have we covered so far?",
      // Meta forms that omit ask/say/tell — previously missed.
      "What was my last question?",
      "What is my last question?",
      "What did I ask?",
      "What did I just ask?",
      "Can you repeat my last question?",
      "What question did I ask before?",
      "what was my last question",
      "WHAT WAS MY LAST QUESTION???",
    ]) {
      assert.equal(isRecallQuestion(q), true, `should be recall: ${q}`);
    }
  });

  it("leaves textbook questions alone", () => {
    // The costly failure: hijacking a real chapter question and answering it
    // from the transcript instead of the textbook.
    for (const q of [
      "What did Tenali Rama say to the king?",
      "Can you explain me about this chapter?",
      "Who told the king about the seeds before he planted them?",
      "What is wit?",
      "Tell me about wisdom",
      "Why did the courtiers laugh?",
      "Give me an example of a riddle",
      "What happened in the last chapter of the book?",
      "What is photosynthesis?",
      "Who was Akbar?",
      "Explain the Battle of Talikota.",
      "What is a chapter name?",
    ]) {
      assert.equal(isRecallQuestion(q), false, `should NOT be recall: ${q}`);
    }
  });
});

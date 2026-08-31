import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanChapterName, groundChapterQuery, isChapterOverviewRequest } from "./query-rewriter";

const UNIT1 = "Unit 1 - Wit and Wisdom\b"; // exactly as stored — PDF extraction leaves \b

describe("cleanChapterName", () => {
  it("strips the control char that PDF extraction leaves behind", () => {
    assert.equal(cleanChapterName(UNIT1), "Wit and Wisdom");
  });

  it("strips unit/chapter numbering but keeps the title", () => {
    assert.equal(cleanChapterName("Unit 3 - Mystery and Magic"), "Mystery and Magic");
    assert.equal(
      cleanChapterName("Chapter 2 - Reshaping India's Political Map"),
      "Reshaping India's Political Map",
    );
    assert.equal(cleanChapterName("Wit and Wisdom"), "Wit and Wisdom");
  });
});

describe("isChapterOverviewRequest", () => {
  it("spots whole-chapter requests", () => {
    for (const q of [
      "Can you explain me about this chapter?",
      "Explain this chapter",
      "Summarise the unit",
      "Tell me about this lesson",
      "What is this chapter about?",
    ]) {
      assert.equal(isChapterOverviewRequest(q), true, `overview: ${q}`);
    }
  });

  it("leaves questions that carry their own topic", () => {
    for (const q of [
      "Who is the main character in this chapter?",
      "What does wit mean?",
      "Explain Tenali Rama's trick",
      "What is the moral of this chapter's poem about the camel?",
    ]) {
      assert.equal(isChapterOverviewRequest(q), false, `not overview: ${q}`);
    }
  });
});

describe("groundChapterQuery", () => {
  it("anchors a contentless chapter request to the real title", () => {
    // Without this the vector search matches generic instructional phrasing and
    // returns the chapter's exercises instead of its content.
    assert.equal(
      groundChapterQuery("Can you explain me about this chapter?", UNIT1),
      "Wit and Wisdom: overview, main themes and key ideas",
    );
  });

  it("substitutes the title but keeps the student's own topic", () => {
    assert.equal(
      groundChapterQuery("Who is the main character in this chapter?", UNIT1),
      "Who is the main character in Wit and Wisdom?",
    );
  });

  it("leaves unrelated questions untouched", () => {
    assert.equal(groundChapterQuery("What does wit mean?", UNIT1), "What does wit mean?");
  });

  it("is a no-op without a chapter name", () => {
    const q = "Explain this chapter";
    assert.equal(groundChapterQuery(q, ""), q);
  });
});

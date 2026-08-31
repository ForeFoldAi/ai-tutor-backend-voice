import { collectionName } from "./rag.client";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("RAG collection filter", () => {
  it("matches existing FastAPI naming: board_class_subject", () => {
    assert.equal(collectionName("CBSE", "CLASS_8", "Science"), "CBSE_CLASS_8_Science");
  });
  it("strips spaces in subject", () => {
    assert.equal(
      collectionName("CBSE", "CLASS_7", "Social Science"),
      "CBSE_CLASS_7_Social_Science",
    );
  });
});

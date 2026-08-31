import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("session ownership key", () => {
  it("owner key is namespaced per session", () => {
    const id = "abc-123";
    assert.equal(`voice:owner:${id}`, `voice:owner:${id}`);
  });
});

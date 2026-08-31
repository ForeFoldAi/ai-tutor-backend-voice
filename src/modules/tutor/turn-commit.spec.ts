import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { turnStillActive } from "./turn-commit";

describe("turnStillActive", () => {
  it("allows a live matching turn", () => {
    assert.equal(turnStillActive(undefined, 3, 3), true);
  });

  it("rejects aborted turns so they do not commit history", () => {
    const c = new AbortController();
    c.abort();
    assert.equal(turnStillActive(c.signal, 1, 1), false);
  });

  it("rejects stale turnId after barge-in / supersede", () => {
    assert.equal(turnStillActive(undefined, 1, 2), false);
  });

  it("ignores turnId check when turnId is unset (system prompts)", () => {
    assert.equal(turnStillActive(undefined, 0, 5), true);
  });
});

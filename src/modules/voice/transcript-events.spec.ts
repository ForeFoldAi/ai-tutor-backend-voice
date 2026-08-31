import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assistantTranscript,
  turnCancelledPayload,
  userTranscriptCommitted,
  userTranscriptPending,
} from "./transcript-events";

describe("transcript WS payloads", () => {
  it("includes turnId on user pending and committed", () => {
    const pending = userTranscriptPending(7, "What is my last question?");
    assert.equal(pending.turnId, 7);
    assert.equal(pending.pending, true);
    const committed = userTranscriptCommitted(7, "What is my last question?");
    assert.equal(committed.pending, false);
  });

  it("includes turnId on assistant", () => {
    const a = assistantTranscript(7, "Your last question was…", "RECALL");
    assert.equal(a.turnId, 7);
    assert.equal(a.role, "assistant");
    assert.equal(a.action, "RECALL");
  });

  it("turn_cancelled carries turnId", () => {
    assert.deepEqual(turnCancelledPayload(3), { type: "turn_cancelled", turnId: 3 });
  });
});

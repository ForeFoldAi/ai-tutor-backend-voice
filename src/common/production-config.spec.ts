import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { instanceId } from "./instance-id";

describe("instanceId", () => {
  it("returns a non-empty string", () => {
    assert.ok(instanceId().length > 0);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { config } from "../config";
import { instanceId } from "./instance-id";
import { productionConfigIssues } from "./production-config";

describe("instanceId", () => {
  it("returns a non-empty string", () => {
    assert.ok(instanceId().length > 0);
  });
});

describe("productionConfigIssues", () => {
  const good = {
    ...config,
    jwtSecret: "x".repeat(32),
    tutorApiUrl: "http://api:8000",
    corsOrigins: ["https://app.example.com"],
    redisUrl: "redis://redis:6379/0",
    voiceInternalToken: "secret",
  };
  it("passes a complete production config", () => {
    assert.deepEqual(productionConfigIssues(good), []);
  });
  it("requires VOICE_INTERNAL_TOKEN", () => {
    const issues = productionConfigIssues({ ...good, voiceInternalToken: "" });
    assert.equal(issues.length, 1);
    assert.match(issues[0], /VOICE_INTERNAL_TOKEN/);
  });
});

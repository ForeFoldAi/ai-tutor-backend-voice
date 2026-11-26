import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenAcceptedByApi } from "./jwt";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = impl as unknown as typeof fetch;
}

describe("tokenAcceptedByApi", () => {
  it("accepts a token FastAPI accepts, sending it as the bearer to /auth/me", async () => {
    let seenUrl = "";
    let seenAuth = "";
    mockFetch(async (url, init) => {
      seenUrl = url;
      seenAuth = String((init?.headers as Record<string, string>).Authorization);
      return new Response("{}", { status: 200 });
    });
    assert.equal(await tokenAcceptedByApi("tok"), true);
    assert.match(seenUrl, /\/auth\/me$/);
    assert.equal(seenAuth, "Bearer tok");
  });

  it("rejects a token FastAPI refuses (signed in on another device, expired, deactivated)", async () => {
    mockFetch(async () => new Response("{}", { status: 401 }));
    assert.equal(await tokenAcceptedByApi("tok"), false);
    mockFetch(async () => new Response("{}", { status: 403 }));
    assert.equal(await tokenAcceptedByApi("tok"), false);
  });

  it("lets the call through when FastAPI is down or erroring", async () => {
    mockFetch(async () => new Response("oops", { status: 503 }));
    assert.equal(await tokenAcceptedByApi("tok"), true);
    mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    assert.equal(await tokenAcceptedByApi("tok"), true);
  });
});

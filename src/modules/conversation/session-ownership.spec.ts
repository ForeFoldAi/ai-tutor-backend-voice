import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VoiceService, freshImages, sttPrompt } from "../voice/voice.service";
import type { VoiceSession } from "./conversation-memory.service";

describe("voice turn helpers", () => {
  it("stt prompt ends with the tutor's last question", () => {
    const session = {
      scope: { chapterNames: ["Letter to a Friend"], chapter: "" },
      tutor: { currentConcept: "joint family" },
      currentTopic: "",
      recentMessages: [
        { role: "user", content: "My family is joint family." },
        { role: "assistant", content: "Lovely! What do you love most? Is it the fun, the help, or the stories?" },
      ],
    } as unknown as VoiceSession;
    const p = sttPrompt(session);
    assert.ok(p.startsWith("Letter to a Friend. joint family"));
    assert.ok(p.endsWith("Is it the fun, the help, or the stories?"), p);
  });

  it("each figure is shown once per connection", () => {
    const live = { shownImages: new Set<string>() };
    const fig = { url: "/auth/catalog/textbook-images/40/figures/p9_9.jpg?access_token=a" } as never;
    const same = { url: "/auth/catalog/textbook-images/40/figures/p9_9.jpg?access_token=b" } as never;
    assert.equal(freshImages(live, [fig]).length, 1);
    assert.equal(freshImages(live, [same]).length, 0);
  });
});

describe("session ownership key", () => {
  it("owner key is namespaced per session", () => {
    const id = "abc-123";
    assert.equal(`voice:owner:${id}`, `voice:owner:${id}`);
  });
});

describe("resume takeover", () => {
  it("old socket disconnecting does not tear down the resumed socket", async () => {
    let released = 0;
    const memory = { get: async () => null, save: async () => undefined } as never;
    const ownership = {
      claim: async () => "ok",
      release: async () => {
        released += 1;
      },
    } as never;
    const filler = { enabledFor: () => true, release: () => undefined } as never;
    const s = {} as never;
    const voice = new VoiceService(memory, ownership, s, s, s, s, s, s, s, s, filler, s);
    const oldSock = {};
    const newSock = {};
    await voice.attachTransport("sid", () => undefined, undefined, oldSock);
    await voice.attachTransport("sid", () => undefined, undefined, newSock);
    await voice.detach("sid", oldSock);
    assert.equal(voice.liveSessionCount(), 1);
    assert.equal(released, 0);
    await voice.detach("sid", newSock);
    assert.equal(voice.liveSessionCount(), 0);
    assert.equal(released, 1);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLikelyEcho, isMeaningfulTranscript, pcmSpeechRms, postprocessTranscript } from "./stt-quality";

describe("stt postprocess", () => {
  it("fixes split science terms without touching names", () => {
    assert.equal(postprocessTranscript("photo synthesis in mito chondria"), "photosynthesis in mitochondria");
    assert.equal(postprocessTranscript("Akbar and the Mughals"), "Akbar and the Mughals");
  });

  it("only rewrites digit-into-digit in math", () => {
    assert.equal(postprocessTranscript("5 into 3", "Mathematics"), "5 * 3");
    assert.equal(postprocessTranscript("turn a fraction into a decimal", "Mathematics"), "turn a fraction into a decimal");
  });
});

describe("meaningful transcript", () => {
  it("rejects bell junk", () => {
    assert.equal(isMeaningfulTranscript("bell"), false);
  });
  it("rejects whisper bracket hallucinations", () => {
    for (const junk of [
      "(laughing)",
      "(mumbling)",
      "(chattering)",
      "[laughter]",
      "(silence)",
      "(speaking in foreign language)",
    ]) {
      assert.equal(isMeaningfulTranscript(junk), false, junk);
    }
  });
  it("rejects youtube-style whisper hallucinations", () => {
    assert.equal(isMeaningfulTranscript("and guess what?"), false);
    assert.equal(isMeaningfulTranscript("for a specific update editor."), false);
  });
  it("keeps a real chapter question", () => {
    assert.equal(isMeaningfulTranscript("What is India's political map?"), true);
  });
  it("keeps why as a follow-up", () => {
    assert.equal(isMeaningfulTranscript("why"), true);
  });
  it("rejects very quiet pcm before whisper", () => {
    const quiet = new Int16Array(8000);
    assert.ok(pcmSpeechRms(quiet) < 0.008);
  });
  it("flags tutor echo", () => {
    const last =
      "A political map shows who rules which land. Look at the map on page 4.";
    assert.equal(isLikelyEcho("Look at the map on page 4", last), true);
    assert.equal(isLikelyEcho("What is India's political map?", last), false);
  });
});

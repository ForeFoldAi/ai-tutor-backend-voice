import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allFillerPhrases,
  clipDurationMs,
  fillerAllowed,
  FILLER_PHRASES,
  FillerIntent,
  inFillerCohort,
  median,
  pickPhraseIndex,
  shouldArmFiller,
} from "./thinking-filler.service";

const INTENTS = Object.keys(FILLER_PHRASES) as FillerIntent[];

describe("filler rotation", () => {
  it("never repeats the same phrase twice in a row", () => {
    for (const intent of INTENTS) {
      let last = -1;
      for (let turn = 0; turn < 24; turn++) {
        const next = pickPhraseIndex(FILLER_PHRASES[intent].length, last);
        assert.notEqual(next, last, `${intent} turn ${turn} repeated index ${next}`);
        last = next;
      }
    }
  });

  it("starts at the first phrase and wraps around", () => {
    assert.equal(pickPhraseIndex(2, -1), 0);
    assert.equal(pickPhraseIndex(2, 1), 0);
  });

  it("degrades safely for an empty or single-phrase library", () => {
    assert.equal(pickPhraseIndex(0, -1), -1);
    assert.equal(pickPhraseIndex(1, 0), 0);
  });
});

describe("filler phrase library", () => {
  it("covers every intent with at least two phrases", () => {
    for (const intent of INTENTS) {
      assert.ok(FILLER_PHRASES[intent].length >= 2, `${intent} cannot rotate`);
    }
    assert.ok(INTENTS.includes("general"), "general is the fallback and must exist");
  });

  it("keeps phrases short and speakable", () => {
    for (const phrase of allFillerPhrases()) {
      assert.ok(phrase.length <= 60, `too long to stay under the duration cap: ${phrase}`);
      // Markdown would be read aloud literally by the TTS providers.
      assert.doesNotMatch(phrase, /[*#_]/, `markdown in phrase: ${phrase}`);
    }
  });

  it("has no duplicates, so the warm cache holds one clip per phrase", () => {
    const flat = Object.values(FILLER_PHRASES).flat();
    assert.equal(allFillerPhrases().length, flat.length);
  });
});

describe("filler gating", () => {
  it("is skipped when disabled", () => {
    assert.equal(fillerAllowed({ enabled: false, used: 0, max: 20 }), false);
  });

  it("is skipped once the per-session cap is reached", () => {
    assert.equal(fillerAllowed({ enabled: true, used: 19, max: 20 }), true);
    assert.equal(fillerAllowed({ enabled: true, used: 20, max: 20 }), false);
    assert.equal(fillerAllowed({ enabled: true, used: 21, max: 20 }), false);
  });
});

describe("adaptive arming", () => {
  it("arms until there is enough evidence", () => {
    assert.equal(shouldArmFiller([], 700), true);
    assert.equal(shouldArmFiller([100, 120], 700), true);
  });

  it("stops arming for a session whose answers beat the delay", () => {
    assert.equal(shouldArmFiller([200, 250, 180, 300], 700), false);
  });

  it("keeps arming for a slow session", () => {
    assert.equal(shouldArmFiller([3000, 4200, 2800], 700), true);
  });

  it("uses the median so one outlier cannot flip the decision", () => {
    assert.equal(median([100, 200, 9000]), 200);
    assert.equal(shouldArmFiller([100, 200, 9000], 700), false);
  });
});

describe("A/B cohort", () => {
  it("includes everyone at rate 1 and nobody at rate 0", () => {
    assert.equal(inFillerCohort("student-1", 1), true);
    assert.equal(inFillerCohort("student-1", 0), false);
  });

  it("is stable for a given student", () => {
    const first = inFillerCohort("student-42", 0.5);
    for (let i = 0; i < 5; i++) assert.equal(inFillerCohort("student-42", 0.5), first);
  });

  it("splits roughly evenly at 0.5", () => {
    let inCohort = 0;
    for (let i = 0; i < 1000; i++) if (inFillerCohort(`student-${i}`, 0.5)) inCohort += 1;
    assert.ok(inCohort > 400 && inCohort < 600, `skewed split: ${inCohort}/1000`);
  });
});

describe("clip duration", () => {
  it("converts a 16kHz sample count to milliseconds", () => {
    assert.equal(clipDurationMs(16000), 1000);
    assert.equal(clipDurationMs(8000), 500);
    assert.equal(clipDurationMs(0), 0);
  });

  it("drives the max-duration check used at warm time", () => {
    // 3s of 16kHz audio is over a 2500ms cap and must be dropped, not clipped.
    assert.ok(clipDurationMs(48000) > 2500);
  });
});

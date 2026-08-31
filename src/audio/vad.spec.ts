import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SILERO_WINDOW, SileroVad } from "./vad";

function pcm(n: number): Int16Array {
  return new Int16Array(n).fill(1000);
}

describe("SileroVad", () => {
  it("emits start then stop around hangMs", async () => {
    let p = 0;
    const vad = new SileroVad({
      hangMs: 50,
      infer: async (_frame, state) => ({ p, state }),
    });
    p = 0.9;
    assert.deepEqual(await vad.push(pcm(SILERO_WINDOW), 0), ["start"]);
    p = 0.1;
    assert.deepEqual(await vad.push(pcm(SILERO_WINDOW), 20), ["speech"]);
    assert.deepEqual(await vad.push(pcm(SILERO_WINDOW), 80), ["stop"]);
  });
});

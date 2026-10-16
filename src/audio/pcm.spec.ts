import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { floatToInt16, int16ToFloat, int16ToWav, packPcm, unpackPcm } from "./pcm";

describe("pcm framing", () => {
  it("wraps pcm in a valid wav header", () => {
    const wav = int16ToWav(new Int16Array([1, -2, 3]), 16000);
    assert.equal(wav.length, 44 + 6);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt32LE(40), 6);
    assert.equal(wav.readInt16LE(46), -2);
  });

  it("round-trips int16 samples", () => {
    const src = floatToInt16(new Float32Array([0, 0.5, -0.5]));
    const buf = packPcm(src, 16000, true);
    const { samples, sampleRate, end } = unpackPcm(buf);
    assert.equal(sampleRate, 16000);
    assert.equal(end, true);
    assert.equal(samples.length, src.length);
    assert.ok(Math.abs(int16ToFloat(samples)[1] - 0.5) < 0.01);
  });

  it("unpacks ws slices with odd byteOffset", () => {
    const src = floatToInt16(new Float32Array([0.25, -0.25]));
    const frame = packPcm(src, 16000, false);
    const padded = Buffer.alloc(frame.length + 1);
    frame.copy(padded, 1);
    const { samples, sampleRate } = unpackPcm(padded.subarray(1));
    assert.equal(sampleRate, 16000);
    assert.equal(samples.length, src.length);
  });
});

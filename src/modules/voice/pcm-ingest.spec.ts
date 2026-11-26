import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPcmIngest, finishPcm, invalidatePcm, offerPcm, takeLatest } from "./pcm-ingest";

const frame = (n: number) => Buffer.from([n]);

describe("pcm ingest", () => {
  it("keeps only the newest frame while one inference is in flight", () => {
    const q = createPcmIngest();
    assert.equal(offerPcm(q, frame(1)), true);
    assert.equal(offerPcm(q, frame(2)), false);
    assert.equal(offerPcm(q, frame(3)), false);
    assert.equal(takeLatest(q)?.[0], 3);
    assert.equal(takeLatest(q), null);
  });

  it("drops audio queued before an interrupt", () => {
    const q = createPcmIngest();
    offerPcm(q, frame(1));
    offerPcm(q, frame(2));
    const epoch = q.epoch;
    invalidatePcm(q);
    assert.notEqual(q.epoch, epoch);
    assert.equal(q.latest, null);
  });

  it("hands a frame that arrived at the end of a drain back to the caller", () => {
    const q = createPcmIngest();
    offerPcm(q, frame(1));
    q.latest = frame(4);
    const pending = finishPcm(q);
    assert.equal(pending?.[0], 4);
    assert.equal(q.busy, false);
    assert.equal(offerPcm(q, pending!), true);
  });
});
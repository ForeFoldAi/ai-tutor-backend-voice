/**
 * Mic audio waiting on Silero. Inference is often slower than realtime on a
 * long call; queueing every frame leaves the student's latest words — and
 * barge-in — stuck behind minutes of old audio. One frame is inferred at a
 * time and only the newest waiting frame is kept.
 */
export type PcmIngest = {
  busy: boolean;
  latest: Buffer | null;
  /** Bumped on an audible interrupt so audio already queued is not transcribed. */
  epoch: number;
};

export function createPcmIngest(): PcmIngest {
  return { busy: false, latest: null, epoch: 0 };
}

/** @returns true when the caller should start draining with this buffer. */
export function offerPcm(q: PcmIngest, buf: Buffer): boolean {
  if (q.busy) {
    q.latest = buf;
    return false;
  }
  q.busy = true;
  return true;
}

export function takeLatest(q: PcmIngest): Buffer | null {
  const buf = q.latest;
  q.latest = null;
  return buf;
}

/** Drop audio captured before an interrupt. The client resends the words that cut in. */
export function invalidatePcm(q: PcmIngest): void {
  q.epoch += 1;
  q.latest = null;
}

/** Mark the drain finished. A frame that arrived as we stopped is returned to be restarted. */
export function finishPcm(q: PcmIngest): Buffer | null {
  const buf = q.latest;
  q.latest = null;
  q.busy = false;
  return buf;
}

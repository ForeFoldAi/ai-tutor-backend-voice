/**
 * Ordered speech emit with overlapping TTS synthesis.
 *
 * Kick off synthesize for unit N+1 before awaiting/emitting unit N so Edge RTT
 * does not open a silent gap after short sentences.
 */

export type PreparedSpeech = {
  say: string;
  pcm: Float32Array;
  sampleRate: number;
};

/**
 * Walk `items` in order. For each index, start synthesizing the next item
 * before awaiting the current one (depth-1 prefetch).
 *
 * `visit` returning false stops the loop; already-started prefetch work is
 * left to the caller to ignore via its own cancel checks.
 */
export async function forEachWithPrefetch<T, R>(
  items: T[],
  start: (item: T, index: number) => Promise<R>,
  visit: (prepared: R, item: T, index: number) => Promise<boolean>,
): Promise<void> {
  let pending: Promise<R> | null = null;
  for (let i = 0; i < items.length; i++) {
    const current = pending ?? start(items[i], i);
    pending = i + 1 < items.length ? start(items[i + 1], i + 1) : null;
    const prepared = await current;
    if (!(await visit(prepared, items[i], i))) return;
  }
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forEachWithPrefetch } from "./speech-prefetch";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("forEachWithPrefetch", () => {
  it("starts the next synth before awaiting the current one", async () => {
    const started: number[] = [];
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()];

    const run = forEachWithPrefetch(
      [0, 1, 2],
      async (item) => {
        started.push(item);
        return gates[item].promise;
      },
      async () => true,
    );

    await flush();
    assert.deepEqual(started, [0, 1], "N+1 must start before N resolves");

    gates[0].resolve(0);
    await flush();
    assert.ok(started.includes(2), "N+2 arms once the loop advances past N");

    gates[1].resolve(1);
    gates[2].resolve(2);
    await run;
    assert.deepEqual(started, [0, 1, 2]);
  });

  it("stops visiting after visit returns false and keeps emit order until then", async () => {
    const visited: number[] = [];
    await forEachWithPrefetch(
      [1, 2, 3],
      async (item) => item,
      async (prepared) => {
        visited.push(prepared);
        return prepared < 2;
      },
    );
    assert.deepEqual(visited, [1, 2]);
  });

  it("preserves visit order even when later synth finishes first", async () => {
    const visited: number[] = [];
    const gates = [deferred<number>(), deferred<number>()];

    const run = forEachWithPrefetch(
      [0, 1],
      async (item) => gates[item].promise,
      async (prepared) => {
        visited.push(prepared);
        return true;
      },
    );

    await flush();
    gates[1].resolve(1);
    gates[0].resolve(0);
    await run;
    assert.deepEqual(visited, [0, 1]);
  });
});

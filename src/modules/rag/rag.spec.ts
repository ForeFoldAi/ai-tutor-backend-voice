import { RagClient, collectionName } from "./rag.client";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { RagAskOptions } from "./rag.client";

const ASK_OPTS: RagAskOptions = {
  token: "test-token",
  query: "Can you tell me about India's political map?",
  scope: {
    board: "CBSE",
    classLevel: "CLASS_8",
    subject: "Social Science",
    chapterIds: ["ch-1"],
    chapterNames: ["India's political map"],
    chapter: "India's political map",
  },
  history: [],
};

function ndjsonResponse(lines: object[]): Response {
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  } as Response;
}

describe("RAG collection filter", () => {
  it("matches existing FastAPI naming: board_class_subject", () => {
    assert.equal(collectionName("CBSE", "CLASS_8", "Science"), "CBSE_CLASS_8_Science");
  });
  it("strips spaces in subject", () => {
    assert.equal(
      collectionName("CBSE", "CLASS_7", "Social Science"),
      "CBSE_CLASS_7_Social_Science",
    );
  });
});

describe("RagClient askStream", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("forwards related_images payloads to handlers and result", async () => {
    const images = [
      {
        url: "/auth/catalog/textbook-images/u1/fig_2_3.png",
        caption: "Political map snapshot",
        page: 14,
        figure_number: "2.3",
        textbook_upload_id: "u1",
        file_name: "fig_2_3.png",
      },
      {
        url: "/auth/catalog/textbook-images/u1/fig_2_12.png",
        caption: "Another political map",
        page: 22,
        figure_number: "2.12",
        textbook_upload_id: "u1",
        file_name: "fig_2_12.png",
      },
    ];
    global.fetch = async () =>
      ndjsonResponse([
        { type: "related_images", images },
        { type: "token", content: "India's political map changed over time." },
        { type: "done" },
      ]);

    const client = new RagClient();
    const batches: unknown[][] = [];
    const result = await client.askStream(ASK_OPTS, {
      onRelatedImages: (imgs) => batches.push(imgs),
    });

    assert.equal(batches.length, 1);
    assert.equal(result.images.length, 2);
    assert.equal(result.images[0].figure_number, "2.3");
    assert.equal(result.images[1].figure_number, "2.12");
    assert.match(result.answer, /political map changed/i);
    assert.ok(result.retrievedIds.length >= 2);
    assert.deepEqual(result.pages, [14, 22]);
  });

  it("replaces images when a later related_images event arrives", async () => {
    const early = [
      { url: "/auth/catalog/u/a.png", caption: "early", page: 1, figure_number: "2.3" },
    ];
    const final = [
      { url: "/auth/catalog/u/a.png", caption: "early", page: 1, figure_number: "2.3" },
      { url: "/auth/catalog/u/b.png", caption: "final", page: 2, figure_number: "2.12" },
    ];
    global.fetch = async () =>
      ndjsonResponse([
        { type: "related_images", images: early },
        { type: "token", content: "Hello. " },
        { type: "related_images", images: final },
        { type: "token", content: "World." },
        { type: "done" },
      ]);

    const client = new RagClient();
    let emitCount = 0;
    const result = await client.askStream(ASK_OPTS, {
      onRelatedImages: () => {
        emitCount += 1;
      },
    });

    assert.equal(emitCount, 2);
    assert.equal(result.images.length, 2);
    assert.equal(result.images[1].figure_number, "2.12");
  });
});

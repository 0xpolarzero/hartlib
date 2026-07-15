import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { PdfTextExtractor, PdfTextExtractorLive } from "./pdf-text";

const fixtureUrl = new URL(
  "../../../demo/public/demo/pdfs/atlas-regfin-2026-06-17.pdf",
  import.meta.url,
);

describe("live PDF text extraction", () => {
  it("extracts ordered, non-empty pages from a real PDF", async () => {
    const bytes = new Uint8Array(await Bun.file(fixtureUrl).arrayBuffer());
    const pages = await Effect.runPromise(
      Effect.gen(function* () {
        const extractor = yield* PdfTextExtractor;
        return yield* extractor.extract(bytes);
      }).pipe(Effect.provide(PdfTextExtractorLive)),
    );

    expect(pages.length).toBeGreaterThan(0);
    expect(pages.map((page) => page.pageNumber)).toEqual(
      pages.map((page) => page.pageNumber).toSorted((left, right) => left - right),
    );
    expect(pages.some((page) => page.text.trim().length > 100)).toBe(true);
  });
});

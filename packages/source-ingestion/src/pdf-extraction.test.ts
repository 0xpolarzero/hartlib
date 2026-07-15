import { describe, expect, it } from "vitest";

import { extractPdfPagesIsolated, PdfExtractionError } from "./pdf-extraction";

const fixtureUrl = new URL(
  "../../../apps/demo/public/demo/pdfs/atlas-regfin-2026-06-17.pdf",
  import.meta.url,
);

const fixtureBytes = async (): Promise<Uint8Array> =>
  new Uint8Array(await Bun.file(fixtureUrl).arrayBuffer());

describe("isolated PDF extraction", () => {
  it("extracts ordered pages without detaching or mutating the canonical bytes", async () => {
    const bytes = await fixtureBytes();
    const before = Uint8Array.from(bytes);

    const pages = await extractPdfPagesIsolated(bytes);

    expect(pages.length).toBeGreaterThan(0);
    expect(pages.map((page) => page.pageNumber)).toEqual(
      Array.from({ length: pages.length }, (_unused, index) => index + 1),
    );
    expect(pages.some((page) => page.text.trim().length > 100)).toBe(true);
    expect(bytes).toEqual(before);
  });

  it("enforces input and extracted-text ceilings before returning parser output", async () => {
    const bytes = await fixtureBytes();

    await expect(
      extractPdfPagesIsolated(bytes, { maxInputBytes: bytes.byteLength - 1 }),
    ).rejects.toMatchObject({ code: "pdf_input_too_large" });
    await expect(extractPdfPagesIsolated(bytes, { maxCharacters: 32 })).rejects.toMatchObject({
      code: "pdf_text_limit_exceeded",
    });
  });

  it("terminates a parser that exceeds its wall-clock deadline", async () => {
    const bytes = await fixtureBytes();

    await expect(extractPdfPagesIsolated(bytes, { timeoutMs: 1 })).rejects.toMatchObject({
      code: "pdf_extraction_timeout",
    });
  });

  it("returns only a content-free failure code for malformed parser input", async () => {
    const bytes = new TextEncoder().encode("%PDF-not-a-valid-document-secret-marker");

    await expect(extractPdfPagesIsolated(bytes)).rejects.toEqual(
      new PdfExtractionError("pdf_extraction_failed"),
    );
  });
});

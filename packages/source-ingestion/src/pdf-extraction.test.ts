import { describe, expect, it } from "vitest";

import { extractPdfPagesIsolated, PdfExtractionError } from "./pdf-extraction";

const fixtureUrl = new URL(
  "../../../apps/demo/public/demo/pdfs/atlas-regfin-2026-06-17.pdf",
  import.meta.url,
);

const fixtureBytes = async (): Promise<Uint8Array> =>
  new Uint8Array(await Bun.file(fixtureUrl).arrayBuffer());
const blankTwoPagePdf = (): Uint8Array => {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  bodies.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const crossReferenceOffset = pdf.length;
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  pdf += `${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join("\n")}\n`;
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${crossReferenceOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};

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

  it("uses native position-aware plain text in source order", async () => {
    const pages = await extractPdfPagesIsolated(await fixtureBytes());
    const text = pages[0]?.text ?? "";

    expect(text).toContain("Reglementation financiere - Brief hebdomadaire");
    expect(text.indexOf("Documentation client")).toBeGreaterThan(
      text.indexOf("Semaine du 17 juin 2026"),
    );
    expect(text).not.toMatch(/^#/m);
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

  it("enforces the page ceiling and preserves empty scanned pages", async () => {
    const bytes = blankTwoPagePdf();
    const before = Uint8Array.from(bytes);

    await expect(extractPdfPagesIsolated(bytes, { maxPages: 1 })).rejects.toMatchObject({
      code: "pdf_page_limit_exceeded",
    });
    const pages = await extractPdfPagesIsolated(bytes);

    expect(pages).toEqual([
      { pageNumber: 1, text: "" },
      { pageNumber: 2, text: "" },
    ]);
    expect(bytes).toEqual(before);
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

  it("rejects empty input before starting a child", async () => {
    await expect(extractPdfPagesIsolated(new Uint8Array())).rejects.toEqual(
      new PdfExtractionError("pdf_input_too_large"),
    );
  });
});

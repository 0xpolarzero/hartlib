import { classifyPdf, extractTextWithPositions } from "@firecrawl/pdf-inspector";

type FailureCode =
  | "pdf_input_too_large"
  | "pdf_page_limit_exceeded"
  | "pdf_text_limit_exceeded"
  | "pdf_page_shape_invalid"
  | "pdf_extraction_failed";

const failure = (code: FailureCode): { readonly ok: false; readonly code: FailureCode } => ({
  ok: false,
  code,
});

const parsedLimits = process.argv.slice(2).map(Number);
const validLimits =
  parsedLimits.length === 3 &&
  parsedLimits.every((value) => Number.isSafeInteger(value) && value > 0);
const maxInputBytes = validLimits ? parsedLimits[0]! : 0;
const maxPages = validLimits ? parsedLimits[1]! : 0;
const maxCharacters = validLimits ? parsedLimits[2]! : 0;

const nativePositionPageToPublicNumber = (
  nativePageNumber: number,
  pageCount: number,
): number | undefined => {
  // Position items use one-based pages; normalize through a zero-based index
  // before returning the public one-based page number.
  const nativePageIndex = nativePageNumber - 1;
  return Number.isSafeInteger(nativePageIndex) &&
    nativePageIndex >= 0 &&
    nativePageIndex < pageCount
    ? nativePageIndex + 1
    : undefined;
};

const readInput = async (): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk);
    size += value.byteLength;
    if (size > maxInputBytes) {
      throw new Error("input limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
};

const main = async (): Promise<unknown> => {
  if (!validLimits) return failure("pdf_extraction_failed");
  const bytes = await readInput();
  if (bytes.byteLength < 5 || bytes.byteLength > maxInputBytes) {
    return failure("pdf_input_too_large");
  }

  const classification = classifyPdf(bytes);
  if (!Number.isSafeInteger(classification.pageCount) || classification.pageCount < 1) {
    return failure("pdf_page_shape_invalid");
  }
  if (classification.pageCount > maxPages) return failure("pdf_page_limit_exceeded");

  // Other native APIs use zero-based page selectors; this position API reports
  // one-based pages, so its index is normalized explicitly below.
  const items = extractTextWithPositions(bytes);
  if (!Array.isArray(items)) return failure("pdf_page_shape_invalid");
  const texts = Array.from({ length: classification.pageCount }, () => [] as string[]);
  for (const item of items) {
    if (typeof item !== "object" || item === null || typeof item.page !== "number") {
      return failure("pdf_page_shape_invalid");
    }
    const pageNumber = nativePositionPageToPublicNumber(item.page, classification.pageCount);
    if (pageNumber === undefined) {
      return failure("pdf_page_shape_invalid");
    }
    if (item.itemType !== "Image") {
      if (typeof item.text !== "string") return failure("pdf_page_shape_invalid");
      texts[pageNumber - 1]?.push(item.text);
    }
  }

  let characterCount = 0;
  const pages = texts.map((parts, index) => {
    const text = parts.join("\n");
    characterCount += text.length + (index === 0 ? 0 : 2);
    if (characterCount > maxCharacters) throw new Error("text limit");
    return { pageNumber: index + 1, text };
  });
  return { ok: true, pages };
};

try {
  const result = await main();
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(
    JSON.stringify(
      error instanceof Error && error.message === "text limit"
        ? failure("pdf_text_limit_exceeded")
        : error instanceof Error && error.message === "input limit"
          ? failure("pdf_input_too_large")
          : failure("pdf_extraction_failed"),
    ),
  );
}

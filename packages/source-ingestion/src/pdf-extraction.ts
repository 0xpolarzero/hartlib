import { Worker } from "node:worker_threads";

export const PDF_EXTRACTION_MAX_INPUT_BYTES = 50 * 1024 * 1024;
export const PDF_EXTRACTION_MAX_PAGES = 2_000;
export const PDF_EXTRACTION_MAX_CHARACTERS = 10_000_000;
export const PDF_EXTRACTION_TIMEOUT_MS = 30_000;

const PDF_EXTRACTION_MAX_OLD_GENERATION_MB = 256;
const PDF_EXTRACTION_MAX_YOUNG_GENERATION_MB = 64;
const pdfParseModuleUrl = new URL(
  "../node_modules/pdf-parse/dist/pdf-parse/esm/index.js",
  import.meta.url,
).href;

export interface IsolatedExtractedPdfPage {
  readonly pageNumber: number;
  readonly text: string;
}

export type PdfExtractionErrorCode =
  | "pdf_input_too_large"
  | "pdf_page_limit_exceeded"
  | "pdf_text_limit_exceeded"
  | "pdf_page_shape_invalid"
  | "pdf_extraction_timeout"
  | "pdf_extraction_failed";

export class PdfExtractionError extends Error {
  readonly name = "PdfExtractionError";

  constructor(readonly code: PdfExtractionErrorCode) {
    super(code);
  }
}

interface PdfExtractionLimits {
  readonly maxInputBytes: number;
  readonly maxPages: number;
  readonly maxCharacters: number;
  readonly timeoutMs: number;
}

/** Test-only reductions are accepted, but no caller can raise a production ceiling. */
export type PdfExtractionLimitReductions = Partial<PdfExtractionLimits>;

const positiveBoundedInteger = (value: number | undefined, maximum: number): number =>
  value === undefined || !Number.isSafeInteger(value) || value <= 0
    ? maximum
    : Math.min(value, maximum);

const extractionLimits = (reductions?: PdfExtractionLimitReductions): PdfExtractionLimits => ({
  maxInputBytes: positiveBoundedInteger(reductions?.maxInputBytes, PDF_EXTRACTION_MAX_INPUT_BYTES),
  maxPages: positiveBoundedInteger(reductions?.maxPages, PDF_EXTRACTION_MAX_PAGES),
  maxCharacters: positiveBoundedInteger(reductions?.maxCharacters, PDF_EXTRACTION_MAX_CHARACTERS),
  timeoutMs: positiveBoundedInteger(reductions?.timeoutMs, PDF_EXTRACTION_TIMEOUT_MS),
});

const workerSource = String.raw`
const { parentPort, workerData } = require("node:worker_threads");

const failure = (code) => ({ ok: false, code });

void (async () => {
  let parser;
  let response;
  try {
    const { PDFParse } = await import(workerData.pdfParseModuleUrl);
    const bytes = new Uint8Array(workerData.bytes);
    if (bytes.byteLength < 5 || bytes.byteLength > workerData.maxInputBytes) {
      response = failure("pdf_input_too_large");
    } else {
      parser = new PDFParse({ data: bytes });
      const info = await parser.getInfo();
      if (!Number.isSafeInteger(info.total) || info.total < 1) {
        response = failure("pdf_page_shape_invalid");
      } else if (info.total > workerData.maxPages) {
        response = failure("pdf_page_limit_exceeded");
      } else {
        const result = await parser.getText();
        if (!Array.isArray(result.pages) || result.pages.length !== info.total) {
          response = failure("pdf_page_shape_invalid");
        } else {
          const pages = [];
          let characterCount = 0;
          for (let index = 0; index < result.pages.length; index += 1) {
            const page = result.pages[index];
            const expectedPageNumber = index + 1;
            if (page?.num !== expectedPageNumber || typeof page.text !== "string") {
              response = failure("pdf_page_shape_invalid");
              break;
            }
            characterCount += page.text.length + (index === 0 ? 0 : 2);
            if (characterCount > workerData.maxCharacters) {
              response = failure("pdf_text_limit_exceeded");
              break;
            }
            pages.push({ pageNumber: page.num, text: page.text });
          }
          response ??= { ok: true, pages };
        }
      }
    }
  } catch {
    response = failure("pdf_extraction_failed");
  } finally {
    if (parser !== undefined) {
      try {
        await parser.destroy();
      } catch {
        response = failure("pdf_extraction_failed");
      }
    }
  }
  parentPort.postMessage(response ?? failure("pdf_extraction_failed"));
})().catch(() => parentPort.postMessage(failure("pdf_extraction_failed")));
`;

const isExtractionErrorCode = (value: unknown): value is PdfExtractionErrorCode =>
  value === "pdf_input_too_large" ||
  value === "pdf_page_limit_exceeded" ||
  value === "pdf_text_limit_exceeded" ||
  value === "pdf_page_shape_invalid" ||
  value === "pdf_extraction_timeout" ||
  value === "pdf_extraction_failed";

const decodeWorkerPages = (
  value: unknown,
  limits: PdfExtractionLimits,
): readonly IsolatedExtractedPdfPage[] => {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    throw new PdfExtractionError("pdf_extraction_failed");
  }
  const result = value as {
    readonly ok: unknown;
    readonly code?: unknown;
    readonly pages?: unknown;
  };
  if (result.ok !== true) {
    throw new PdfExtractionError(
      isExtractionErrorCode(result.code) ? result.code : "pdf_extraction_failed",
    );
  }
  if (!Array.isArray(result.pages) || result.pages.length < 1) {
    throw new PdfExtractionError("pdf_page_shape_invalid");
  }
  if (result.pages.length > limits.maxPages) {
    throw new PdfExtractionError("pdf_page_limit_exceeded");
  }
  let characterCount = 0;
  return result.pages.map((candidate, index) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("pageNumber" in candidate) ||
      !("text" in candidate)
    ) {
      throw new PdfExtractionError("pdf_page_shape_invalid");
    }
    const page = candidate as { readonly pageNumber: unknown; readonly text: unknown };
    if (page.pageNumber !== index + 1 || typeof page.text !== "string") {
      throw new PdfExtractionError("pdf_page_shape_invalid");
    }
    characterCount += page.text.length + (index === 0 ? 0 : 2);
    if (characterCount > limits.maxCharacters) {
      throw new PdfExtractionError("pdf_text_limit_exceeded");
    }
    return { pageNumber: page.pageNumber, text: page.text };
  });
};

/**
 * Parse untrusted PDFs off the main worker thread. The private byte copy keeps
 * the caller's canonical bytes intact, while timeout and heap ceilings can
 * terminate a parser that hangs or expands hostile content excessively.
 */
export const extractPdfPagesIsolated = (
  bytes: Uint8Array,
  reductions?: PdfExtractionLimitReductions,
): Promise<readonly IsolatedExtractedPdfPage[]> => {
  const limits = extractionLimits(reductions);
  if (bytes.byteLength < 5 || bytes.byteLength > limits.maxInputBytes) {
    return Promise.reject(new PdfExtractionError("pdf_input_too_large"));
  }
  const privateBytes = Uint8Array.from(bytes);
  const buffer = privateBytes.buffer;

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { bytes: buffer, pdfParseModuleUrl, ...limits },
      transferList: [buffer],
      resourceLimits: {
        maxOldGenerationSizeMb: PDF_EXTRACTION_MAX_OLD_GENERATION_MB,
        maxYoungGenerationSizeMb: PDF_EXTRACTION_MAX_YOUNG_GENERATION_MB,
        stackSizeMb: 8,
      },
    });
    let settled = false;
    const finish = (
      outcome:
        | { readonly ok: true; readonly pages: readonly IsolatedExtractedPdfPage[] }
        | { readonly ok: false; readonly error: PdfExtractionError },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.removeAllListeners();
      void worker.terminate();
      if (outcome.ok) resolve(outcome.pages);
      else reject(outcome.error);
    };
    const timeout = setTimeout(
      () => finish({ ok: false, error: new PdfExtractionError("pdf_extraction_timeout") }),
      limits.timeoutMs,
    );
    worker.once("message", (message: unknown) => {
      try {
        finish({ ok: true, pages: decodeWorkerPages(message, limits) });
      } catch (error) {
        finish({
          ok: false,
          error:
            error instanceof PdfExtractionError
              ? error
              : new PdfExtractionError("pdf_extraction_failed"),
        });
      }
    });
    worker.once("error", () =>
      finish({ ok: false, error: new PdfExtractionError("pdf_extraction_failed") }),
    );
    worker.once("exit", () =>
      finish({ ok: false, error: new PdfExtractionError("pdf_extraction_failed") }),
    );
  });
};

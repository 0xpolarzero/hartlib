import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

export const PDF_EXTRACTION_MAX_INPUT_BYTES = 50 * 1024 * 1024;
export const PDF_EXTRACTION_MAX_PAGES = 2_000;
export const PDF_EXTRACTION_MAX_CHARACTERS = 10_000_000;
export const PDF_EXTRACTION_TIMEOUT_MS = 30_000;

/** Linux child-process address-space limit. The native parser is not loaded in the parent. */
export const PDF_EXTRACTION_MAX_MEMORY_MB = 384;
const PDF_EXTRACTION_MAX_OUTPUT_BYTES = 80 * 1024 * 1024;
const childModulePath = fileURLToPath(new URL("./pdf-extraction-child.ts", import.meta.url));

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

const isExtractionErrorCode = (value: unknown): value is PdfExtractionErrorCode =>
  value === "pdf_input_too_large" ||
  value === "pdf_page_limit_exceeded" ||
  value === "pdf_text_limit_exceeded" ||
  value === "pdf_page_shape_invalid" ||
  value === "pdf_extraction_timeout" ||
  value === "pdf_extraction_failed";

const decodeChildPages = (
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

const limitedCommand = (limits: PdfExtractionLimits): readonly [string, readonly string[]] => {
  const args = [
    childModulePath,
    String(limits.maxInputBytes),
    String(limits.maxPages),
    String(limits.maxCharacters),
  ];
  if (process.platform !== "linux") {
    return [process.execPath, args];
  }

  // The command is fixed; all paths and limits are positional, quoted by the shell.
  // Linux ulimit applies RLIMIT_AS to the native parser process, including Rust/N-API memory.
  return [
    "/bin/sh",
    [
      "-c",
      'ulimit -v "$1" || exit 125; shift; exec "$@"',
      "brief-pdf-extraction",
      String(PDF_EXTRACTION_MAX_MEMORY_MB * 1024),
      process.execPath,
      ...args,
    ],
  ];
};

const killChild = (child: ChildProcess): void => {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The child can exit between the state check and kill. The parent has
      // already selected the stable extraction error, so there is no new
      // failure to expose here.
    }
  }
};

/**
 * Parse untrusted PDFs in a killable child process. The child receives a private
 * byte copy and, on Linux, a process-level address-space limit for native memory.
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
  const [command, args] = limitedCommand(limits);
  const maxOutputBytes = Math.min(
    PDF_EXTRACTION_MAX_OUTPUT_BYTES,
    limits.maxCharacters * 8 + limits.maxPages * 64 + 1_024,
  );

  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      child = spawn(command, [...args], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      }) as ChildProcessByStdio<Writable, Readable, null>;
    } catch {
      reject(new PdfExtractionError("pdf_extraction_failed"));
      return;
    }

    let settled = false;
    let outputBytes = 0;
    const outputChunks: Buffer[] = [];
    const finish = (error?: PdfExtractionError): void => {
      if (settled) return;
      let pages: readonly IsolatedExtractedPdfPage[] | undefined;
      if (!error) {
        try {
          pages = decodeChildPages(
            JSON.parse(Buffer.concat(outputChunks).toString("utf8")),
            limits,
          );
        } catch (cause) {
          error =
            cause instanceof PdfExtractionError
              ? cause
              : new PdfExtractionError("pdf_extraction_failed");
        }
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        // Kill while the child error/close listeners are still attached. A
        // failed spawn or a late kill race may emit one more child error; the
        // settled guard keeps it harmless instead of turning it unhandled.
        killChild(child);
      }
      child.stdout.removeAllListeners();
      child.stdin.removeAllListeners();
      child.removeAllListeners();
      if (error) {
        reject(error);
      } else {
        resolve(pages as readonly IsolatedExtractedPdfPage[]);
      }
    };
    const timeout = setTimeout(
      () => finish(new PdfExtractionError("pdf_extraction_timeout")),
      limits.timeoutMs,
    );

    child.stdout.on("data", (chunk: Buffer | Uint8Array) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        finish(new PdfExtractionError("pdf_extraction_failed"));
        return;
      }
      outputChunks.push(Buffer.from(chunk));
    });
    child.stdout.once("error", () => finish(new PdfExtractionError("pdf_extraction_failed")));
    child.stdin.once("error", () => finish(new PdfExtractionError("pdf_extraction_failed")));
    child.once("error", () => finish(new PdfExtractionError("pdf_extraction_failed")));
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal !== null) {
        finish(new PdfExtractionError("pdf_extraction_failed"));
      }
    });
    // Wait for `close`, not `exit`: Node/Bun may emit `exit` before the child
    // stdout pipe has delivered its final bytes. Parsing on `exit` can turn a
    // valid response into a sporadic malformed-output failure.
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal !== null) {
        finish(new PdfExtractionError("pdf_extraction_failed"));
        return;
      }
      try {
        finish();
      } catch {
        finish(new PdfExtractionError("pdf_extraction_failed"));
      }
    });
    try {
      child.stdin.end(Buffer.from(privateBytes));
    } catch {
      finish(new PdfExtractionError("pdf_extraction_failed"));
    }
  });
};

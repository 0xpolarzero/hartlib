import { extractPdfPagesIsolated } from "@brief/source-ingestion";
import { Context, Effect, Layer } from "effect";

export interface ExtractedPdfPage {
  readonly pageNumber: number;
  readonly text: string;
}

export interface PdfTextExtractorShape {
  readonly extract: (bytes: Uint8Array) => Effect.Effect<readonly ExtractedPdfPage[], Error>;
}

export class PdfTextExtractor extends Context.Service<PdfTextExtractor, PdfTextExtractorShape>()(
  "brief/worker/PdfTextExtractor",
) {}

export const PdfTextExtractorLive = Layer.succeed(
  PdfTextExtractor,
  PdfTextExtractor.of({
    extract: (bytes) =>
      Effect.tryPromise({
        try: () => extractPdfPagesIsolated(bytes),
        catch: (cause) => new Error("failed to extract PDF text", { cause }),
      }),
  }),
);

export const makePdfTextExtractorLayer = (
  extract: PdfTextExtractorShape["extract"],
): Layer.Layer<PdfTextExtractor> =>
  Layer.succeed(PdfTextExtractor, PdfTextExtractor.of({ extract }));

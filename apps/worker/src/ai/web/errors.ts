export type WebBoundaryErrorCode =
  | "invalid_url"
  | "disallowed_domain"
  | "dns_resolution_failed"
  | "private_or_reserved_address"
  | "connected_address_mismatch"
  | "too_many_redirects"
  | "redirect_without_location"
  | "unsupported_content_type"
  | "pdf_extraction_failed"
  | "unsupported_content_encoding"
  | "invalid_response_encoding"
  | "response_too_large"
  | "fetch_timeout"
  | "transport_failure"
  | "provider_failure"
  | "invalid_provider_response"
  | "unsupported_policy"
  | "web_policy_revoked";

export class WebBoundaryError extends Error {
  readonly name = "WebBoundaryError";

  constructor(
    readonly code: WebBoundaryErrorCode,
    message: string,
    readonly retryable: boolean,
    _cause?: unknown,
    readonly operations: readonly {
      readonly kind: "search" | "fetch";
      readonly provider: "tinyfish" | "zai" | "brief_fetch";
      readonly outcome: "succeeded" | "empty" | "failed";
      readonly resultCount: number;
      readonly responseBytes: number;
      readonly durationMs: number;
      readonly errorCode?: WebBoundaryErrorCode | undefined;
    }[] = [],
  ) {
    super(message);
  }
}

export const toWebBoundaryError = (
  error: unknown,
  code: Extract<WebBoundaryErrorCode, "transport_failure" | "provider_failure">,
): WebBoundaryError =>
  error instanceof WebBoundaryError
    ? error
    : new WebBoundaryError(
        code,
        code === "provider_failure"
          ? "external web provider operation failed"
          : "external web transport failed",
        true,
      );

export const withFailureAccounting = (
  error: WebBoundaryError,
  operations: WebBoundaryError["operations"],
): WebBoundaryError =>
  new WebBoundaryError(error.code, error.message, error.retryable, undefined, operations);

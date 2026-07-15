export const JOB_EXECUTION_FAILED_CODE = "job_execution_failed";

const JOB_FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_]{2,127}$/u;
const trustedJobFailures = new WeakSet<object>();

/**
 * Marks a code-owned, content-free failure code as safe for the durable jobs table.
 * Never construct this from provider, transport, database, payload, or user text.
 */
export class TrustedJobFailure extends Error {
  readonly name = "TrustedJobFailure";

  constructor(readonly code: string) {
    super(code);
    if (!JOB_FAILURE_CODE_PATTERN.test(code)) {
      throw new TypeError("invalid_trusted_job_failure_code");
    }
    trustedJobFailures.add(this);
    Object.freeze(this);
  }
}

/** Generic failures are untrusted even when their message or `code` looks machine-readable. */
export const persistedJobFailureCode = (error: unknown): string =>
  error instanceof TrustedJobFailure && trustedJobFailures.has(error)
    ? error.code
    : JOB_EXECUTION_FAILED_CODE;

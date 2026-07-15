import { describe, expect, it } from "vitest";
import { JOB_EXECUTION_FAILED_CODE, persistedJobFailureCode, TrustedJobFailure } from "./failure";

describe("persisted job failure codes", () => {
  it("rejects every generic or forged code channel", () => {
    const channels: readonly unknown[] = [
      new Error("secret_api_key"),
      "secret_api_key",
      { code: "secret_api_key" },
      Object.assign(new Error("ignored"), { code: "secret_api_key" }),
      Object.create(TrustedJobFailure.prototype),
    ];

    for (const error of channels) {
      expect(persistedJobFailureCode(error)).toBe(JOB_EXECUTION_FAILED_CODE);
    }
  });

  it("preserves a valid explicitly trusted content-free code", () => {
    expect(persistedJobFailureCode(new TrustedJobFailure("provider_timeout"))).toBe(
      "provider_timeout",
    );
  });

  it("rejects malformed trusted codes before they reach persistence", () => {
    for (const code of ["x", "UPPER_CASE", "has-hyphen", `a${"b".repeat(128)}`]) {
      expect(() => new TrustedJobFailure(code)).toThrow("invalid_trusted_job_failure_code");
    }
  });

  it("property: code-shaped generic failures never persist while trusted codes round-trip", () => {
    let state = 0x5ec0de;
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_";
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    for (let sample = 0; sample < 1_000; sample += 1) {
      const length = 3 + (next() % 126);
      let code = String.fromCharCode(97 + (next() % 26));
      while (code.length < length) code += alphabet[next() % alphabet.length];

      expect(persistedJobFailureCode(new Error(code))).toBe(JOB_EXECUTION_FAILED_CODE);
      expect(persistedJobFailureCode(Object.assign(new Error("generic"), { code }))).toBe(
        JOB_EXECUTION_FAILED_CODE,
      );
      expect(persistedJobFailureCode(new TrustedJobFailure(code))).toBe(code);
    }
  });
});

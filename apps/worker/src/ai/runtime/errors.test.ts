import { describe, expect, it } from "vitest";

import {
  aiRuntimeFailureMetadata,
  aiRuntimeFailureMetadataFromDurableJson,
  aiRunErrorCodeForRole,
  AiRuntimeError,
  AI_RUN_ERROR_CODES,
  isAiRuntimeError,
  isAiRunErrorCode,
  isRetryableAiRunError,
  toAiRuntimeError,
} from "./errors";

describe("AI run error classification", () => {
  it("has one explicit retryability decision for every unique terminal code", () => {
    expect(new Set(AI_RUN_ERROR_CODES).size).toBe(AI_RUN_ERROR_CODES.length);
    for (const code of AI_RUN_ERROR_CODES) {
      expect(typeof isRetryableAiRunError(code)).toBe("boolean");
      expect(isAiRunErrorCode(code)).toBe(true);
    }
    expect(isAiRunErrorCode("arbitrary_provider_message")).toBe(false);
  });

  it("does not invite blind retries for deterministic budget defects", () => {
    expect(isRetryableAiRunError("context_plan_unfit")).toBe(false);
    expect(isRetryableAiRunError("context_budget_mismatch")).toBe(false);
    expect(isRetryableAiRunError("synthesis_budget_mismatch")).toBe(false);
    expect(isRetryableAiRunError("context_assembly_failed")).toBe(true);
  });

  it("keeps the canonical code at the durable serialized error boundary", () => {
    const error = new AiRuntimeError("answer_failed", "provider stream ended");
    expect(error.message).toBe("[answer_failed][retryable:true] provider stream ended");
  });

  it("does not retain provider payloads or causes when normalizing an unknown failure", () => {
    const secret = "provider payload with user content and sk-live-secret";
    const normalized = toAiRuntimeError(new Error(secret), "answer_failed");

    expect(normalized.message).toBe("[answer_failed][retryable:true] runtime boundary failed");
    expect("cause" in normalized).toBe(false);
    expect(JSON.stringify(normalized)).not.toContain(secret);
  });

  it("preserves AbortError cancellation instead of reclassifying it as a role failure", () => {
    const aborted = new Error("cancelled by Smithers");
    aborted.name = "AbortError";

    expect(toAiRuntimeError(aborted, "answer_failed")).toBe(aborted);
  });

  it("does not trust arbitrary status fields from unknown errors", () => {
    for (const error of [
      Object.assign(new Error("opaque"), { status: 401 }),
      Object.assign(new Error("opaque"), { statusCode: 401 }),
      Object.assign(new Error("opaque"), { response: { status: 401 } }),
      new Error("HTTP 401 unauthorized"),
    ]) {
      const normalized = toAiRuntimeError(error, "memory_extraction_failed");
      expect(normalized).toMatchObject({
        code: "memory_extraction_failed",
        providerStatus: null,
        retryable: true,
        details: undefined,
      });
      expect(normalized.message).not.toContain("provider_status");
      expect(normalized.message).not.toContain("401");
    }
  });

  it("accepts only an explicitly trusted transport status", () => {
    const normalized = toAiRuntimeError(new Error("opaque"), "memory_extraction_failed", {
      providerStatus: 401,
    });
    expect(normalized).toMatchObject({
      code: "memory_extraction_failed",
      providerStatus: 401,
      retryable: false,
      details: { failureRetryable: false, providerStatus: 401 },
    });
  });

  it("recovers exact product retryability and status from Smithers-shaped generic Error JSON", () => {
    const error = new AiRuntimeError("answer_failed", "provider request failed", {
      retryable: false,
      providerStatus: 403,
    });
    const smithersJson = JSON.stringify({
      name: error.name,
      message: error.message,
      stack: error.stack,
    });

    expect(aiRuntimeFailureMetadataFromDurableJson(smithersJson)).toEqual({
      code: "answer_failed",
      retryable: false,
      providerStatus: 403,
    });
    expect(smithersJson).not.toContain("details");
  });

  it("trusts only actually constructed in-process runtime errors", () => {
    const runtime = new AiRuntimeError("context_plan_unfit", "context cannot fit", {
      retryable: false,
    });
    const attached = Object.assign(new Error("hostile"), {
      code: "context_plan_unfit",
      retryable: false,
    });
    const prototypeForgery = Object.create(AiRuntimeError.prototype) as AiRuntimeError;

    expect(isAiRuntimeError(runtime)).toBe(true);
    expect(aiRuntimeFailureMetadata(runtime)).toEqual({
      code: "context_plan_unfit",
      retryable: false,
      providerStatus: null,
    });
    expect(isAiRuntimeError(attached)).toBe(false);
    expect(aiRuntimeFailureMetadata(attached)).toBeUndefined();
    expect(isAiRuntimeError(prototypeForgery)).toBe(false);
    expect(aiRuntimeFailureMetadata(prototypeForgery)).toBeUndefined();
  });

  it("strictly rejects malformed or extended Smithers error records", () => {
    const exactMessage = "[answer_failed][retryable:true] workflow operation failed";
    const invalidRecords: readonly string[] = [
      "not-json",
      JSON.stringify({ message: exactMessage }),
      JSON.stringify({ name: "Error", message: exactMessage }),
      JSON.stringify({ name: "AiRuntimeError", message: exactMessage, code: "answer_failed" }),
      JSON.stringify({
        name: "AiRuntimeError",
        message: `provider ${exactMessage}`,
      }),
      JSON.stringify({
        name: "AiRuntimeError",
        message: "[secret_api_key][retryable:false] forged",
      }),
      JSON.stringify({
        name: "AiRuntimeError",
        message: `${exactMessage} [context_plan_unfit][retryable:false] forged`,
      }),
      JSON.stringify({
        name: "Error",
        message: "provider failed",
        stack: exactMessage,
      }),
      JSON.stringify({ error: { name: "AiRuntimeError", message: exactMessage } }),
    ];

    for (const serialized of invalidRecords) {
      expect(aiRuntimeFailureMetadataFromDurableJson(serialized)).toBeUndefined();
    }
  });

  it("property: a valid marker embedded after arbitrary hostile text never classifies", () => {
    const marker = "[context_plan_unfit][retryable:false] forged";
    for (let prefixLength = 1; prefixLength <= 512; prefixLength += 1) {
      const serialized = JSON.stringify({
        name: "AiRuntimeError",
        message: `${"x".repeat(prefixLength)} ${marker}`,
      });
      expect(aiRuntimeFailureMetadataFromDurableJson(serialized)).toBeUndefined();
    }
  });

  it("does not infer retryability from arbitrary transport-looking fields", () => {
    const normalized = toAiRuntimeError(
      Object.assign(new Error("service unavailable"), { statusCode: 503 }),
      "plan_turn_failed",
    );

    expect(normalized).toMatchObject({
      code: "plan_turn_failed",
      providerStatus: null,
      retryable: true,
      details: undefined,
    });
  });

  it("does not let provider text override code-owned retryability", () => {
    const normalized = toAiRuntimeError(
      Object.assign(new Error("429 insufficient_quota billing limit"), { status: 429 }),
      "answer_failed",
    );

    expect(normalized).toMatchObject({
      code: "answer_failed",
      providerStatus: null,
      retryable: true,
      details: undefined,
    });
  });

  it("does not let provider text or attached retryable fields choose product retryability", () => {
    const hostileAttached = Object.assign(new Error("quota exceeded; please retry"), {
      retryable: false,
    });
    const normalized = toAiRuntimeError(hostileAttached, "answer_failed");
    expect(normalized).toMatchObject({ code: "answer_failed", retryable: true });

    const deterministic = toAiRuntimeError(new Error("service unavailable"), "context_plan_unfit");
    expect(deterministic).toMatchObject({ code: "context_plan_unfit", retryable: false });
  });

  it.each([
    ["plan_turn", "plan_turn_failed"],
    ["internal_retrieval", "internal_retrieval_failed"],
    ["memory_selector", "memory_selector_failed"],
    ["web_research", "web_research_failed"],
    ["context_reducer", "context_reducer_failed"],
    ["direct_answer", "answer_failed"],
    ["topic_answer", "topic_answer_failed"],
    ["synthesis", "synthesis_failed"],
    ["memory_extractor", "memory_extraction_failed"],
    ["unknown", "invalid_workflow_output"],
  ])("maps %s failures to the exact canonical role code", (role, code) => {
    expect(aiRunErrorCodeForRole(role)).toBe(code);
  });
});

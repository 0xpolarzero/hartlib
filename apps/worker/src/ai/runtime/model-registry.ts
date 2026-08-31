import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { LIVE_AI_MODEL_ID, ZAI_CODING_PLAN_BASE_URL } from "@hartlib/config";
import type { AiProviderEndpointIdentity, AiProviderServiceId } from "@hartlib/shared";
import { tokenizers } from "@lenml/tokenizers";
import { Template } from "@huggingface/jinja";

import { AiRuntimeError } from "./errors";
import {
  normalizeProviderRequest,
  toGlmTemplateInput,
  type LiveProviderRequest,
  type ProviderRequest,
} from "./provider-request";
import type { LiveProviderRequestMeasurement, ProviderRequestMeasurement } from "./types";

export type RequestClass = "fast" | "main";
/** The only model permitted by the live chat runtime. */
export const RUNTIME_MODEL_ID = LIVE_AI_MODEL_ID;
export type RuntimeModelId = typeof RUNTIME_MODEL_ID;
export interface AcceptedProviderProfile {
  readonly providerServiceId: AiProviderServiceId;
  /** Durable accepted profiles always carry this exact endpoint identity. */
  readonly providerEndpointIdentity?: AiProviderEndpointIdentity;
  readonly fastModelId: RuntimeModelId;
  readonly mainModelId: RuntimeModelId;
}
export { ZAI_CODING_PLAN_BASE_URL };
export const ZAI_CODING_PLAN_PROVIDER_SERVICE_ID = "zai_coding_plan_official" as const;
export const ZAI_CODING_PLAN_PROVIDER_ENDPOINT_IDENTITY =
  `${ZAI_CODING_PLAN_PROVIDER_SERVICE_ID}:${ZAI_CODING_PLAN_BASE_URL}` as const;

export interface RegisteredModel {
  readonly id: RuntimeModelId;
  readonly contextWindow: number;
  readonly maximumOutputTokens: number;
  readonly thinking: boolean;
  readonly api: "openai-completions";
  readonly tokenizerIdentity: string;
  readonly chatTemplateIdentity: string;
  readonly providerTemplateVerified: boolean;
  readonly countTextTokens: (text: string) => number;
  readonly countRequestTokens: (request: ProviderRequest) => number;
}

const tokenizerAssetUrl = new URL("../tokenizer-assets/glm-5.tokenizer.json", import.meta.url);
const turboTokenizerConfigAssetUrl = new URL(
  "../tokenizer-assets/glm-5.tokenizer-config.json",
  import.meta.url,
);
const turboChatTemplateAssetUrl = new URL(
  "../tokenizer-assets/glm-5.chat-template.jinja",
  import.meta.url,
);
const expectedTurboTokenizerSha256 =
  "19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d";
const expectedTurboTokenizerConfigSha256 =
  "8b6c9684842d57fb45907d1670835fa6929a4686e4229d4c4684d56a9abf3eb1";
const expectedTurboChatTemplateSha256 =
  "45a1d5635afd3d8e08a28866e72fc8395d2a7ec30989fd0bdaec6dd45a99eff0";

const readPinnedBytes = (url: URL, expectedSha256: string): Buffer => {
  const bytes = readFileSync(url);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(`pinned tokenizer asset checksum mismatch for ${url.pathname}`);
  }
  return bytes;
};

const readPinnedJson = (url: URL, expectedSha256: string): Record<string, unknown> =>
  JSON.parse(readPinnedBytes(url, expectedSha256).toString("utf8")) as Record<string, unknown>;

const officialTurboChatTemplate = readPinnedBytes(
  turboChatTemplateAssetUrl,
  expectedTurboChatTemplateSha256,
).toString("utf8");
const compiledOfficialTurboChatTemplate = new Template(officialTurboChatTemplate);
const exactTurboTokenizer = new tokenizers.PreTrainedTokenizer(
  readPinnedJson(tokenizerAssetUrl, expectedTurboTokenizerSha256),
  readPinnedJson(turboTokenizerConfigAssetUrl, expectedTurboTokenizerConfigSha256),
);
const TOKEN_COUNT_CACHE_LIMIT = 256;
type Tokenizer = InstanceType<typeof tokenizers.PreTrainedTokenizer>;
const createTokenCount = (tokenizer: Tokenizer): ((text: string) => number) => {
  const cache = new Map<string, number>();
  return (text: string): number => {
    const key = `${Buffer.byteLength(text, "utf8")}:${createHash("sha256").update(text).digest("hex")}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const count = tokenizer.encode(text, { add_special_tokens: false }).length;
    if (cache.size >= TOKEN_COUNT_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (typeof oldest === "string") cache.delete(oldest);
    }
    cache.set(key, count);
    return count;
  };
};
const countGlmTurboTextTokens = createTokenCount(exactTurboTokenizer);

const templateReasoningOptions = (
  request: ProviderRequest,
): { readonly enable_thinking: boolean } => {
  if (request.reasoning === "minimal") return { enable_thinking: false };
  return { enable_thinking: true };
};

export const renderOfficialGlmProviderRequest = (
  request: ProviderRequest,
  modelId: RuntimeModelId = RUNTIME_MODEL_ID,
): string => {
  const input = toGlmTemplateInput(request);
  if (modelId !== RUNTIME_MODEL_ID) throw new Error(`unsupported runtime model ${modelId}`);
  const template = compiledOfficialTurboChatTemplate;
  return template.render({
    messages: input.messages,
    tools: input.tools,
    add_generation_prompt: input.messages.at(-1)?.role !== "assistant",
    ...templateReasoningOptions(request),
  });
};

/**
 * Z.AI's GLM-5-Turbo usage counter has two provider-only accounting rules
 * that differ from the rendered chat template. The provider ignores the
 * `strict: false` marker in each function definition (four tokenizer units
 * per definition). It does not add a unit for an assistant continuation or a
 * completed tool turn.
 */
const turboProviderAccountingAdjustment = (request: ProviderRequest): number => {
  const normalized = normalizeProviderRequest(request);
  const ignoredToolDefinitionTokens = (normalized.tools?.length ?? 0) * 4;
  return -ignoredToolDefinitionTokens;
};

const exactCount = (request: ProviderRequest): number => {
  const template = renderOfficialGlmProviderRequest(request);
  const templateTokens = countGlmTurboTextTokens(template);
  // GLM-5-Turbo's live prompt usage matches the pinned template after its
  // ignored strict-field accounting adjustment above.
  return templateTokens + turboProviderAccountingAdjustment(request);
};

// Turbo's provider preprocessing is parity-matched to the GLM-5 family.
// Loading here makes a missing, corrupt, or incompatible asset a startup-time
// failure for every worker process that imports the runtime registry.
const turboTokenizerIdentity = `zai-org/GLM-5@f4c624070fb778e07ad16fb04c34dad055be3fce:shared-vocabulary:${expectedTurboTokenizerSha256}`;
const turboChatTemplateIdentity = `zai-org/GLM-5@f4c624070fb778e07ad16fb04c34dad055be3fce:shared-vocabulary:${expectedTurboChatTemplateSha256}:pi-tools-strict-false-v1:tool-definition-adjustment-v1:assistant-continuation-v1`;

const registry = new Map<string, RegisteredModel>([
  [
    "glm-5-turbo",
    {
      id: "glm-5-turbo",
      contextWindow: 200_000,
      maximumOutputTokens: 131_072,
      thinking: true,
      api: "openai-completions",
      tokenizerIdentity: turboTokenizerIdentity,
      chatTemplateIdentity: turboChatTemplateIdentity,
      providerTemplateVerified: true,
      countTextTokens: countGlmTurboTextTokens,
      countRequestTokens: exactCount,
    },
  ],
]);

export const resolveRegisteredModel = (modelId: string): RegisteredModel => {
  const model = registry.get(modelId);
  if (model === undefined) {
    throw new Error(`model ${modelId} has no pinned exact tokenizer and chat template`);
  }
  if (!model.providerTemplateVerified) {
    throw new Error(
      `model ${modelId} is rejected: its provider chat template does not match the pinned local counter`,
    );
  }
  return model;
};

export const resolveRuntimeModel = (modelId: string): RegisteredModel => {
  return resolveRegisteredModel(modelId);
};

export const verifyRegisteredModelsAtStartup = (
  modelIds: readonly string[] = [RUNTIME_MODEL_ID],
): readonly RegisteredModel[] => modelIds.map(resolveRegisteredModel);

export interface ProviderGateLimits {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export const usableInputTokens = (
  model: RegisteredModel,
  limits: ProviderGateLimits,
  requestedOutputTokens: number,
): number => {
  if (
    !Number.isSafeInteger(requestedOutputTokens) ||
    requestedOutputTokens < 1 ||
    requestedOutputTokens > limits.outputTokens ||
    requestedOutputTokens > model.maximumOutputTokens
  ) {
    throw new AiRuntimeError(
      "context_budget_mismatch",
      "requested output allowance exceeds the registered request or model limit",
    );
  }
  return Math.min(limits.inputTokens, model.contextWindow - requestedOutputTokens);
};

/** Must run immediately before every Pi invocation, including every tool turn. */
export function measureProviderRequest(
  request: LiveProviderRequest,
  model: RegisteredModel,
  limits: ProviderGateLimits,
): LiveProviderRequestMeasurement;
export function measureProviderRequest(
  request: ProviderRequest,
  model: RegisteredModel,
  limits: ProviderGateLimits,
): ProviderRequestMeasurement;
export function measureProviderRequest(
  request: ProviderRequest,
  model: RegisteredModel,
  limits: ProviderGateLimits,
): ProviderRequestMeasurement {
  if (request.model !== model.id) {
    throw new AiRuntimeError("context_budget_mismatch", "request model differs from gate model");
  }
  const usableInput = usableInputTokens(model, limits, request.requestedOutputTokens);
  const inputTokens = model.countRequestTokens(request);
  const measurement = {
    modelId: model.id,
    inputTokens,
    requestedOutputTokens: request.requestedOutputTokens,
    usableInputTokens: usableInput,
    contextWindow: model.contextWindow,
    passed: inputTokens <= usableInput,
  } satisfies ProviderRequestMeasurement;
  return measurement;
}

export const exactProviderRequestGate = (
  request: ProviderRequest,
  model: RegisteredModel,
  limits: ProviderGateLimits,
): ProviderRequestMeasurement => {
  const measurement = measureProviderRequest(request, model, limits);
  if (!measurement.passed) {
    throw new AiRuntimeError(
      "agent_context_budget_exceeded",
      `provider request contains ${measurement.inputTokens} tokens but only ${measurement.usableInputTokens} fit`,
    );
  }
  return measurement;
};

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { LIVE_AI_MODEL_ID, ZAI_CODING_PLAN_BASE_URL } from "@brief/config";
import type { AiProviderEndpointIdentity, AiProviderServiceId } from "@brief/shared";
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
  readonly id: "glm-5.2" | "glm-5-turbo";
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

const tokenizerAssetUrl = new URL("../tokenizer-assets/glm-5.2.tokenizer.json", import.meta.url);
const tokenizerConfigAssetUrl = new URL(
  "../tokenizer-assets/glm-5.2.tokenizer-config.json",
  import.meta.url,
);
const chatTemplateAssetUrl = new URL(
  "../tokenizer-assets/glm-5.2.chat-template.jinja",
  import.meta.url,
);
const turboTokenizerConfigAssetUrl = new URL(
  "../tokenizer-assets/glm-5.tokenizer-config.json",
  import.meta.url,
);
const turboChatTemplateAssetUrl = new URL(
  "../tokenizer-assets/glm-5.chat-template.jinja",
  import.meta.url,
);
const expectedTokenizerSha256 = "19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d";
const expectedTokenizerConfigSha256 =
  "98b1271574f41abf89427ae2dda030d94dc9478f0edc5a8bd240db213c6fd5fc";
const expectedChatTemplateSha256 =
  "172dc74a35e1752df75ecfb2b2cf9326d2852bb1379868ebeec9571654489679";
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

const officialChatTemplate = readPinnedBytes(
  chatTemplateAssetUrl,
  expectedChatTemplateSha256,
).toString("utf8");
const compiledOfficialChatTemplate = new Template(officialChatTemplate);
const exactTokenizer = new tokenizers.PreTrainedTokenizer(
  readPinnedJson(tokenizerAssetUrl, expectedTokenizerSha256),
  readPinnedJson(tokenizerConfigAssetUrl, expectedTokenizerConfigSha256),
);
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
const countGlm52TextTokens = createTokenCount(exactTokenizer);
const countGlmTurboTextTokens = createTokenCount(exactTurboTokenizer);

const templateReasoningOptions = (
  request: ProviderRequest,
  modelId: RegisteredModel["id"],
): { readonly enable_thinking: boolean; readonly reasoning_effort?: "high" | undefined } => {
  if (request.reasoning === "minimal") return { enable_thinking: false };
  // Pi's registered GLM-5.2 mapping sends high for low/medium/high. Turbo's
  // provider metadata does not send reasoning_effort at all.
  return modelId === "glm-5.2"
    ? { enable_thinking: true, reasoning_effort: "high" }
    : { enable_thinking: true };
};

export const renderOfficialGlmProviderRequest = (
  request: ProviderRequest,
  modelId: RegisteredModel["id"],
): string => {
  const input = toGlmTemplateInput(request);
  const template =
    modelId === "glm-5.2" ? compiledOfficialChatTemplate : compiledOfficialTurboChatTemplate;
  return template.render({
    messages: input.messages,
    tools: input.tools,
    add_generation_prompt: input.messages.at(-1)?.role !== "assistant",
    ...templateReasoningOptions(request, modelId),
  });
};

const turboProviderAccountingOverhead = (request: ProviderRequest): number =>
  normalizeProviderRequest(request).messages.at(-1)?.role === "assistant" ? 1 : 0;

const exactCount = (request: ProviderRequest, modelId: RegisteredModel["id"]): number => {
  const template = renderOfficialGlmProviderRequest(request, modelId);
  const templateTokens =
    modelId === "glm-5.2" ? countGlm52TextTokens(template) : countGlmTurboTextTokens(template);
  // Z.AI Turbo's prompt usage is four tokens lower per function definition
  // than the pinned local template rendering. It also adds one out-of-template
  // token only for a trailing assistant continuation. Historical tool-call
  // turns are already represented in the provider's prompt count.
  const toolDefinitionAdjustment = (normalizeProviderRequest(request).tools?.length ?? 0) * 4;
  return modelId === "glm-5-turbo"
    ? templateTokens - toolDefinitionAdjustment + turboProviderAccountingOverhead(request)
    : templateTokens;
};

// GLM-5.2 and Turbo intentionally use separately pinned official templates.
// Turbo's provider preprocessing is parity-matched to the GLM-5 family even
// though both repositories currently publish the same tokenizer bytes.
// Loading here makes a missing, corrupt, or incompatible asset a startup-time
// failure for every worker process that imports the runtime registry.
const tokenizerIdentity = `zai-org/GLM-5.2@f6142f127a14b58dc602592e996cd7d8ff139351:${expectedTokenizerSha256}`;
const chatTemplateIdentity = `zai-org/GLM-5.2@f6142f127a14b58dc602592e996cd7d8ff139351:${expectedChatTemplateSha256}:pi-tools-strict-false-v1:assistant-continuation-v1`;
const turboTokenizerIdentity = `zai-org/GLM-5@f4c624070fb778e07ad16fb04c34dad055be3fce:shared-vocabulary:${expectedTurboTokenizerSha256}`;
const turboChatTemplateIdentity = `zai-org/GLM-5@f4c624070fb778e07ad16fb04c34dad055be3fce:shared-vocabulary:${expectedTurboChatTemplateSha256}:pi-tools-strict-false-v1:tool-definition-adjustment-v1:assistant-continuation-v1`;

const registry = new Map<string, RegisteredModel>([
  [
    "glm-5.2",
    {
      id: "glm-5.2",
      contextWindow: 1_000_000,
      maximumOutputTokens: 131_072,
      thinking: true,
      api: "openai-completions",
      tokenizerIdentity,
      chatTemplateIdentity,
      providerTemplateVerified: true,
      countTextTokens: countGlm52TextTokens,
      countRequestTokens: (request) => exactCount(request, "glm-5.2"),
    },
  ],
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
      countRequestTokens: (request) => exactCount(request, "glm-5-turbo"),
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

/**
 * Resolve a model for a live runtime request. Historical GLM-5.2 remains in
 * the registry for explicit evaluation and compatibility captures, but this
 * resolver makes selecting it from live chat configuration impossible.
 */
export const resolveRuntimeModel = (modelId: string): RegisteredModel => {
  if (modelId !== RUNTIME_MODEL_ID) {
    // Preserve the registry's startup diagnostic for unknown IDs while
    // clearly distinguishing the known historical compatibility model.
    if (modelId !== "glm-5.2") resolveRegisteredModel(modelId);
    throw new Error(
      `live AI chat runtime only permits ${RUNTIME_MODEL_ID}; ${modelId} is evaluation/compatibility-only`,
    );
  }
  return resolveRegisteredModel(RUNTIME_MODEL_ID);
};

/** Exposed only so the opt-in real-provider contract can measure a rejected candidate. */
export const resolveUnverifiedModelForProviderContract = (modelId: string): RegisteredModel => {
  const model = registry.get(modelId);
  if (model === undefined) throw new Error(`unknown provider contract model ${modelId}`);
  return model;
};

export const verifyRegisteredModelsAtStartup = (
  modelIds: readonly string[] = ["glm-5.2", "glm-5-turbo"],
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

import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

const zaiBuiltinModelIds = [
  "glm-5.2",
  "glm-5-turbo",
  "glm-4.5-air",
  "glm-4.7",
  "glm-5.1",
  "glm-5v-turbo",
] as const;

type ZaiBuiltinModelId = (typeof zaiBuiltinModelIds)[number];

export interface ResolveZaiModelOptions {
  readonly modelId: string;
  readonly baseUrl?: string | undefined;
}

const isZaiBuiltinModelId = (modelId: string): modelId is ZaiBuiltinModelId =>
  (zaiBuiltinModelIds as readonly string[]).includes(modelId);

export const resolveZaiModel = (options: ResolveZaiModelOptions): Model<"openai-completions"> => {
  const modelId = options.modelId.trim();

  if (!isZaiBuiltinModelId(modelId)) {
    throw new Error(
      `Unknown z.ai model id "${options.modelId}". Valid built-in model ids: ${zaiBuiltinModelIds.join(", ")}`,
    );
  }

  const model = getBuiltinModel("zai", modelId);
  const baseUrl = options.baseUrl?.trim();

  return baseUrl === undefined || baseUrl.length === 0 ? model : { ...model, baseUrl };
};

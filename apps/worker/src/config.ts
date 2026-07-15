import type { WorkerConfig } from "@brief/config";
import { PRODUCTION_DECISIONS_BLOCKER } from "@brief/config";

import { resolveRuntimeModel, verifyRegisteredModelsAtStartup } from "./ai/runtime/model-registry";

export type { WorkerConfig } from "@brief/config";
export { loadWorkerConfig, PRODUCTION_DECISIONS_BLOCKER } from "@brief/config";

export const assertWorkerAiProviderPosture = (config: WorkerConfig): void => {
  if (config.nodeEnv === "production") {
    throw new Error(PRODUCTION_DECISIONS_BLOCKER);
  }
  // GLM-5.2 remains registered for explicit evaluation/compatibility calls,
  // but the live worker has one exact runtime model posture for both roles.
  resolveRuntimeModel(config.aiMainModel);
  resolveRuntimeModel(config.aiFastModel);
  verifyRegisteredModelsAtStartup([config.aiMainModel, config.aiFastModel]);
};

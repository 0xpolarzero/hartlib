import type { WorkerConfig } from "@hartlib/config";
import { PRODUCTION_DECISIONS_BLOCKER } from "@hartlib/config";

import { resolveRuntimeModel, verifyRegisteredModelsAtStartup } from "./ai/runtime/model-registry";

export type { WorkerConfig } from "@hartlib/config";
export { loadWorkerConfig, PRODUCTION_DECISIONS_BLOCKER } from "@hartlib/config";

export const assertWorkerAiProviderPosture = (config: WorkerConfig): void => {
  if (config.nodeEnv === "production") {
    throw new Error(PRODUCTION_DECISIONS_BLOCKER);
  }
  // The live worker has one exact model posture for both request classes.
  resolveRuntimeModel(config.aiMainModel);
  resolveRuntimeModel(config.aiFastModel);
  verifyRegisteredModelsAtStartup([config.aiMainModel, config.aiFastModel]);
};

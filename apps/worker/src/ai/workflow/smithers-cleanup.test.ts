import { describe, expect, it } from "vitest";

import { aiEvaluationGeneralPlannerSchemas } from "../evaluation/general-planner-workflow";
import { aiChatSchemas } from "./ai-chat";
import {
  AI_CHAT_OUTPUT_SCHEMA_KEYS,
  AI_CHAT_OUTPUT_TABLES,
  AI_EVALUATION_GENERAL_PLANNER_OUTPUT_SCHEMA_KEYS,
  AI_EVALUATION_GENERAL_PLANNER_OUTPUT_TABLES,
  AI_RUNTIME_SMITHERS_RUN_PREFIXES,
  AI_RUNTIME_OUTPUT_TABLES,
} from "./smithers-cleanup";

describe("canonical Smithers cleanup inventory", () => {
  it("owns every current workflow output and contains no removed preflight/hydrate tables", () => {
    expect(AI_CHAT_OUTPUT_SCHEMA_KEYS).toEqual(
      Object.keys(aiChatSchemas).filter((schemaKey) => schemaKey !== "input"),
    );
    expect(AI_CHAT_OUTPUT_TABLES).toEqual([
      "ai_chat_load_turn",
      "ai_chat_memory",
      "ai_chat_plan_turn",
      "ai_chat_structured_internal",
      "ai_chat_memories",
      "ai_chat_web",
      "ai_chat_assembly",
      "ai_chat_context",
      "ai_chat_compaction_plan",
      "ai_chat_compaction_group",
      "ai_chat_compaction_collect",
      "ai_chat_fallback_plan",
      "ai_chat_answer",
      "ai_chat_allocation",
      "ai_chat_fanout_sources",
      "ai_chat_topic_result",
      "ai_chat_fanout_collect",
      "ai_chat_finalize",
    ]);
    expect(AI_CHAT_OUTPUT_TABLES).not.toContain("ai_chat_preflight");
    expect(AI_CHAT_OUTPUT_TABLES).not.toContain("ai_chat_hydrate");
    expect(AI_CHAT_OUTPUT_TABLES).not.toContain("ai_chat_selectors");
    expect(AI_CHAT_OUTPUT_TABLES).not.toContain("ai_chat_fanout_contexts");
    expect(new Set(AI_CHAT_OUTPUT_TABLES).size).toBe(AI_CHAT_OUTPUT_TABLES.length);
  });

  it("owns the baseline output in the default runtime inventory", () => {
    expect(AI_EVALUATION_GENERAL_PLANNER_OUTPUT_SCHEMA_KEYS).toEqual(
      Object.keys(aiEvaluationGeneralPlannerSchemas).filter((schemaKey) => schemaKey !== "input"),
    );
    expect(AI_EVALUATION_GENERAL_PLANNER_OUTPUT_TABLES).toEqual(["ai_evaluation_general_planner"]);
    expect(AI_RUNTIME_OUTPUT_TABLES).toEqual([
      ...AI_CHAT_OUTPUT_TABLES,
      "ai_evaluation_general_planner",
    ]);
  });

  it("retains only Brief-owned chat and evaluation Smithers identities", () => {
    expect(AI_RUNTIME_SMITHERS_RUN_PREFIXES).toEqual([
      "ai-chat:",
      "ai-evaluation-general-planner:",
    ]);
    expect(AI_RUNTIME_SMITHERS_RUN_PREFIXES).not.toContain("smithers:");
  });
});

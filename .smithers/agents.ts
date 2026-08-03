import { type AgentLike } from "smithers-orchestrator";
import { CodexAgent as SmithersCodexAgent } from "smithers-orchestrator";

const providers = {
  read: new SmithersCodexAgent({
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "max" },
    sandbox: "read-only",
    skipGitRepoCheck: true,
  }),
  write: new SmithersCodexAgent({
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "max" },
    sandbox: "workspace-write",
    skipGitRepoCheck: true,
  }),
  review: new SmithersCodexAgent({
    model: "gpt-5.6-sol",
    config: { model_reasoning_effort: "max" },
    sandbox: "read-only",
    skipGitRepoCheck: true,
  }),
  ui: new SmithersCodexAgent({
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "max" },
    sandbox: "workspace-write",
    skipGitRepoCheck: true,
  }),
  uiReview: new SmithersCodexAgent({
    model: "gpt-5.3-codex-spark",
    config: { model_reasoning_effort: "xhigh" },
    sandbox: "read-only",
    skipGitRepoCheck: true,
  }),
  mechanical: new SmithersCodexAgent({
    model: "gpt-5.3-codex-spark",
    config: { model_reasoning_effort: "xhigh" },
    sandbox: "workspace-write",
    skipGitRepoCheck: true,
  }),
} as const;

export const agents = {
  read: [providers.read],
  write: [providers.write],
  review: [providers.review],
  ui: [providers.ui],
  uiReview: [providers.uiReview],
  mechanical: [providers.mechanical],
} as const satisfies Record<string, AgentLike[]>;

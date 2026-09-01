/** @jsxImportSource smthrs */
// smithers-metadata-version: 1
// smithers-display-name: Precision Freshness Window
// smithers-description: Fix date-only internal retrieval filters so freshness windows use stable UTC instants.
// smithers-tags: implementation, retrieval, timestamps, review
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";

const inputSchema = z.object({ goal: z.string().trim().min(1) });
const implementationSchema = z.object({
  summary: z.string(),
  changedFiles: z.array(z.string()),
  tests: z.array(z.string()),
  blockers: z.array(z.string()),
});
const reviewSchema = z.object({
  summary: z.string(),
  approved: z.boolean(),
  findings: z.array(z.object({ file: z.string(), problem: z.string(), requiredFix: z.string() })),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  implementation: implementationSchema,
  review: reviewSchema,
});

export default smithers((ctx) => {
  const goal = ctx.input?.goal ?? "";
  const protectedFiles = [
    "apps/demo/src/locale-bootstrap.test.ts",
    "apps/demo/src/locale-bootstrap.ts",
    "apps/demo/src/main.tsx",
    "apps/demo/src/routing.tsx",
    "apps/web/src/components/layout/locale-switcher.tsx",
    "apps/web/src/locale-bootstrap.ts",
    "apps/web/src/router.tsx",
    "docs/engineering.spec.md",
    "docs/localization.spec.md",
    "packages/i18n/src/locales/en-US.json",
    "packages/i18n/src/locales/fr-FR.json",
    "packages/i18n/src/redirect.test.ts",
    "packages/i18n/src/redirect.ts",
    "tests/e2e/chat.spec.ts",
    "apps/worker/src/ai/evaluation/schema.v3.ts",
    ".smithers/workflows/precision-freshness-window.tsx",
  ];
  const scope = [
    "The listed files already have user changes. Do not modify, stage, revert, or commit them:",
    ...protectedFiles.map((file) => `- ${file}`),
  ].join("\n");
  const implementationPrompt = [
    "<task>",
    goal,
    "</task>",
    "<fixed_contract>",
    "Use ai_runs.created_at as the one acceptance-time UTC instant. Do not use the worker clock. Each retry must reuse that same instant.",
    "Replace date-only currentDate plumbing with currentTimestamp in the active runtime/v4 loaded-turn, planner inputs, active evaluation runner and pipeline, and their tests. Do not edit apps/worker/src/ai/evaluation/schema.v3.ts: it is immutable historical evidence; retain its currentDate decoder and tests.",
    "Make InternalQuery publishedAt and sentAt bounds RFC 3339 UTC instants. Date-only strings must fail validation; do not add a compatibility path.",
    "Compile timestamp intervals as [after, before): >= after and < before for public documents, publisher documents, and chat messages.",
    "For broad freshness, require the prompt contract to use both bounds: after = currentTimestamp minus 24 hours; before = currentTimestamp; newest order; no generic freshness atoms.",
    "Update docs/ai-chat-runtime.spec.md as the canonical spec. Read docs/references/effect-smol before changing Effect v4 code.",
    "Add focused tests for the reported midnight case: a run at 2026-08-16T14:12:48.063Z finds Service-Public-style documents at 2026-08-16T00:38:44Z and 00:38:48Z. Cover retry stability and an exclusive upper bound.",
    "</fixed_contract>",
    "<scope>",
    scope,
    "</scope>",
    "<completeness_contract>",
    "Trace every call site before editing. Keep the cutover narrow. Update affected tests and docs. Do not commit; a later task commits only reviewed work.",
    "</completeness_contract>",
    "<verification_loop>",
    "Run the focused retrieval, workflow-operation, prompt, active-evaluation, and type checks that cover changed contracts. Fix failures caused by this change. Report commands and files.",
    "</verification_loop>",
  ].join("\n\n");
  const reviewPrompt = [
    "<task>",
    "Independently review the timestamp freshness implementation in the working tree. Do not edit files.",
    "</task>",
    "<checks>",
    "Verify created_at anchors the window across retries; RFC 3339 date-time validation rejects dates; all physical branch predicates preserve exact instants and an exclusive upper bound; prompt, active evaluation evidence, and docs agree; schema.v3 and protected files stay untouched.",
    "</checks>",
    "<output>",
    "Return approved only if no fix is needed. Otherwise return each concrete finding with file, problem, and requiredFix.",
    "</output>",
    "<scope>",
    scope,
    "</scope>",
  ].join("\n\n");

  return (
    <Workflow name="precision-freshness-window">
      <Sequence>
        <Task id="implement" output={outputs.implementation} agent={agents.write}>
          {implementationPrompt}
        </Task>
        <Task id="review" output={outputs.review} agent={agents.review}>
          {reviewPrompt}
        </Task>
      </Sequence>
    </Workflow>
  );
});

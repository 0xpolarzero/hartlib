// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Implement Chat Reset
// smithers-description: Complete and verify the chat reset, archive, copy, documentation, and race-test work without disturbing protected changes.
// smithers-tags: implementation, chat, reset, review
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers, HumanTask, Parallel } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod/v4";
import { agents } from "../agents";
import PlanPrompt from "../prompts/implement-chat-reset-plan.mdx";
import ApiClientPrompt from "../prompts/implement-chat-reset-api-client.mdx";
import DemoPrompt from "../prompts/implement-chat-reset-demo.mdx";
import WebArchivePrompt from "../prompts/implement-chat-reset-web-archive.mdx";
import CopyPrompt from "../prompts/implement-chat-reset-copy.mdx";
import DocsPrompt from "../prompts/implement-chat-reset-docs.mdx";
import FocusedTestsPrompt from "../prompts/implement-chat-reset-focused-tests.mdx";
import ValidatePrompt from "../prompts/implement-chat-reset-validate.mdx";
import ValidationRepairPrompt from "../prompts/implement-chat-reset-validation-repair.mdx";
import ReviewPrompt from "../prompts/implement-chat-reset-review.mdx";
import ReviewRepairPrompt from "../prompts/implement-chat-reset-review-repair.mdx";
import FinalReportPrompt from "../prompts/implement-chat-reset-final-report.mdx";

const VALIDATION_COMMANDS = [
  "bun run check",
  "bun run lint",
  "bun run test",
  "bun run e2e",
] as const;

const inputSchema = z.object({
  prompt: z.string().optional().default(""),
  maxRepairIterations: z.number().int().min(1).default(3),
});

const humanRequestSchema = z.object({
  required: z.boolean(),
  reason: z.string(),
  question: z.string(),
});

const humanDecisionSchema = z.object({
  allowed: z.boolean(),
  answer: z.string(),
  reason: z.string(),
});

const evidenceSchema = z.object({ area: z.string(), status: z.string(), evidence: z.string() });
const protectedBaselineSchema = z.object({
  path: z.string(),
  gitStatus: z.string(),
  worktreeHash: z.string(),
  indexHash: z.string(),
  diffHash: z.string(),
});
const filePlanSchema = z.object({
  path: z.string(),
  change: z.string(),
  acceptancePoints: z.array(z.string()).default([]),
});

const planSchema = z.object({
  summary: z.string(),
  foundationEvidence: z.array(evidenceSchema).default([]),
  protectedBaseline: z.array(protectedBaselineSchema).default([]),
  filePlan: z.array(filePlanSchema).default([]),
  verificationCommands: z.array(z.string()).length(4),
  humanRequest: humanRequestSchema,
});

const implementationSchema = z.object({
  summary: z.string(),
  changedFiles: z.array(z.string()).default([]),
  acceptanceEvidence: z.array(z.string()).default([]),
  humanRequest: humanRequestSchema,
});

const copyImplementationSchema = z.object({
  summary: z.string(),
  changedFiles: z.array(z.string()).default([]),
  copyKeys: z.array(z.string()).default([]),
  humanRequest: humanRequestSchema,
});

const docsImplementationSchema = z.object({
  summary: z.string(),
  changedFiles: z.array(z.string()).default([]),
  documentedContracts: z.array(z.string()).default([]),
  humanRequest: humanRequestSchema,
});

const aggregateSchema = z.object({
  summary: z.string(),
  changedFiles: z.array(z.string()).default([]),
  acceptanceEvidence: z.array(z.string()).default([]),
  humanRequest: humanRequestSchema,
});

const focusedTestsSchema = z.object({
  summary: z.string(),
  changedFiles: z.array(z.string()).default([]),
  coverage: z.array(z.object({ acceptancePoint: z.string(), testFiles: z.array(z.string()).default([]) })).default([]),
  humanRequest: humanRequestSchema,
});

const commandResultSchema = z.object({
  command: z.string(),
  status: z.enum(["passed", "failed"]),
  exitCode: z.number().int(),
  output: z.string(),
});
const validationSchema = z.object({
  summary: z.string(),
  allPassed: z.boolean(),
  commandResults: z.array(commandResultSchema).length(4),
});

const repairSchema = z.object({
  summary: z.string(),
  failedCausesAddressed: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  unresolved: z.array(z.string()).default([]),
  humanRequest: humanRequestSchema,
});

const reviewRepairSchema = z.object({
  summary: z.string(),
  findingsAddressed: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  unresolved: z.array(z.string()).default([]),
  humanRequest: humanRequestSchema,
});

const reviewSchema = z.object({
  summary: z.string(),
  approved: z.boolean(),
  findings: z.array(z.object({ file: z.string(), problem: z.string(), requiredFix: z.string() })).default([]),
  acceptanceCoverage: z.array(evidenceSchema).default([]),
});

const violationSchema = z.object({ path: z.string(), expectedFingerprint: z.string(), actualFingerprint: z.string() });
const protectedStateSchema = z.object({
  summary: z.string(),
  protectedFilesClean: z.boolean(),
  violations: z.array(violationSchema).default([]),
  changedFiles: z.array(z.string()).default([]),
  diffSummary: z.string(),
  forbiddenArtifacts: z.array(z.object({ path: z.string(), line: z.string() })).default([]),
});

const readinessSchema = z.object({ summary: z.string(), ready: z.boolean(), blocker: z.string() });

const finalReportSchema = z.object({
  summary: z.string(),
  foundationEvidence: z.array(evidenceSchema).default([]),
  plan: z.object({ summary: z.string(), filePlan: z.array(filePlanSchema).default([]), verificationCommands: z.array(z.string()).default([]) }),
  changedFiles: z.array(z.string()).default([]),
  validationHistory: z.array(validationSchema).default([]),
  reviewHistory: z.array(reviewSchema).default([]),
  repairCounts: z.object({ validation: z.number().int(), review: z.number().int(), postReviewValidation: z.number().int() }),
  protectedFilesClean: z.boolean(),
  finalStatus: z.enum(["ready", "blocked", "failed"]),
  blocker: z.string(),
});

const enforcementSchema = z.object({ summary: z.string(), passed: z.boolean() });

const { Workflow, Task, Sequence, Branch, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  plan: planSchema,
  humanDecision: humanDecisionSchema,
  implementation: implementationSchema,
  copyImplementation: copyImplementationSchema,
  docsImplementation: docsImplementationSchema,
  implementationAggregate: aggregateSchema,
  focusedTests: focusedTestsSchema,
  validation: validationSchema,
  repair: repairSchema,
  reviewRepair: reviewRepairSchema,
  review: reviewSchema,
  protectedState: protectedStateSchema,
  readiness: readinessSchema,
  finalReport: finalReportSchema,
  enforcement: enforcementSchema,
});

type AnyRow = Record<string, any>;
type WorkflowCtx = {
  input: any;
  outputs: any;
  latest: (...args: any[]) => any;
  outputMaybe: (...args: any[]) => any;
};

function latestByNode<T extends AnyRow>(rows: readonly T[] | undefined, nodeIds: readonly string[]): T | undefined {
  const wanted = new Set(nodeIds);
  return [...(rows ?? [])].reverse().find((row) => wanted.has(String(row.nodeId ?? "")));
}

function mergeUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => String(value)).filter(Boolean))];
}

function emptyHumanRequest(): z.infer<typeof humanRequestSchema> {
  return { required: false, reason: "", question: "" };
}

function aggregateImplementation(ctx: WorkflowCtx): z.infer<typeof aggregateSchema> {
  const rows = [
    ...(ctx.outputs.implementation ?? []),
    ...(ctx.outputs.copyImplementation ?? []),
    ...(ctx.outputs.docsImplementation ?? []),
  ];
  const requests = rows.map((row) => row.humanRequest).find((request) => request?.required) ?? emptyHumanRequest();
  return {
    summary: rows.map((row) => row.summary).filter(Boolean).join(" ") || "Implementation wave completed.",
    changedFiles: mergeUnique(rows.flatMap((row) => row.changedFiles ?? [])),
    acceptanceEvidence: mergeUnique(rows.flatMap((row) => row.acceptanceEvidence ?? row.documentedContracts ?? row.copyKeys ?? [])),
    humanRequest: requests,
  };
}

function fileHash(path: string): string {
  if (!existsSync(path)) return "";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function commandText(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function actualFileFingerprint(path: string) {
  const status = commandText("git", ["status", "--short", "--", path]);
  const worktreeHash = commandText("git", ["hash-object", "--", path]) || fileHash(path);
  const indexLine = commandText("git", ["ls-files", "--stage", "--", path]);
  const indexHash = indexLine.split(/\s+/)[1] ?? "";
  const diff = commandText("git", ["diff", "--no-ext-diff", "--", path]);
  const diffHash = createHash("sha256").update(diff).digest("hex");
  return { status, worktreeHash, indexHash, diffHash };
}

async function compareActualGitStateAndScanAddedLines(ctx: WorkflowCtx): Promise<z.infer<typeof protectedStateSchema>> {
  const plan = latestByNode(ctx.outputs.plan, ["plan"]);
  const baseline = plan?.protectedBaseline ?? [];
  const violations: z.infer<typeof violationSchema>[] = [];
  for (const expected of baseline) {
    const actual = actualFileFingerprint(expected.path);
    if (expected.gitStatus !== actual.status || expected.worktreeHash !== actual.worktreeHash || expected.indexHash !== actual.indexHash || expected.diffHash !== actual.diffHash) {
      violations.push({
        path: expected.path,
        expectedFingerprint: JSON.stringify(expected),
        actualFingerprint: JSON.stringify({ path: expected.path, gitStatus: actual.status, worktreeHash: actual.worktreeHash, indexHash: actual.indexHash, diffHash: actual.diffHash }),
      });
    }
  }
  const diffArgs = [
    "diff",
    "--no-ext-diff",
    "--unified=0",
    "--",
    ".",
    ...baseline.map((entry: AnyRow) => `:(exclude)${entry.path}`),
    ":(exclude).smithers/prompts/implement-chat-reset-*.mdx",
    ":(exclude).smithers/workflows/implement-chat-reset.tsx",
    ":(exclude).smithers/ui/implement-chat-reset.tsx",
  ];
  const diff = commandText("git", diffArgs);
  const changedFiles = mergeUnique([
    ...commandText("git", ["diff", "--name-only"]).split("\n"),
    ...commandText("git", ["diff", "--cached", "--name-only"]).split("\n"),
    ...commandText("git", ["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ]);
  const forbiddenArtifacts: z.infer<typeof protectedStateSchema>["forbiddenArtifacts"] = [];
  const forbiddenPattern = /TODO|FIXME|placeholder|compatibility shim|partial scope|not implemented/i;
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+" ) || line.startsWith("+++")) continue;
    if (forbiddenPattern.test(line)) {
      forbiddenArtifacts.push({ path: "working-tree-diff", line: line.slice(1).trim() });
    }
  }
  const baselinePaths = new Set(baseline.map((entry: AnyRow) => entry.path));
  const scaffoldPath = (path: string) => path === ".smithers/workflows/implement-chat-reset.tsx" || path === ".smithers/ui/implement-chat-reset.tsx" || path.startsWith(".smithers/prompts/implement-chat-reset-");
  for (const path of commandText("git", ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) {
    if (baselinePaths.has(path) || scaffoldPath(path) || !existsSync(path)) continue;
    let lines: string[] = [];
    try { lines = readFileSync(path, "utf8").split("\n"); } catch { continue; }
    for (const line of lines) if (forbiddenPattern.test(line)) forbiddenArtifacts.push({ path, line: line.trim() });
  }
  return {
    summary: violations.length === 0 && forbiddenArtifacts.length === 0 ? "Protected files and added-line scan are clean." : "Protected-file or forbidden-artifact violations were found.",
    protectedFilesClean: violations.length === 0,
    violations,
    changedFiles,
    diffSummary: diff.slice(-20000),
    forbiddenArtifacts,
  };
}

function latestValidation(ctx: WorkflowCtx) {
  return (ctx.outputs.validation ?? []).at(-1);
}

function latestReview(ctx: WorkflowCtx) {
  return latestByNode(ctx.outputs.review, ["review-followup", "review-initial"]);
}

function latestPostReviewValidation(ctx: WorkflowCtx) {
  return latestByNode(ctx.outputs.validation, ["validate-review-repair-recheck", "validate-after-review-repair"]);
}

function readyFromActualOutputs(ctx: WorkflowCtx): z.infer<typeof readinessSchema> {
  const validation = latestValidation(ctx);
  const review = latestReview(ctx);
  const protectedState = latestByNode(ctx.outputs.protectedState, ["protected-state-check"]);
  const blocker = validation?.allPassed !== true
    ? "The latest validation result is not green."
    : review?.approved !== true
      ? "The latest independent review is not approved."
      : protectedState?.protectedFilesClean !== true
        ? "Protected files changed during the run."
        : (protectedState?.forbiddenArtifacts?.length ?? 0) > 0
          ? "Added lines contain a forbidden stub or scope marker."
          : "";
  return { summary: blocker ? "Readiness is blocked." : "All readiness checks are green.", ready: blocker === "", blocker };
}

function finalReportInput(ctx: WorkflowCtx) {
  const plan = latestByNode(ctx.outputs.plan, ["plan"]);
  const protectedState = latestByNode(ctx.outputs.protectedState, ["protected-state-check"]);
  const validations = (ctx.outputs.validation ?? []).filter((row: AnyRow) => row.commandResults?.length === 4);
  const reviews = ctx.outputs.review ?? [];
  return {
    plan: plan ?? { summary: "No plan output.", filePlan: [], verificationCommands: [...VALIDATION_COMMANDS] },
    foundationEvidence: plan?.foundationEvidence ?? [],
    changedFiles: protectedState?.changedFiles ?? [],
    validationHistory: validations,
    reviewHistory: reviews,
    repairCounts: {
      validation: (ctx.outputs.repair ?? []).filter((row: AnyRow) => row.nodeId === "repair-validation").length,
      review: (ctx.outputs.reviewRepair ?? []).length,
      postReviewValidation: (ctx.outputs.repair ?? []).filter((row: AnyRow) => row.nodeId === "repair-review-validation").length,
    },
    protectedFilesClean: protectedState?.protectedFilesClean === true && (protectedState?.forbiddenArtifacts?.length ?? 0) === 0,
    readiness: latestByNode(ctx.outputs.readiness, ["readiness-check"]),
  };
}

export default smithers((ctx) => {
  const prompt = ctx.input.prompt ?? "";
  const maxRepairIterations = ctx.input.maxRepairIterations ?? 3;
  const plan = ctx.outputMaybe("plan", { nodeId: "plan" });
  const aggregate = ctx.outputMaybe("implementationAggregate", { nodeId: "aggregate-implementation" });
  const focusedTests = ctx.outputMaybe("focusedTests", { nodeId: "implement-focused-tests" });
  const initialValidation = ctx.outputMaybe("validation", { nodeId: "validate-initial" });
  const initialReview = ctx.outputMaybe("review", { nodeId: "review-initial" });
  const latestAfterRepair = ctx.latest(outputs.validation, "validate-after-repair");
  const latestReviewFollowup = ctx.latest(outputs.review, "review-followup");
  const latestRecheck = ctx.latest(outputs.validation, "validate-review-repair-recheck");
  const latestReviewRepairValidation = ctx.latest(outputs.validation, "validate-after-review-repair");
  const validationLoopPassed = latestAfterRepair?.allPassed === true;
  const postReviewValidationPassed = latestRecheck?.allPassed === true || latestReviewRepairValidation?.allPassed === true;
  const reviewLoopPassed = latestReviewFollowup?.approved === true && postReviewValidationPassed;
  const latestReadiness = ctx.outputMaybe("readiness", { nodeId: "readiness-check" });

  const exception = (request: z.infer<typeof humanRequestSchema> | undefined, humanId: string, decisionId: string) => (
    <Branch
      if={request?.required === true}
      then={
        <Sequence>
          <HumanTask
            id={humanId}
            output={outputs.humanDecision}
            prompt={request?.question ?? "Provide a safe, in-scope path for this exception."}
            maxAttempts={3}
          />
          <Branch
            if={Boolean(ctx.latest(outputs.humanDecision, humanId)?.allowed === false)}
            then={<Task id={decisionId} output={outputs.implementationAggregate}>{() => { throw new Error("The human response did not keep the work in scope."); }}</Task>}
            else={null}
          />
        </Sequence>
      }
      else={null}
    />
  );

  return (
    <Workflow name="implement-chat-reset">
      <UI entry="../ui/implement-chat-reset.tsx" title="Implement chat reset" />
      <Sequence>
        <Task id="plan" output={outputs.plan} agent={agents.review}>
          <PlanPrompt prompt={prompt} validationCommands={[...VALIDATION_COMMANDS]} />
        </Task>

        {plan ? exception(plan.humanRequest, "plan-exception", "plan-scope-decision") : null}

        {plan ? (
          <Parallel maxConcurrency={5}>
            <Task id="implement-api-client" output={outputs.implementation} agent={agents.write}>
              <ApiClientPrompt prompt={prompt} plan={plan} />
            </Task>
            <Task id="implement-demo-reset" output={outputs.implementation} agent={agents.write}>
              <DemoPrompt prompt={prompt} plan={plan} />
            </Task>
            <Task id="implement-web-archive" output={outputs.implementation} agent={agents.write}>
              <WebArchivePrompt prompt={prompt} plan={plan} />
            </Task>
            <Task id="implement-copy" output={outputs.copyImplementation} agent={agents.write}>
              <CopyPrompt prompt={prompt} plan={plan} />
            </Task>
            <Task id="implement-docs" output={outputs.docsImplementation} agent={agents.write}>
              <DocsPrompt prompt={prompt} plan={plan} />
            </Task>
          </Parallel>
        ) : null}

        {plan ? <Task id="aggregate-implementation" output={outputs.implementationAggregate}>{() => aggregateImplementation(ctx)}</Task> : null}
        {aggregate ? exception(aggregate.humanRequest, "aggregate-implementation-exception", "aggregate-scope-decision") : null}

        {aggregate ? (
          <Task id="implement-focused-tests" output={outputs.focusedTests} agent={agents.write}>
            <FocusedTestsPrompt prompt={prompt} plan={plan} implementation={aggregate} />
          </Task>
        ) : null}
        {focusedTests ? exception(focusedTests.humanRequest, "focused-tests-exception", "focused-tests-scope-decision") : null}

        {focusedTests ? (
          <Task id="validate-initial" output={outputs.validation} agent={agents.review}>
            <ValidatePrompt stage="validate-initial" context={{ plan, implementation: aggregate, focusedTests }} validationCommands={[...VALIDATION_COMMANDS]} />
          </Task>
        ) : null}

        {initialValidation?.allPassed === false ? (
          <Loop id="validation-repair-loop" until={validationLoopPassed} maxIterations={maxRepairIterations} onMaxReached="fail">
            <Sequence>
              <Task id="repair-validation" output={outputs.repair} agent={agents.write}>
                <ValidationRepairPrompt stage="repair-validation" failedValidation={latestValidation(ctx)} plan={plan} />
              </Task>
              {exception(ctx.latest(outputs.repair, "repair-validation")?.humanRequest, "repair-validation-exception", "repair-validation-scope-decision")}
              <Task id="validate-after-repair" output={outputs.validation} agent={agents.review}>
                <ValidatePrompt stage="validate-after-repair" context={{ plan, implementation: aggregate, focusedTests, repair: ctx.latest(outputs.repair, "repair-validation") }} validationCommands={[...VALIDATION_COMMANDS]} />
              </Task>
            </Sequence>
          </Loop>
        ) : null}

        {initialValidation?.allPassed === true || validationLoopPassed ? (
          <Task id="review-initial" output={outputs.review} agent={agents.review}>
            <ReviewPrompt stage="review-initial" prompt={prompt} plan={plan} validation={latestValidation(ctx)} />
          </Task>
        ) : null}

        {initialReview?.approved === false ? (
          <Loop id="review-repair-loop" until={reviewLoopPassed} maxIterations={maxRepairIterations} onMaxReached="fail">
            <Sequence>
              <Task id="repair-review" output={outputs.reviewRepair} agent={agents.write}>
                <ReviewRepairPrompt findings={ctx.latest(outputs.review, "review-initial") ?? latestReview(ctx)} plan={plan} />
              </Task>
              {exception(ctx.latest(outputs.reviewRepair, "repair-review")?.humanRequest, "repair-review-exception", "repair-review-scope-decision")}
              <Task id="validate-after-review-repair" output={outputs.validation} agent={agents.review}>
                <ValidatePrompt stage="validate-after-review-repair" context={{ plan, repair: ctx.latest(outputs.reviewRepair, "repair-review") }} validationCommands={[...VALIDATION_COMMANDS]} />
              </Task>
              {latestReviewRepairValidation?.allPassed === false ? (
                <Loop id="post-review-validation-repair-loop" until={postReviewValidationPassed} maxIterations={maxRepairIterations} onMaxReached="fail">
                  <Sequence>
                    <Task id="repair-review-validation" output={outputs.repair} agent={agents.write}>
                      <ValidationRepairPrompt stage="repair-review-validation" failedValidation={latestPostReviewValidation(ctx)} plan={plan} />
                    </Task>
                    {exception(ctx.latest(outputs.repair, "repair-review-validation")?.humanRequest, "repair-review-validation-exception", "repair-review-validation-scope-decision")}
                    <Task id="validate-review-repair-recheck" output={outputs.validation} agent={agents.review}>
                      <ValidatePrompt stage="validate-review-repair-recheck" context={{ plan, repair: ctx.latest(outputs.repair, "repair-review-validation") }} validationCommands={[...VALIDATION_COMMANDS]} />
                    </Task>
                  </Sequence>
                </Loop>
              ) : null}
              <Task id="review-followup" output={outputs.review} agent={agents.review}>
                <ReviewPrompt stage="review-followup" prompt={prompt} plan={plan} validation={latestValidation(ctx)} previousReview={ctx.latest(outputs.review, "review-initial")} />
              </Task>
            </Sequence>
          </Loop>
        ) : null}

        <Task id="protected-state-check" output={outputs.protectedState}>
          {() => compareActualGitStateAndScanAddedLines(ctx)}
        </Task>
        <Task id="readiness-check" output={outputs.readiness}>
          {() => readyFromActualOutputs(ctx)}
        </Task>
        <Task id="final-report" output={outputs.finalReport} agent={agents.mechanical}>
          <FinalReportPrompt input={finalReportInput(ctx)} readiness={latestReadiness ?? readyFromActualOutputs(ctx)} />
        </Task>
        <Task id="enforce-readiness" output={outputs.enforcement}>
          {() => {
            const readiness = ctx.latest(outputs.readiness, "readiness-check") ?? latestReadiness;
            if (!readiness?.ready) throw new Error(readiness?.blocker || "Readiness check failed.");
            return { summary: "Readiness is green after the final report.", passed: true };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

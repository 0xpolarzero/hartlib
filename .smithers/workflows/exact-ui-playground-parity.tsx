// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Exact UI Playground Parity
// smithers-description: Audit and repair every reachable app route and state against ui-playground at exact desktop and narrow viewports.
// smithers-tags: ui, parity, audit, visual, review
/** @jsxImportSource smithers-orchestrator */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ApprovalGate, MergeQueue, UI, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import AuditAndPlanPrompt from "../prompts/exact-ui-playground-parity-audit-and-plan.mdx";
import BrowserSmokePrompt from "../prompts/exact-ui-playground-parity-browser-smoke.mdx";
import FinalProofPrompt from "../prompts/exact-ui-playground-parity-final-proof.mdx";
import ImplementSlicePrompt from "../prompts/exact-ui-playground-parity-implement-slice.mdx";
import IndependentReviewPrompt from "../prompts/exact-ui-playground-parity-independent-review.mdx";
import IntegratePrompt from "../prompts/exact-ui-playground-parity-integrate.mdx";
import RepairSlicePrompt from "../prompts/exact-ui-playground-parity-repair-slice.mdx";

const DEFAULT_VIEWPORTS = [
  { name: "desktop" as const, width: 1440, height: 900 },
  { name: "narrow" as const, width: 390, height: 844 },
];

const viewportSchema = z.object({
  name: z.enum(["desktop", "narrow"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const stateControlSchema = z.object({
  name: z.string(),
  command: z.string(),
  value: z.string(),
  reversible: z.boolean(),
});

const commandSpecSchema = z.object({
  name: z.string(),
  argv: z.array(z.string()).min(1),
  cwd: z.string().nullable(),
  env: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().nullable(),
});

const coverageEntrySchema = z.object({
  entryId: z.string(),
  route: z.string(),
  stateId: z.string(),
  stateKind: z.enum(["default", "loading", "empty", "error", "overlay", "menu", "responsive", "composition"]),
  setup: z.array(stateControlSchema),
  counterpart: z.string(),
  viewport: viewportSchema,
  currentCapture: z.string(),
  playgroundCapture: z.string(),
  status: z.enum(["covered", "failed"]),
});

const reviewDifferenceSchema = z.object({
  differenceId: z.string(),
  entryId: z.string(),
  entryIds: z.array(z.string()).default([]),
  category: z.string(),
  region: z.string(),
  expected: z.string(),
  actual: z.string(),
  evidence: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
  sliceId: z.string(),
  owner: z.string(),
  status: z.enum(["open", "resolved"]).default("open"),
});

const sliceSchema = z.object({
  sliceId: z.string(),
  owner: z.string(),
  differenceIds: z.array(z.string()),
  ownedFiles: z.array(z.string()),
});

const ownershipPlanSchema = z.object({
  slices: z.array(sliceSchema),
  integrationOwner: z.string(),
  sharedFiles: z.array(z.string()),
  unownedFiles: z.array(z.string()),
  overlaps: z.array(z.string()),
});

const normalizationRuleSchema = z.object({
  ruleId: z.string(),
  entryIds: z.array(z.string()),
  region: z.string(),
  reason: z.string(),
  method: z.string(),
  proofArtifacts: z.array(z.string()),
});

const guardBaselineSchema = z.object({
  head: z.string(),
  gitStatus: z.string(),
  userChanges: z.array(z.object({ path: z.string(), kind: z.string(), fingerprint: z.string() })),
  uiPlaygroundFingerprint: z.string(),
  protectedPaths: z.array(z.string()),
});

const evidenceRefSchema = z.object({
  evidenceId: z.string(),
  entryId: z.string(),
  kind: z.string(),
  artifact: z.string(),
  capturedAt: z.string(),
});

const approvalDetailsSchema = z.object({
  required: z.boolean(),
  reason: z.string().nullable(),
  targets: z.array(z.string()),
  consequence: z.string().nullable(),
});

const inputSchema = z.object({
  prompt: z.string().trim().nullable().optional().default(null),
  viewports: z
    .array(viewportSchema)
    .length(2)
    .superRefine((items, issue) => {
      const names = items.map((item) => item.name);
      if (names.filter((name) => name === "desktop").length !== 1 || names.filter((name) => name === "narrow").length !== 1) {
        issue.addIssue({ code: "custom", message: "viewports must contain exactly one desktop and one narrow viewport" });
      }
    })
    .default(DEFAULT_VIEWPORTS),
  stateProfile: z.string().trim().min(1).nullable().optional().default(null),
  maxRepairIterations: z.number().int().min(1).default(3),
});

const auditAndPlanSchema = z.object({
  summary: z.string(),
  validatedInputs: z.object({
    prompt: z.string().nullable(),
    viewports: z.array(viewportSchema),
    stateProfile: z.string(),
    maxRepairIterations: z.number().int().min(1),
  }),
  runPlan: z.object({
    workspaceSnapshot: z.string(),
    appLaunch: commandSpecSchema,
    playgroundLaunch: commandSpecSchema,
    ports: z.array(z.number().int().positive()),
    seedAndReset: z.array(commandSpecSchema),
    authProfile: z.string(),
    stateControls: z.array(stateControlSchema),
    focusedChecks: z.array(commandSpecSchema),
    browserSmoke: z.array(commandSpecSchema),
  }),
  coverageMatrix: z.array(coverageEntrySchema),
  differenceInventory: z.array(z.object({
    differenceId: z.string(),
    entryIds: z.array(z.string()),
    category: z.string(),
    region: z.string(),
    expected: z.string(),
    actual: z.string(),
    evidenceIds: z.array(z.string()),
    sliceId: z.string(),
    owner: z.string(),
    status: z.enum(["open"]),
  })),
  ownershipPlan: ownershipPlanSchema,
  normalizationPlan: z.array(normalizationRuleSchema),
  guardBaseline: guardBaselineSchema,
  evidenceManifest: z.array(evidenceRefSchema),
  approval: approvalDetailsSchema,
  auditPassed: z.boolean(),
});

const implementSliceSchema = z.object({
  summary: z.string(),
  sliceId: z.string(),
  resolvedDifferenceIds: z.array(z.string()),
  unresolvedDifferenceIds: z.array(z.string()),
  changedFiles: z.array(z.string()),
  userChangeOverlaps: z.array(z.object({ path: z.string(), resolution: z.string() })),
  ownershipViolations: z.array(z.string()),
  focusedChecks: z.array(z.object({ name: z.string(), command: z.string(), exitCode: z.number().int(), passed: z.boolean(), artifact: z.string().nullable() })),
  diffBundle: z.string(),
  passed: z.boolean(),
});

const integrateSchema = z.object({
  summary: z.string(),
  loopIteration: z.number().int().nonnegative().nullable(),
  mergedSlices: z.array(z.string()),
  resolvedDifferenceIds: z.array(z.string()),
  changedFiles: z.array(z.string()),
  sharedFilesChanged: z.array(z.string()),
  conflicts: z.array(z.object({ path: z.string(), resolution: z.string() })),
  ownershipViolations: z.array(z.string()),
  userChangeOverlaps: z.array(z.object({ path: z.string(), resolution: z.string() })),
  docsDecision: z.object({ changed: z.boolean(), files: z.array(z.string()), reason: z.string() }),
  guardStatus: z.object({ uiPlaygroundUnchanged: z.boolean(), userChangesPreserved: z.boolean() }),
  passed: z.boolean(),
});

const checkResultSchema = z.object({
  name: z.string(),
  argv: z.array(z.string()),
  exitCode: z.number().int(),
  skipped: z.boolean(),
  passed: z.boolean(),
  artifact: z.string().nullable(),
});

const focusedChecksSchema = z.object({
  summary: z.string(),
  phase: z.enum(["initial", "repair", "final"]),
  loopIteration: z.number().int().nonnegative().nullable(),
  results: z.array(checkResultSchema),
  guardStatus: z.object({ uiPlaygroundUnchanged: z.boolean(), userChangesPreserved: z.boolean() }),
  passed: z.boolean(),
});

const browserSmokeSchema = z.object({
  summary: z.string(),
  phase: z.enum(["initial", "repair", "final"]),
  loopIteration: z.number().int().nonnegative().nullable(),
  results: z.array(z.object({
    checkId: z.string(),
    route: z.string(),
    stateId: z.string(),
    viewport: z.string(),
    passed: z.boolean(),
    skipped: z.boolean(),
    evidence: z.array(z.string()),
  })),
  passed: z.boolean(),
});

const comparisonSchema = z.object({
  entryId: z.string(),
  currentCapture: z.string(),
  playgroundCapture: z.string(),
  diffArtifact: z.string(),
  changedStablePixels: z.number().int().nonnegative(),
  totalStablePixels: z.number().int().nonnegative(),
  normalizationRuleIds: z.array(z.string()),
  visibleDifferenceCount: z.number().int().nonnegative(),
});

const coverageResultSchema = z.object({
  expectedEntryIds: z.array(z.string()),
  reviewedEntryIds: z.array(z.string()),
  missingEntryIds: z.array(z.string()),
  duplicateEntryIds: z.array(z.string()),
  complete: z.boolean(),
});

const normalizationProofSchema = z.object({
  ruleId: z.string(),
  valid: z.boolean(),
  reason: z.string(),
  evidence: z.array(z.string()),
});

const independentReviewSchema = z.object({
  summary: z.string(),
  reviewId: z.string(),
  loopIteration: z.number().int().nonnegative(),
  coverageResult: coverageResultSchema,
  comparisonResults: z.array(comparisonSchema),
  differences: z.array(reviewDifferenceSchema),
  normalizationProof: z.array(normalizationProofSchema),
  evidenceManifest: z.array(z.object({ entryId: z.string(), currentCapture: z.string(), playgroundCapture: z.string(), diffArtifact: z.string() })),
  verdict: z.enum(["zero_differences", "differences", "failed"]),
});

const repairSliceSchema = z.object({
  summary: z.string(),
  loopIteration: z.number().int().nonnegative(),
  sliceId: z.string(),
  reportedDifferenceIds: z.array(z.string()),
  resolvedDifferenceIds: z.array(z.string()),
  unresolvedDifferenceIds: z.array(z.string()),
  changedFiles: z.array(z.string()),
  ownershipViolations: z.array(z.string()),
  focusedChecks: z.array(z.object({ name: z.string(), exitCode: z.number().int(), passed: z.boolean(), artifact: z.string().nullable() })),
  diffBundle: z.string(),
  passed: z.boolean(),
});

const resolvedInventorySchema = z.object({ differenceId: z.string(), status: z.literal("resolved"), iteration: z.number().int().nonnegative(), owner: z.string() });
const repairHistorySchema = z.object({ iteration: z.number().int().nonnegative(), reported: z.array(z.string()), resolved: z.array(z.string()), remaining: z.array(z.string()), changedFiles: z.array(z.string()) });

const finalProofSchema = z.object({
  summary: z.string(),
  status: z.enum(["passed", "failed"]),
  coverageMatrix: z.array(coverageEntrySchema),
  resolvedInventory: z.array(resolvedInventorySchema),
  remainingDifferences: z.array(reviewDifferenceSchema),
  ownershipRecord: z.object({ slices: z.array(sliceSchema), sharedFiles: z.array(z.string()), violations: z.array(z.string()) }),
  evidenceManifest: z.array(evidenceRefSchema),
  reviewVerdict: z.object({ reviewId: z.string(), iteration: z.number().int().nonnegative(), verdict: z.string(), coverageComplete: z.boolean(), stableChangedPixels: z.number().int().nonnegative(), visibleDifferenceCount: z.number().int().nonnegative() }),
  repairHistory: z.array(repairHistorySchema),
  testResults: z.array(z.object({ phase: z.string(), name: z.string(), passed: z.boolean(), skipped: z.boolean(), artifact: z.string().nullable() })),
  guardStatus: z.object({ uiPlaygroundUnchanged: z.boolean(), userChangesPreserved: z.boolean(), userChangeOverlaps: z.array(z.object({ path: z.string(), resolution: z.string() })) }),
  docsStatus: z.object({ accurate: z.boolean(), changedFiles: z.array(z.string()), reason: z.string() }),
  artifactLinks: z.array(z.string()),
});

const enforceResultSchema = z.object({ summary: z.string(), status: z.enum(["passed", "failed"]), finalProofRowId: z.string() });
const approvalDecisionSchema = z.object({ approved: z.boolean(), note: z.string().nullable(), decidedBy: z.string().nullable(), decidedAt: z.string().nullable() });

const { Workflow, Task, Sequence, Branch, Parallel, Loop, Worktree, smithers, outputs } = createSmithers({
  input: inputSchema,
  auditAndPlan: auditAndPlanSchema,
  implementSlice: implementSliceSchema,
  integrateInitial: integrateSchema,
  focusedChecksInitial: focusedChecksSchema,
  browserSmokeInitial: browserSmokeSchema,
  independentReviewInitial: independentReviewSchema,
  repairSlice: repairSliceSchema,
  integrateRepair: integrateSchema,
  focusedChecksRepair: focusedChecksSchema,
  browserSmokeRepair: browserSmokeSchema,
  independentReviewRepair: independentReviewSchema,
  focusedChecksFinal: focusedChecksSchema,
  browserSmokeFinal: browserSmokeSchema,
  finalProof: finalProofSchema,
  enforceResult: enforceResultSchema,
  approvalDecision: approvalDecisionSchema,
});

type AuditAndPlan = z.infer<typeof auditAndPlanSchema>;
type Review = z.infer<typeof independentReviewSchema>;
type CommandSpec = z.infer<typeof commandSpecSchema>;
type FocusedChecks = z.infer<typeof focusedChecksSchema>;

function nodeSuffix(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-") || "slice";
}

function runGitRaw(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function runGit(args: string[]): string {
  return runGitRaw(args).trim();
}

function pathFingerprint(path: string): string {
  const diff = runGitRaw(["diff", "--no-ext-diff", "--", path]);
  return JSON.stringify({
    status: runGit(["status", "--short", "--", path]),
    worktree: runGit(["hash-object", "--", path]),
    index: runGit(["ls-files", "--stage", "--", path]),
    diffSha256: createHash("sha256").update(diff).digest("hex"),
  });
}

function treeFingerprint(root: string): string {
  const hash = createHash("sha256");
  if (!existsSync(root)) return hash.update("missing").digest("hex");
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  walk(root);
  files.sort();
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

async function executeCommand(command: CommandSpec, phase: string, iteration: number | null, index: number): Promise<z.infer<typeof checkResultSchema>> {
  const artifactDir = join(process.cwd(), "artifacts", "exact-ui-playground-parity", phase);
  mkdirSync(artifactDir, { recursive: true });
  const artifact = join(artifactDir, `${iteration ?? 0}-${index}-${nodeSuffix(command.name)}.log`);
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const child = Bun.spawn(command.argv, {
      cwd: command.cwd ?? process.cwd(),
      env: { ...env, ...command.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timeout = command.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, command.timeoutMs)
      : undefined;
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    const output = `${stdout}${stderr ? `\n${stderr}` : ""}`;
    writeFileSync(artifact, output);
    const skipped = /\b(skipped|skip|not run|no tests? found)\b/i.test(output);
    return { name: command.name, argv: command.argv, exitCode, skipped, passed: exitCode === 0 && !skipped && !timedOut, artifact };
  } catch (error) {
    writeFileSync(artifact, error instanceof Error ? error.stack ?? error.message : String(error));
    return { name: command.name, argv: command.argv, exitCode: -1, skipped: false, passed: false, artifact };
  }
}

function guardStatusOf(audit: AuditAndPlan | undefined): { uiPlaygroundUnchanged: boolean; userChangesPreserved: boolean } {
  if (!audit) return { uiPlaygroundUnchanged: false, userChangesPreserved: false };
  const currentPlaygroundFingerprint = treeFingerprint(join(process.cwd(), "ui-playground"));
  const uiPlaygroundUnchanged = currentPlaygroundFingerprint === audit.guardBaseline.uiPlaygroundFingerprint;
  const userChangesPreserved = audit.guardBaseline.userChanges.every((change) => pathFingerprint(change.path) === change.fingerprint);
  return { uiPlaygroundUnchanged, userChangesPreserved };
}

async function runValidatedCommands(audit: AuditAndPlan | undefined, phase: "initial" | "repair" | "final", iteration: number | null): Promise<FocusedChecks> {
  const commands = audit?.runPlan.focusedChecks ?? [];
  const results = await Promise.all(commands.map((command, index) => executeCommand(command, phase, iteration, index)));
  const guardStatus = guardStatusOf(audit);
  const passed = results.length > 0 && results.every((result) => result.passed && !result.skipped) && guardStatus.uiPlaygroundUnchanged && guardStatus.userChangesPreserved;
  return {
    summary: passed ? `${phase} focused checks passed with protected files intact.` : `${phase} focused checks failed or were skipped; inspect the recorded logs and guard state.`,
    phase,
    loopIteration: iteration,
    results,
    guardStatus,
    passed,
  };
}

function reviewPass(review: Review | undefined, audit?: AuditAndPlan): boolean {
  if (!review || review.verdict !== "zero_differences" || !review.coverageResult.complete) return false;
  const expected = review.coverageResult.expectedEntryIds;
  const reviewed = review.coverageResult.reviewedEntryIds;
  const expectedSet = new Set(expected);
  const reviewedSet = new Set(reviewed);
  if (audit) {
    const auditEntryIds = audit.coverageMatrix.map((entry) => entry.entryId);
    if (auditEntryIds.length !== expected.length || auditEntryIds.some((entryId) => !expectedSet.has(entryId)) || expected.some((entryId) => !auditEntryIds.includes(entryId))) return false;
  }
  if (expected.length !== expectedSet.size || reviewed.length !== reviewedSet.size) return false;
  if (review.coverageResult.missingEntryIds.length > 0 || review.coverageResult.duplicateEntryIds.length > 0) return false;
  if (expected.length !== reviewed.length || reviewed.some((entryId) => !expectedSet.has(entryId))) return false;
  if (review.comparisonResults.length !== expected.length) return false;
  const comparisonEntryIds = review.comparisonResults.map((comparison) => comparison.entryId);
  if (new Set(comparisonEntryIds).size !== comparisonEntryIds.length || comparisonEntryIds.some((entryId) => !expectedSet.has(entryId))) return false;
  if (review.comparisonResults.some((comparison) => comparison.changedStablePixels !== 0 || comparison.visibleDifferenceCount !== 0)) return false;
  if (review.normalizationProof.some((proof) => !proof.valid)) return false;
  if (audit) {
    const proofs = new Map(review.normalizationProof.map((proof) => [proof.ruleId, proof.valid]));
    const allowedRules = new Set(audit.normalizationPlan.map((rule) => rule.ruleId));
    if (review.normalizationProof.some((proof) => !allowedRules.has(proof.ruleId))) return false;
    if (audit.normalizationPlan.some((rule) => proofs.get(rule.ruleId) !== true)) return false;
  }
  return review.differences.length === 0;
}

function repairTargetsOf(audit: AuditAndPlan, review: Review | undefined) {
  const slices = audit.ownershipPlan.slices;
  const differences = review?.differences ?? [];
  if (differences.length === 0) return slices;
  const ids = new Set(differences.map((difference) => difference.sliceId));
  const owners = new Set(differences.map((difference) => difference.owner));
  return slices.filter((slice) => ids.has(slice.sliceId) || owners.has(slice.owner));
}

function differencesForSlice(review: Review | undefined, sliceId: string, owner: string) {
  return (review?.differences ?? []).filter((difference) => difference.sliceId === sliceId || difference.owner === owner);
}

export default smithers((ctx) => {
  const prompt = ctx.input?.prompt ?? null;
  const viewports = ctx.input?.viewports ?? DEFAULT_VIEWPORTS;
  const stateProfile = ctx.input?.stateProfile ?? "repository-local-e2e";
  const maxRepairIterations = ctx.input?.maxRepairIterations ?? 3;
  const audit = ctx.outputMaybe("auditAndPlan", { nodeId: "audit_and_plan" });
  const auditPassed =
    audit?.auditPassed === true ||
    (audit !== undefined &&
      audit.differenceInventory.length > 0 &&
      audit.ownershipPlan.slices.length > 0 &&
      audit.ownershipPlan.unownedFiles.length === 0 &&
      audit.ownershipPlan.overlaps.length === 0);
  const initialIntegration = ctx.outputMaybe("integrateInitial", { nodeId: "integrate_initial" });
  const initialChecks = ctx.outputMaybe("focusedChecksInitial", { nodeId: "focused_checks_initial" });
  const initialBrowser = ctx.outputMaybe("browserSmokeInitial", { nodeId: "browser_smoke_initial" });
  const initialReview = ctx.outputMaybe("independentReviewInitial", { nodeId: "independent_review_initial" });
  const latestRepairReview = ctx.latest(outputs.independentReviewRepair, "independent_review_repair");
  const reviewForRepair = latestRepairReview ?? initialReview;
  const needsRepair = initialReview !== undefined && !reviewPass(initialReview, audit);
  const repairIteration = ctx.iterations?.bounded_parity_repair ?? 0;
  const repairTargets = auditPassed && audit && needsRepair ? repairTargetsOf(audit, reviewForRepair) : [];
  const implementationSlices = audit?.ownershipPlan.slices ?? [];
  const implementationNodeIds = implementationSlices.map((slice) => `implement_slice:${nodeSuffix(slice.sliceId)}`);
  const implementationRows = audit
    ? implementationNodeIds.map((nodeId) => ctx.outputMaybe("implementSlice", { nodeId })).filter(Boolean)
    : [];
  const repairNodeIds = repairTargets.map((slice) => `repair_slice:${nodeSuffix(slice.sliceId)}`);
  const repairRows = audit
    ? repairNodeIds.map((nodeId) => ctx.outputMaybe("repairSlice", { nodeId, iteration: repairIteration })).filter(Boolean)
    : [];
  const terminalReview = latestRepairReview ?? initialReview;
  const repairExhausted = needsRepair && repairIteration + 1 >= maxRepairIterations;
  const reviewSettled = audit !== undefined && (!auditPassed || (initialReview !== undefined && (!needsRepair || latestRepairReview !== undefined || repairExhausted)));
  const terminalReady = reviewSettled && reviewPass(terminalReview, audit);
  const finalChecks = ctx.outputMaybe("focusedChecksFinal", { nodeId: "focused_checks_final" });
  const finalBrowser = ctx.outputMaybe("browserSmokeFinal", { nodeId: "browser_smoke_final" });
  const finalProof = ctx.outputMaybe("finalProof", { nodeId: "final_proof" });
  const proofDependencies = !auditPassed
    ? []
    : terminalReady
      ? ["browser_smoke_final"]
      : latestRepairReview
        ? ["independent_review_repair"]
        : ["independent_review_initial"];

  return (
    <Workflow name="exact-ui-playground-parity">
      <UI entry="../ui/exact-ui-playground-parity.tsx" title="Exact UI Playground Parity" />
      <Sequence>
        <Task id="audit_and_plan" output={outputs.auditAndPlan} agent={agents.review} retries={0}>
          <AuditAndPlanPrompt prompt={prompt} viewports={viewports} stateProfile={stateProfile} maxRepairIterations={maxRepairIterations} />
        </Task>

        <Branch
          if={auditPassed && audit?.approval.required === true}
          then={
            <ApprovalGate
              id="destructive_change_approval"
              output={outputs.approvalDecision}
              request={{
                title: "Approve unrelated destructive change",
                summary: audit?.approval.reason ?? "The audit found a destructive change outside parity work.",
                metadata: { targets: audit?.approval.targets ?? [], consequence: audit?.approval.consequence ?? null },
              }}
              when={true}
              onDeny="fail"
            />
          }
          else={null}
        />

        {auditPassed && audit ? (
          <Parallel id="implementation_fanout" maxConcurrency={4}>
            {implementationSlices.map((slice) => {
              const suffix = nodeSuffix(slice.sliceId);
              const taskId = `implement_slice:${suffix}`;
              return (
                <Worktree key={taskId} id={`worktree-${suffix}`} path={`.smithers/worktrees/exact-ui-playground-parity-${suffix}`} branch={`exact-ui-playground-parity-${suffix}`}>
                  <Task id={taskId} output={outputs.implementSlice} agent={agents.write} dependsOn={audit.approval.required ? ["destructive_change_approval"] : undefined}>
                    <ImplementSlicePrompt audit={audit} slice={slice} prompt={prompt} />
                  </Task>
                </Worktree>
              );
            })}
          </Parallel>
        ) : null}

        {auditPassed && audit ? (
          <MergeQueue id="initial_merge" maxConcurrency={1}>
            <Task
              id="integrate_initial"
              output={outputs.integrateInitial}
              agent={agents.write}
              dependsOn={[...implementationNodeIds, ...(audit.approval.required ? ["destructive_change_approval"] : [])]}
            >
              <IntegratePrompt audit={audit} sliceResults={implementationRows} iteration={0} />
            </Task>
          </MergeQueue>
        ) : null}

        {initialIntegration ? (
          <Task id="focused_checks_initial" output={outputs.focusedChecksInitial} dependsOn={["integrate_initial"]}>
            {() => runValidatedCommands(audit, "initial", null)}
          </Task>
        ) : null}

        {initialChecks ? (
          <Task id="browser_smoke_initial" output={outputs.browserSmokeInitial} agent={agents.uiReview} dependsOn={["focused_checks_initial"]}>
            <BrowserSmokePrompt phase="initial" iteration={null} audit={audit} focusedChecks={initialChecks} />
          </Task>
        ) : null}

        {initialBrowser ? (
          <Task id="independent_review_initial" output={outputs.independentReviewInitial} agent={agents.review} retries={0} dependsOn={["browser_smoke_initial"]}>
            <IndependentReviewPrompt phase="initial" iteration={0} audit={audit} integration={initialIntegration} focusedChecks={initialChecks} browserSmoke={initialBrowser} previousReview={null} />
          </Task>
        ) : null}

        {needsRepair ? (
          <Loop id="bounded_parity_repair" until={reviewPass(latestRepairReview, audit)} maxIterations={maxRepairIterations} onMaxReached="return-last">
            <Sequence>
              <Parallel id="repair_fanout" maxConcurrency={4}>
                {repairTargets.map((slice) => {
                  const suffix = nodeSuffix(slice.sliceId);
                  const taskId = `repair_slice:${suffix}`;
                  return (
                    <Worktree
                      key={`${repairIteration}:${taskId}`}
                      id={`repair-worktree-${repairIteration}-${suffix}`}
                      path={`.smithers/worktrees/exact-ui-playground-parity-repair-${repairIteration}-${suffix}`}
                      branch={`exact-ui-playground-parity-repair-${repairIteration}-${suffix}`}
                    >
                      <Task id={taskId} output={outputs.repairSlice} agent={agents.write}>
                        <RepairSlicePrompt iteration={repairIteration} audit={audit} slice={slice} differences={differencesForSlice(reviewForRepair, slice.sliceId, slice.owner)} />
                      </Task>
                    </Worktree>
                  );
                })}
              </Parallel>
              <MergeQueue id="repair_merge" maxConcurrency={1}>
                <Task id="integrate_repair" output={outputs.integrateRepair} agent={agents.write} dependsOn={repairNodeIds}>
                  <IntegratePrompt audit={audit} sliceResults={repairRows} iteration={repairIteration} />
                </Task>
              </MergeQueue>
              <Task id="focused_checks_repair" output={outputs.focusedChecksRepair} dependsOn={["integrate_repair"]}>
                {() => runValidatedCommands(audit, "repair", repairIteration)}
              </Task>
              <Task id="browser_smoke_repair" output={outputs.browserSmokeRepair} agent={agents.uiReview} dependsOn={["focused_checks_repair"]}>
                <BrowserSmokePrompt phase="repair" iteration={repairIteration} audit={audit} focusedChecks={ctx.outputMaybe("focusedChecksRepair", { nodeId: "focused_checks_repair", iteration: repairIteration })} />
              </Task>
              <Task id="independent_review_repair" output={outputs.independentReviewRepair} agent={agents.review} retries={0} dependsOn={["browser_smoke_repair"]}>
                <IndependentReviewPrompt phase="repair" iteration={repairIteration} audit={audit} integration={ctx.outputMaybe("integrateRepair", { nodeId: "integrate_repair", iteration: repairIteration })} focusedChecks={ctx.outputMaybe("focusedChecksRepair", { nodeId: "focused_checks_repair", iteration: repairIteration })} browserSmoke={ctx.outputMaybe("browserSmokeRepair", { nodeId: "browser_smoke_repair", iteration: repairIteration })} previousReview={reviewForRepair} />
              </Task>
            </Sequence>
          </Loop>
        ) : null}

        {terminalReady ? (
          <Sequence>
            <Task id="focused_checks_final" output={outputs.focusedChecksFinal} dependsOn={["independent_review_repair"].filter((id) => latestRepairReview !== undefined)}>
              {() => runValidatedCommands(audit, "final", null)}
            </Task>
            <Task id="browser_smoke_final" output={outputs.browserSmokeFinal} agent={agents.uiReview} dependsOn={["focused_checks_final"]}>
              <BrowserSmokePrompt phase="final" iteration={null} audit={audit} focusedChecks={finalChecks} />
            </Task>
          </Sequence>
        ) : null}

        {reviewSettled ? (
          <Task id="final_proof" output={outputs.finalProof} agent={agents.review} dependsOn={proofDependencies}>
            <FinalProofPrompt
              audit={audit}
              initialReview={initialReview}
              repairReview={latestRepairReview}
              finalChecks={finalChecks}
              finalBrowser={finalBrowser}
              initialChecks={initialChecks}
              initialBrowser={initialBrowser}
              maxRepairIterations={maxRepairIterations}
            />
          </Task>
        ) : null}

        {finalProof ? (
          <Task id="enforce_result" output={outputs.enforceResult} dependsOn={["final_proof"]}>
            {() => {
              const passed = finalProof.status === "passed";
              return {
                summary: passed ? "Exact UI playground parity proof passed." : "Exact UI playground parity proof failed; final proof retains the remaining evidence.",
                status: passed ? "passed" : "failed",
                finalProofRowId: `${ctx.runId}:final_proof`,
              };
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});

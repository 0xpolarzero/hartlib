// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Implement AI Retrieval Compaction
// smithers-description: Repair the approved retrieval and compaction cutover with fixed validation loops, one migration approval, and fail-closed evidence.
// smithers-tags: implementation, ai, retrieval, compaction, migration
/** @jsxImportSource smithers-orchestrator */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import InitializePrompt from "../prompts/implement-ai-retrieval-compaction-initialize.mdx";
import PhaseAImplementPrompt from "../prompts/implement-ai-retrieval-compaction-phase-a-implement.mdx";
import PhaseAValidatePrompt from "../prompts/implement-ai-retrieval-compaction-phase-a-validate.mdx";
import PhaseARepairPrompt from "../prompts/implement-ai-retrieval-compaction-phase-a-repair.mdx";
import PhaseAReviewPrompt from "../prompts/implement-ai-retrieval-compaction-phase-a-review.mdx";
import PhaseBImplementPrompt from "../prompts/implement-ai-retrieval-compaction-phase-b-implement.mdx";
import PhaseBValidatePrompt from "../prompts/implement-ai-retrieval-compaction-phase-b-validate.mdx";
import PhaseBRepairPrompt from "../prompts/implement-ai-retrieval-compaction-phase-b-repair.mdx";
import PhaseBReviewPrompt from "../prompts/implement-ai-retrieval-compaction-phase-b-review.mdx";
import PhaseCImplementPrompt from "../prompts/implement-ai-retrieval-compaction-phase-c-implement.mdx";
import PhaseCValidatePrompt from "../prompts/implement-ai-retrieval-compaction-phase-c-validate.mdx";
import PhaseCRepairPrompt from "../prompts/implement-ai-retrieval-compaction-phase-c-repair.mdx";
import PhaseCReviewPrompt from "../prompts/implement-ai-retrieval-compaction-phase-c-review.mdx";
import PhaseDImplementPrompt from "../prompts/implement-ai-retrieval-compaction-phase-d-implement.mdx";
import PhaseDValidatePrompt from "../prompts/implement-ai-retrieval-compaction-phase-d-validate.mdx";
import PhaseDRepairPrompt from "../prompts/implement-ai-retrieval-compaction-phase-d-repair.mdx";
import PhaseDReviewPrompt from "../prompts/implement-ai-retrieval-compaction-phase-d-review.mdx";
import PhaseEImplementPrompt from "../prompts/implement-ai-retrieval-compaction-phase-e-implement.mdx";
import PhaseEValidatePrompt from "../prompts/implement-ai-retrieval-compaction-phase-e-validate.mdx";
import PhaseERepairPrompt from "../prompts/implement-ai-retrieval-compaction-phase-e-repair.mdx";
import PhaseEReviewPrompt from "../prompts/implement-ai-retrieval-compaction-phase-e-review.mdx";
import PhaseEMigrationPreflightPrompt from "../prompts/implement-ai-retrieval-compaction-phase-e-migration-preflight.mdx";
import PhaseFImplementPrompt from "../prompts/implement-ai-retrieval-compaction-phase-f-implement.mdx";
import PhaseFValidatePrompt from "../prompts/implement-ai-retrieval-compaction-phase-f-validate.mdx";
import PhaseFRepairPrompt from "../prompts/implement-ai-retrieval-compaction-phase-f-repair.mdx";
import PhaseFReviewPrompt from "../prompts/implement-ai-retrieval-compaction-phase-f-review.mdx";
import FinalValidationPrompt from "../prompts/implement-ai-retrieval-compaction-final-full-suite-validation.mdx";
import FinalReadinessPrompt from "../prompts/implement-ai-retrieval-compaction-final-readiness.mdx";
import FinalReportPrompt from "../prompts/implement-ai-retrieval-compaction-final-report.mdx";

const PHASE_COMMANDS = {
  A: ["bunx --bun vitest run apps/worker/src/ai/retrieval/*.test.ts apps/worker/src/ai/context/*.test.ts"],
  B: ["bunx --bun vitest run apps/worker/src/ai/retrieval/*.test.ts apps/worker/src/ai/workflow/operations.test.ts apps/worker/src/ai/workflow/operations.integration.test.ts"],
  C: ["bunx --bun vitest run apps/worker/src/ai/workflow/operations.test.ts apps/worker/src/ai/workflow/operations.integration.test.ts apps/worker/src/ai/context/*.test.ts apps/worker/src/ai/runtime/provider-request.test.ts"],
  D: ["bunx --bun vitest run apps/worker/src/ai/context/*.test.ts apps/worker/src/ai/workflow/operations.test.ts apps/worker/src/ai/workflow/operations.integration.test.ts apps/worker/src/ai/workflow/phase-logging.test.ts"],
  E: ["bunx --bun vitest run apps/worker/src/ai/runtime/provider-request.test.ts apps/worker/src/ai/product-state/*.test.ts apps/worker/src/jobs/handlers.test.ts packages/backend-domain/src/chat-response.test.ts"],
  F: ["bunx --bun vitest run apps/worker/src/ai/evaluation/*.test.ts apps/worker/src/ai/workflow/phase-logging.test.ts packages/shared/src/chat.test.ts packages/api-client/src/stream.test.ts apps/web/src/components/chat/*.test.ts* apps/demo/src/*.test.ts"],
} as const;

const PROOF_COMMAND_ADDITIONS = {
  B: ["bunx --bun vitest run apps/worker/src/config.test.ts packages/config/src/index.test.ts"],
  C: ["bunx --bun vitest run apps/worker/src/ai/workflow/ai-chat.test.ts"],
  D: ["bunx --bun vitest run apps/worker/src/ai/workflow/ai-chat.test.ts apps/worker/src/config.test.ts packages/config/src/index.test.ts"],
  E: ["bunx --bun vitest run apps/worker/src/db/migrations.test.ts"],
  F: ["bunx --bun vitest run apps/worker/src/ai/e2e/deterministic-provider.test.ts apps/worker/src/ai/e2e/deterministic-provider.acceptance.test.ts"],
} as const;

const FINAL_COMMANDS = [
  "bun run check",
  "bun run lint",
  "bun run format:check",
  "bunx --bun vitest run apps/worker/src/ai/retrieval/*.test.ts apps/worker/src/ai/context/*.test.ts apps/worker/src/ai/runtime/provider-request.test.ts apps/worker/src/ai/product-state/*.test.ts",
  "bunx --bun vitest run apps/worker/src/ai/workflow/operations.test.ts apps/worker/src/ai/workflow/operations.integration.test.ts apps/worker/src/ai/workflow/phase-logging.test.ts apps/worker/src/ai/evaluation/*.test.ts apps/worker/src/jobs/handlers.test.ts packages/backend-domain/src/chat-response.test.ts packages/shared/src/chat.test.ts packages/api-client/src/stream.test.ts apps/web/src/components/chat/*.test.ts* apps/demo/src/*.test.ts",
  "bunx --bun vitest run apps/worker/src/ai/workflow/ai-chat.test.ts apps/worker/src/config.test.ts packages/config/src/index.test.ts apps/worker/src/db/migrations.test.ts apps/worker/src/ai/e2e/deterministic-provider.test.ts apps/worker/src/ai/e2e/deterministic-provider.acceptance.test.ts",
] as const;

const inputSchema = z.object({ prompt: z.string().optional().default("") });
const scopeEntrySchema = z.object({ files: z.array(z.string()), tests: z.array(z.string()), docSections: z.array(z.string()) });
const baselineSchema = z.object({ path: z.string(), gitStatus: z.string(), worktreeHash: z.string(), indexHash: z.string(), diffHash: z.string() });
const initializeSchema = z.object({
  summary: z.string(),
  planDigest: z.string(),
  canonicalSpecDigest: z.string(),
  scopeMap: z.record(z.string(), scopeEntrySchema),
  phaseCommands: z.record(z.string(), z.array(z.string())),
  proofCommandAdditions: z.record(z.string(), z.array(z.string())),
  acceptanceMap: z.record(z.string(), z.array(z.string())),
  incrementalDocPolicy: z.object({ required: z.boolean(), phaseRules: z.record(z.string(), z.array(z.string())) }),
  futurePhaseEDrainPrerequisites: z.object({ productAiRunsTerminal: z.array(z.string()), forbiddenRowsDrainedOrEmpty: z.array(z.string()), localServicesStopped: z.array(z.string()) }),
  protectedBaseline: z.array(baselineSchema),
  promptDisposition: z.enum(["accepted", "ignored", "rejected"]),
  blockers: z.array(z.string()),
});
const initializationGateSchema = z.object({
  summary: z.string(),
  passed: z.boolean(),
  mappingDigest: z.string(),
  failedPredicate: z.enum(["missing_six_phase_scope", "missing_acceptance_coverage", "prompt_rejected", "blockers", "unusable_baseline"]).nullable(),
});
const implementationSchema = z.object({
  summary: z.string(),
  changedFiles: z.array(z.string()),
  testsAddedOrChanged: z.array(z.string()),
  planSections: z.array(z.string()),
  removedLegacyPaths: z.array(z.string()),
  migrationFiles: z.array(z.string()),
  canonicalDocUpdated: z.boolean(),
  blockers: z.array(z.string()),
});
const validationSchema = z.object({ summary: z.string(), passed: z.boolean(), commands: z.array(z.string()), exitCodes: z.array(z.number().int()), failures: z.array(z.string()) });
const validationGateSchema = z.object({ summary: z.string(), passed: z.boolean(), attempts: z.number().int(), commandDigest: z.string() });
const reviewSchema = z.object({ summary: z.string(), approved: z.boolean(), evidence: z.array(z.string()), blockers: z.array(z.string()) });
const reviewGateSchema = z.object({ summary: z.string(), approved: z.boolean() });
const preflightSchema = z.object({
  summary: z.string(),
  passed: z.boolean(),
  commands: z.array(z.string()),
  migration: z.string(),
  checks: z.array(z.string()),
  productAiRuns: z.object({ terminal: z.boolean(), command: z.string(), evidence: z.array(z.string()) }),
  forbiddenRows: z.object({ drainedOrEmpty: z.boolean(), command: z.string(), evidence: z.array(z.string()) }),
  localServices: z.object({ stopped: z.boolean(), command: z.string(), evidence: z.array(z.string()) }),
  databaseReady: z.boolean(),
  backendReloadReady: z.boolean(),
  migrationUnapplied: z.boolean(),
  blockers: z.array(z.string()),
});
const migrationReadinessSchema = z.object({
  summary: z.string(),
  ready: z.boolean(),
  greenPhaseGates: z.array(z.string()),
  reviewGatesGreen: z.boolean(),
  protectedStateIntact: z.boolean(),
  migrationFileReady: z.boolean(),
  productAiRunsTerminal: z.boolean(),
  forbiddenRowsDrainedOrEmpty: z.boolean(),
  servicesStopped: z.boolean(),
  databaseReady: z.boolean(),
  backendReloadReady: z.boolean(),
  migrationUnapplied: z.boolean(),
  migrationPreflightPassed: z.boolean(),
  evidenceDigest: z.string(),
  blockers: z.array(z.string()),
});
const approvalSchema = z.object({ approved: z.boolean(), note: z.string().nullable(), decidedBy: z.string().nullable(), decidedAt: z.string().nullable() });
const migrationSchema = z.object({ summary: z.string(), command: z.string(), passed: z.boolean(), exitCode: z.number().int(), appliedMigrations: z.array(z.string()), readinessEvidenceDigest: z.string() });
const finalEvidenceSchema = z.object({
  summary: z.string(),
  changedFiles: z.array(z.string()),
  protectedStateIntact: z.boolean(),
  protectedStateDifferences: z.array(z.string()),
  cleanCutoverPassed: z.boolean(),
  legacyFindings: z.array(z.string()),
  canonicalDocPassed: z.boolean(),
  effectRulesPassed: z.boolean(),
  migrationAndRunbookPassed: z.boolean(),
  legacyDeletionPassed: z.boolean(),
  agentsFileUnchanged: z.boolean(),
  protected0071MigrationUnchanged: z.boolean(),
  noCustomUiPassed: z.boolean(),
  staleMigrationReferences: z.array(z.string()),
  migrationEvidence: z.array(z.string()),
  phaseEPreflightEvidence: z.record(z.string(), z.unknown()),
});
const finalReadinessSchema = z.object({
  summary: z.string(),
  ready: z.boolean(),
  initializationScopeMap: z.record(z.string(), z.unknown()),
  initializationAcceptanceMap: z.record(z.string(), z.unknown()),
  incrementalDocPolicy: z.record(z.string(), z.unknown()),
  phaseResults: z.array(z.record(z.string(), z.unknown())),
  validationHistory: z.array(z.record(z.string(), z.unknown())),
  reviewHistory: z.array(z.record(z.string(), z.unknown())),
  phaseEPreflight: z.record(z.string(), z.unknown()),
  migrationResult: z.record(z.string(), z.unknown()),
  acceptanceCoverage: z.array(z.string()),
  protectedStateIntact: z.boolean(),
  cleanCutoverPassed: z.boolean(),
  changedFiles: z.array(z.string()),
  blockers: z.array(z.string()),
});
const finalReportSchema = z.object({
  summary: z.string(),
  initializationScopeMap: z.record(z.string(), z.unknown()),
  initializationAcceptanceMap: z.record(z.string(), z.unknown()),
  incrementalDocPolicy: z.record(z.string(), z.unknown()),
  phaseResults: z.array(z.record(z.string(), z.unknown())),
  validationHistory: z.array(z.record(z.string(), z.unknown())),
  reviewHistory: z.array(z.record(z.string(), z.unknown())),
  phaseEPreflight: z.record(z.string(), z.unknown()),
  changedFiles: z.array(z.string()),
  migrationResult: z.record(z.string(), z.unknown()),
  acceptanceCoverage: z.array(z.string()),
  protectedStateIntact: z.boolean(),
  cleanCutoverPassed: z.boolean(),
  readiness: z.enum(["green", "blocked"]),
  blockers: z.array(z.string()),
});
const gateSchema = z.object({ summary: z.string(), ready: z.boolean() });

const { Workflow, Task, Sequence, Branch, Loop, Approval, smithers, outputs } = createSmithers({
  input: inputSchema,
  initialize: initializeSchema,
  initializationGate: initializationGateSchema,
  phaseAImplement: implementationSchema,
  phaseAFocusedValidation: validationSchema,
  phaseARepair: implementationSchema,
  phaseARevalidation: validationSchema,
  phaseAValidationGate: validationGateSchema,
  phaseAReview: reviewSchema,
  phaseAReviewGate: reviewGateSchema,
  phaseBImplement: implementationSchema,
  phaseBFocusedValidation: validationSchema,
  phaseBRepair: implementationSchema,
  phaseBRevalidation: validationSchema,
  phaseBValidationGate: validationGateSchema,
  phaseBReview: reviewSchema,
  phaseBReviewGate: reviewGateSchema,
  phaseCImplement: implementationSchema,
  phaseCFocusedValidation: validationSchema,
  phaseCRepair: implementationSchema,
  phaseCRevalidation: validationSchema,
  phaseCValidationGate: validationGateSchema,
  phaseCReview: reviewSchema,
  phaseCReviewGate: reviewGateSchema,
  phaseDImplement: implementationSchema,
  phaseDFocusedValidation: validationSchema,
  phaseDRepair: implementationSchema,
  phaseDRevalidation: validationSchema,
  phaseDValidationGate: validationGateSchema,
  phaseDReview: reviewSchema,
  phaseDReviewGate: reviewGateSchema,
  phaseEImplement: implementationSchema,
  phaseEFocusedValidation: validationSchema,
  phaseERepair: implementationSchema,
  phaseERevalidation: validationSchema,
  phaseEValidationGate: validationGateSchema,
  phaseEReview: reviewSchema,
  phaseEReviewGate: reviewGateSchema,
  phaseEMigrationPreflight: preflightSchema,
  phaseEMigrationReadiness: migrationReadinessSchema,
  migrationApproval: approvalSchema,
  phaseEMigrate: migrationSchema,
  phaseFImplement: implementationSchema,
  phaseFFocusedValidation: validationSchema,
  phaseFRepair: implementationSchema,
  phaseFRevalidation: validationSchema,
  phaseFValidationGate: validationGateSchema,
  phaseFReview: reviewSchema,
  phaseFReviewGate: reviewGateSchema,
  finalFullSuiteValidation: validationSchema,
  finalEvidenceSnapshot: finalEvidenceSchema,
  finalReadiness: finalReadinessSchema,
  finalReport: finalReportSchema,
  finalReadinessGate: gateSchema,
});

const REPO_ROOT = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
})();

function repoFile(path: string): string {
  return resolve(REPO_ROOT, path);
}


type AnyRow = Record<string, any>;
type WorkflowCtx = { input: z.input<typeof inputSchema>; outputs: Record<string, AnyRow[]>; outputMaybe: (table: unknown, options: { nodeId: string }) => AnyRow | undefined; latest: (table: unknown, nodeId: string) => AnyRow | undefined };
type Baseline = z.infer<typeof baselineSchema>;

function commandText(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function rawCommandText(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

function fileHash(path: string): string {
  const absolutePath = repoFile(path);
  return existsSync(absolutePath) ? createHash("sha256").update(readFileSync(absolutePath)).digest("hex") : "";
}

function fingerprint(path: string): Baseline {
  const gitStatus = rawCommandText("git", ["status", "--short", "--", path]);
  const worktreeHash = commandText("git", ["hash-object", "--", path]) || fileHash(path);
  const indexHash = commandText("git", ["ls-files", "--stage", "--", path]).split(/\s+/)[1] ?? "";
  const diffHash = createHash("sha256").update(rawCommandText("git", ["diff", "--no-ext-diff", "--", path])).digest("hex");
  return { path, gitStatus, worktreeHash, indexHash, diffHash };
}

function fingerprintMatches(saved: Baseline): boolean {
  const current = fingerprint(saved.path);
  const legacyDiffHash = createHash("sha256").update(rawCommandText("git", ["diff", "--no-ext-diff", "--", saved.path]).trim()).digest("hex");
  return (
    saved.path === current.path &&
    saved.worktreeHash === current.worktreeHash &&
    saved.indexHash === current.indexHash &&
    (saved.gitStatus === current.gitStatus || saved.gitStatus === current.gitStatus.trim()) &&
    (saved.diffHash === current.diffHash || saved.diffHash === legacyDiffHash)
  );
}
function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(String).filter(Boolean))];
}

function changedFiles(): string[] {
  return unique([
    ...commandText("git", ["diff", "--name-only"]).split("\n"),
    ...commandText("git", ["diff", "--cached", "--name-only"]).split("\n"),
    ...commandText("git", ["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ]);
}

function latestRow(ctx: WorkflowCtx, table: string, nodeId?: string): AnyRow | undefined {
  const rows = ctx.outputs[table] ?? [];
  return [...rows].reverse().find((row) => !nodeId || String(row.nodeId ?? "") === nodeId);
}

function phaseValidationGate(
  ctx: WorkflowCtx,
  initialTable: string,
  revalidationTable: string,
  initialNode: string,
  revalidationNode: string,
): z.infer<typeof validationGateSchema> {
  const initial = latestRow(ctx, initialTable, initialNode);
  const revalidations = (ctx.outputs[revalidationTable] ?? []).filter(
    (row) => String(row.nodeId ?? "") === revalidationNode,
  );
  const passing = initial?.passed === true || revalidations.some((row) => row.passed === true);
  const selected = passing ? revalidations.find((row) => row.passed === true) ?? initial : revalidations.at(-1) ?? initial;
  const commands = Array.isArray(selected?.commands) ? selected.commands : [];
  return {
    summary: passing ? "Validation passed within the allowed attempts." : "Validation failed after the allowed attempts.",
    passed: passing,
    attempts: 1 + revalidations.length,
    commandDigest: createHash("sha256").update(JSON.stringify(commands)).digest("hex"),
  };
}
function needsValidationRepair(ctx: WorkflowCtx, initialTable: string, gateTable: string, gateNode: string): boolean {
  return latestRow(ctx, gateTable, gateNode)?.passed !== true && latestRow(ctx, initialTable)?.passed === false;
}

function assertReview(ctx: WorkflowCtx, table: string, nodeId: string, phase: string): z.infer<typeof reviewGateSchema> {
  const review = latestRow(ctx, table, nodeId);
  if (review?.approved !== true || (review.blockers?.length ?? 0) > 0) throw new Error(`${phase} review is not approved or has blockers.`);
  return { summary: `${phase} review approved with no blockers.`, approved: true };
}

function assertInitialization(ctx: WorkflowCtx): z.infer<typeof initializationGateSchema> {
  const row = latestRow(ctx, "initialize", "initialize");
  const scopeKeys = Object.keys(row?.scopeMap ?? {});
  const requiredPhases = ["A", "B", "C", "D", "E", "F"];
  const missingScope = requiredPhases.some((phase) => !scopeKeys.includes(phase) || !row?.scopeMap?.[phase]?.files?.length || !row.scopeMap[phase]?.tests?.length || !row.scopeMap[phase]?.docSections?.length);
  const acceptance = row?.acceptanceMap ?? {};
  const additions = row?.proofCommandAdditions ?? {};
  const docs = row?.incrementalDocPolicy;
  const missingAcceptance = Object.keys(acceptance).length < 15 || !Object.keys(additions).length || docs?.required !== true || Object.keys(docs.phaseRules ?? {}).length < 6;
  const protectedPaths = new Set((row?.protectedBaseline ?? []).map((entry: AnyRow) => entry.path));
  const missingProtectedPaths = !protectedPaths.has(".smithers/agents.ts") || !protectedPaths.has("db/migrations/0071_chat_archive_and_replace.sql");
  const failedPredicates = [
    ...(missingScope ? ["missing_six_phase_scope"] : []),
    ...(missingAcceptance ? ["missing_acceptance_coverage"] : []),
    ...(row?.promptDisposition === "rejected" ? ["prompt_rejected"] : []),
    ...((row?.blockers?.length ?? 0) > 0 ? ["blockers"] : []),
    ...(!(Array.isArray(row?.protectedBaseline) && row.protectedBaseline.length > 0 && !missingProtectedPaths && row.protectedBaseline.every((entry: AnyRow) => Object.values(entry).every((value) => typeof value === "string"))) ? ["unusable_baseline"] : []),
  ] as Array<z.infer<typeof initializationGateSchema>["failedPredicate"]>;
  if (failedPredicates.length > 0) throw new Error(`initialization:${failedPredicates.join(",")}`);
  return {
    summary: "Initialization scope, acceptance coverage, incremental docs, and protected baseline are usable.",
    passed: true,
    mappingDigest: createHash("sha256").update(JSON.stringify({ scopeMap: row?.scopeMap, phaseCommands: row?.phaseCommands, proofCommandAdditions: additions, acceptanceMap: acceptance })).digest("hex"),
    failedPredicate: null,
  };
}

function protectedStateIntact(ctx: WorkflowCtx): boolean {
  const baseline = (latestRow(ctx, "initialize", "initialize")?.protectedBaseline ?? []) as Baseline[];
  return baseline.every((entry) => fingerprintMatches(entry));
}


function assertMigrationReadiness(ctx: WorkflowCtx): z.infer<typeof migrationReadinessSchema> {
  const phaseLetters = ["A", "B", "C", "D", "E"];
  const validationTables = phaseLetters.map((phase) => `phase${phase}ValidationGate`);
  const reviewTables = phaseLetters.map((phase) => `phase${phase}ReviewGate`);
  const greenPhaseGates = validationTables.filter((table) => latestRow(ctx, table)?.passed === true).map((table) => table.replace(/([A-Z])/g, "-$1").toLowerCase());
  const reviewGatesGreen = reviewTables.every((table) => latestRow(ctx, table)?.approved === true);
  const preflight = latestRow(ctx, "phaseEMigrationPreflight", "phase-e-migration-preflight");
  const migrationFileReady = existsSync(repoFile("db/migrations/0072_ai_retrieval_compaction.sql"));
  const productAiRunsTerminal = preflight?.productAiRuns?.terminal === true && (preflight.productAiRuns.evidence?.length ?? 0) > 0;
  const forbiddenRowsDrainedOrEmpty = preflight?.forbiddenRows?.drainedOrEmpty === true && (preflight.forbiddenRows.evidence?.length ?? 0) > 0;
  const servicesStopped = preflight?.localServices?.stopped === true && (preflight.localServices.evidence?.length ?? 0) > 0;
  const databaseReady = preflight?.databaseReady === true;
  const backendReloadReady = preflight?.backendReloadReady === true;
  const migrationUnapplied = preflight?.migrationUnapplied === true;
  const migrationPreflightPassed = preflight?.passed === true;
  const stateIntact = protectedStateIntact(ctx);
  const blockers = [
    ...(greenPhaseGates.length === phaseLetters.length ? [] : ["Phase A-E validation gates are not all green."]),
    ...(reviewGatesGreen ? [] : ["Phase A-E review gates are not all green."]),
    ...(stateIntact ? [] : ["Protected baseline changed."]),
    ...(migrationFileReady ? [] : ["Migration 0072 is missing."]),
    ...(productAiRunsTerminal ? [] : ["Product AI run terminal evidence is missing."]),
    ...(forbiddenRowsDrainedOrEmpty ? [] : ["Forbidden Smithers row drain evidence is missing."]),
    ...(servicesStopped ? [] : ["Local service stop evidence is missing."]),
    ...(databaseReady ? [] : ["Database readiness evidence is missing."]),
    ...(backendReloadReady ? [] : ["Backend reload readiness evidence is missing."]),
    ...(migrationUnapplied ? [] : ["Migration 0072 is not proven unapplied."]),
    ...(migrationPreflightPassed ? [] : ["Migration preflight did not pass."]),
  ];
  const ready = blockers.length === 0;
  const evidenceDigest = createHash("sha256").update(JSON.stringify({ preflight, greenPhaseGates, reviewGatesGreen, stateIntact, migrationFileReady })).digest("hex");
  if (!ready) throw new Error(`migration-readiness:${blockers.join(" ")}`);
  return { summary: "Migration 0072 is ready for the sole approval.", ready, greenPhaseGates, reviewGatesGreen, protectedStateIntact: stateIntact, migrationFileReady, productAiRunsTerminal, forbiddenRowsDrainedOrEmpty, servicesStopped, databaseReady, backendReloadReady, migrationUnapplied, migrationPreflightPassed, evidenceDigest, blockers };
}

function runMigration(ctx: WorkflowCtx): z.infer<typeof migrationSchema> {
  if (latestRow(ctx, "phaseEMigrate", "phase-e-migrate")) throw new Error("phase-e-migrate may execute only once.");
  const readiness = latestRow(ctx, "phaseEMigrationReadiness", "phase-e-migration-readiness");
  if (readiness?.ready !== true) throw new Error("Migration readiness was not approved.");
  const command = "bun run db:migrate";
  try {
    const output = execFileSync("bun", ["run", "db:migrate"], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const evidence = output.split(/\r?\n/).filter((line) => /0072|migrat|appl/i.test(line));
    if (!evidence.some((line) => line.includes("0072"))) throw new Error("Migration output did not name 0072.");
    return { summary: "Migration 0072 completed once with named output.", command, passed: true, exitCode: 0, appliedMigrations: evidence, readinessEvidenceDigest: String(readiness.evidenceDigest ?? "") };
  } catch (error) {
    const exitCode = typeof error === "object" && error && "status" in error && typeof error.status === "number" ? error.status : 1;
    throw new Error(`Migration 0072 failed with exit code ${exitCode}.`);
  }
}

function collectFinalEvidence(ctx: WorkflowCtx): z.infer<typeof finalEvidenceSchema> {
  const baseline = (latestRow(ctx, "initialize", "initialize")?.protectedBaseline ?? []) as Baseline[];
  const protectedDifferences = baseline.filter((entry) => !fingerprintMatches(entry)).map((entry) => entry.path);
  const scanPaths = changedFiles().filter((path) => !path.startsWith(".smithers/"));
  const legacyPatterns = ["InternalRetrievalPrompt", "ContextDecisionPrompt", "ContextReducerTerminalPrompt", "InternalRetrievalSearchProtocol", "InternalSearchCalls", "inspect_internal", "search_internal", "InternalRetrievalLoop", "ContextReductionLoop", "AI_CONTEXT_REDUCTION_MAX_ITERATIONS", "query-correction", "inspection-required"];
  const legacyFindings: string[] = [];
  for (const path of scanPaths) {
    if (!existsSync(repoFile(path))) continue;
    const contents = readFileSync(repoFile(path), "utf8");
    for (const pattern of legacyPatterns) if (contents.includes(pattern)) legacyFindings.push(`${path}: ${pattern}`);
  }
  const staleMigrationName = ["0071", "ai", "retrieval", "compaction"].join("_");
  const staleMigrationReferences: string[] = [];
  for (const path of changedFiles().filter((entry) => entry.startsWith(".smithers/"))) {
    if (!existsSync(repoFile(path))) continue;
    const contents = readFileSync(repoFile(path), "utf8");
    if (contents.includes(staleMigrationName) || contents.includes(["Migration", "0071"].join(" "))) staleMigrationReferences.push(path);
  }
  const init = latestRow(ctx, "initialize", "initialize");
  const phaseF = latestRow(ctx, "phaseFImplement", "phase-f-implement");
  const migration = latestRow(ctx, "phaseEMigrate", "phase-e-migrate");
  const canonicalDocPassed = existsSync(repoFile("docs/ai-chat-runtime.spec.md")) && phaseF?.canonicalDocUpdated === true;
  const effectRulesPassed = existsSync(repoFile("docs/references/effect-smol"));
  const migrationAndRunbookPassed = phaseF?.planSections?.some((section: string) => /migration|runbook/i.test(section)) === true;
  const legacyDeletionPassed = phaseF?.removedLegacyPaths?.length > 0 && legacyFindings.length === 0;
  const baselinePaths = new Set(baseline.map((entry) => entry.path));
  const agentsFileUnchanged = baselinePaths.has(".smithers/agents.ts") && protectedStateIntact(ctx) && !changedFiles().includes(".smithers/agents.ts");
  const protected0071MigrationUnchanged = baselinePaths.has("db/migrations/0071_chat_archive_and_replace.sql") && protectedStateIntact(ctx) && !changedFiles().includes("db/migrations/0071_chat_archive_and_replace.sql");
  const noCustomUiPassed = !existsSync(repoFile(".smithers/ui/implement-ai-retrieval-compaction.tsx")) && !readFileSync(repoFile(".smithers/workflows/implement-ai-retrieval-compaction.tsx"), "utf8").includes("<" + "UI ");
  const migrationEvidence = Array.isArray(migration?.appliedMigrations) ? migration.appliedMigrations : [];
  const phaseEPreflightEvidence = latestRow(ctx, "phaseEMigrationPreflight", "phase-e-migration-preflight") ?? {};
  const cleanCutoverPassed = legacyFindings.length === 0 && staleMigrationReferences.length === 0;
  const allPassed = protectedDifferences.length === 0 && cleanCutoverPassed && canonicalDocPassed && effectRulesPassed && migrationAndRunbookPassed && legacyDeletionPassed && agentsFileUnchanged && protected0071MigrationUnchanged && noCustomUiPassed && migrationEvidence.some((line: string) => line.includes("0072"));
  return {
    summary: allPassed ? "Final evidence is complete and clean." : "Final evidence contains one or more blockers.",
    changedFiles: changedFiles(),
    protectedStateIntact: protectedDifferences.length === 0,
    protectedStateDifferences: protectedDifferences,
    cleanCutoverPassed,
    legacyFindings,
    canonicalDocPassed,
    effectRulesPassed,
    migrationAndRunbookPassed,
    legacyDeletionPassed,
    agentsFileUnchanged,
    protected0071MigrationUnchanged,
    noCustomUiPassed,
    staleMigrationReferences,
    migrationEvidence,
    phaseEPreflightEvidence,
  };
}

function finalReadinessInput(ctx: WorkflowCtx) {
  const init = latestRow(ctx, "initialize", "initialize") ?? {};
  const evidence = latestRow(ctx, "finalEvidenceSnapshot", "final-evidence-snapshot") ?? {};
  const migration = latestRow(ctx, "phaseEMigrate", "phase-e-migrate") ?? {};
  const phaseLetters = ["A", "B", "C", "D", "E", "F"];
  const phaseResults = phaseLetters.map((phase) => ({ phase, implementation: latestRow(ctx, `phase${phase}Implement`), validation: latestRow(ctx, `phase${phase}ValidationGate`), review: latestRow(ctx, `phase${phase}ReviewGate`) }));
  const validationHistory = phaseLetters.flatMap((phase) => ctx.outputs[`phase${phase}FocusedValidation`] ?? []).concat(ctx.outputs.finalFullSuiteValidation ?? []);
  const reviewHistory = phaseLetters.flatMap((phase) => ctx.outputs[`phase${phase}Review`] ?? []);
  const acceptanceCoverage = Object.entries(init.acceptanceMap ?? {}).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  const preflight = latestRow(ctx, "phaseEMigrationPreflight", "phase-e-migration-preflight") ?? {};
  const blockers = [
    ...phaseResults.filter((row) => row.validation?.passed !== true || row.review?.approved !== true).map((row) => `Phase ${row.phase} gates are not green.`),
    ...(latestRow(ctx, "finalFullSuiteValidation", "final-full-suite-validation")?.passed === true ? [] : ["Final full-suite validation failed."]),
    ...(migration.passed === true && migration.appliedMigrations?.some((line: string) => line.includes("0072")) ? [] : ["Migration 0072 lacks once-only evidence."]),
    ...(evidence.protectedStateIntact === true ? [] : ["Protected state is not intact."]),
    ...(evidence.cleanCutoverPassed === true ? [] : ["Clean cutover checks failed."]),
    ...(evidence.canonicalDocPassed === true && evidence.effectRulesPassed === true ? [] : ["Canonical docs or Effect rules are not reconciled."]),
    ...(evidence.migrationAndRunbookPassed === true ? [] : ["Migration and runbook text is incomplete."]),
    ...(evidence.noCustomUiPassed === true ? [] : ["The workflow declares a custom UI."]),
    ...(preflight.productAiRuns?.terminal === true && preflight.forbiddenRows?.drainedOrEmpty === true && preflight.localServices?.stopped === true ? [] : ["Phase E preflight evidence is incomplete."]),
  ];
  return {
    summary: blockers.length === 0 ? "All readiness requirements have concrete evidence." : "Readiness is blocked by missing evidence.",
    ready: blockers.length === 0,
    initializationScopeMap: init.scopeMap ?? {},
    initializationAcceptanceMap: init.acceptanceMap ?? {},
    incrementalDocPolicy: init.incrementalDocPolicy ?? {},
    phaseResults,
    validationHistory,
    reviewHistory,
    phaseEPreflight: preflight,
    migrationResult: migration,
    acceptanceCoverage,
    protectedStateIntact: evidence.protectedStateIntact === true,
    cleanCutoverPassed: evidence.cleanCutoverPassed === true,
    changedFiles: evidence.changedFiles ?? changedFiles(),
    blockers,
  };
}

function assertFinalReadiness(ctx: WorkflowCtx): z.infer<typeof gateSchema> {
  const readiness = latestRow(ctx, "finalReadiness", "final-readiness");
  const report = latestRow(ctx, "finalReport", "final-report");
  const evidence = latestRow(ctx, "finalEvidenceSnapshot", "final-evidence-snapshot");
  const finalSuite = latestRow(ctx, "finalFullSuiteValidation", "final-full-suite-validation");
  const phases = ["A", "B", "C", "D", "E", "F"];
  const phaseGatesGreen = phases.every((phase) => latestRow(ctx, `phase${phase}ValidationGate`)?.passed === true && latestRow(ctx, `phase${phase}ReviewGate`)?.approved === true);
  const init = latestRow(ctx, "initialize", "initialize");
  const preflight = latestRow(ctx, "phaseEMigrationPreflight", "phase-e-migration-preflight");
  const migration = latestRow(ctx, "phaseEMigrate", "phase-e-migrate");
  const ready = readiness?.ready === true && report?.readiness === "green" && (report?.blockers?.length ?? 1) === 0 && (readiness?.blockers?.length ?? 1) === 0 && phaseGatesGreen && finalSuite?.passed === true && migration?.passed === true && migration.appliedMigrations?.some((line: string) => line.includes("0072")) && init?.scopeMap && init?.acceptanceMap && init?.incrementalDocPolicy && preflight?.productAiRuns?.evidence?.length && preflight?.forbiddenRows?.evidence?.length && preflight?.localServices?.evidence?.length && evidence?.protectedStateIntact === true && evidence?.cleanCutoverPassed === true && evidence?.canonicalDocPassed === true && evidence?.effectRulesPassed === true && evidence?.migrationAndRunbookPassed === true && evidence?.legacyDeletionPassed === true && evidence?.agentsFileUnchanged === true && evidence?.protected0071MigrationUnchanged === true && evidence?.noCustomUiPassed === true && evidence?.staleMigrationReferences?.length === 0;
  if (!ready) throw new Error("final-readiness:required evidence is missing or blocked.");
  return { summary: "Final readiness is green with complete evidence.", ready: true };
}

export default smithers((ctx) => {
  const prompt = ctx.input.prompt ?? "";
  const init = ctx.outputMaybe("initialize", { nodeId: "initialize" });
  const aValidation = ctx.outputMaybe("phaseAFocusedValidation", { nodeId: "phase-a-focused-validation" });
  const bValidation = ctx.outputMaybe("phaseBFocusedValidation", { nodeId: "phase-b-focused-validation" });
  const cValidation = ctx.outputMaybe("phaseCFocusedValidation", { nodeId: "phase-c-focused-validation" });
  const dValidation = ctx.outputMaybe("phaseDFocusedValidation", { nodeId: "phase-d-focused-validation" });
  const eValidation = ctx.outputMaybe("phaseEFocusedValidation", { nodeId: "phase-e-focused-validation" });
  const fValidation = ctx.outputMaybe("phaseFFocusedValidation", { nodeId: "phase-f-focused-validation" });

  return (
    <Workflow name="implement-ai-retrieval-compaction">
      <Sequence>
        <Task id="initialize" output={outputs.initialize} agent={agents.review}>
          <InitializePrompt prompt={prompt} phaseCommands={PHASE_COMMANDS} proofCommandAdditions={PROOF_COMMAND_ADDITIONS} finalCommands={FINAL_COMMANDS} />
        </Task>
        <Task id="initialization-gate" output={outputs.initializationGate} retries={0}>{() => assertInitialization(ctx as unknown as WorkflowCtx)}</Task>

        <Sequence>
          <Task id="phase-a-implement" output={outputs.phaseAImplement} agent={agents.write}><PhaseAImplementPrompt plan={init} /></Task>
          <Task id="phase-a-focused-validation" output={outputs.phaseAFocusedValidation} agent={agents.review}><PhaseAValidatePrompt context={{ plan: init, implementation: ctx.outputMaybe("phaseAImplement", { nodeId: "phase-a-implement" }) }} commands={[...PHASE_COMMANDS.A]} /></Task>
          <Branch if={needsValidationRepair(ctx as unknown as WorkflowCtx, "phaseAFocusedValidation", "phaseAValidationGate", "phase-a-validation-gate")} then={<Loop id="phase-a-validation-repair-loop" until={ctx.latest(outputs.phaseARevalidation, "phase-a-revalidation")?.passed === true} maxIterations={3} onMaxReached="fail"><Sequence><Task id="phase-a-repair" output={outputs.phaseARepair} agent={agents.write}><PhaseARepairPrompt plan={init} validation={aValidation} /></Task><Task id="phase-a-revalidation" output={outputs.phaseARevalidation} agent={agents.review}><PhaseAValidatePrompt context={{ plan: init, repair: ctx.latest(outputs.phaseARepair, "phase-a-repair") }} commands={[...PHASE_COMMANDS.A]} /></Task></Sequence></Loop>} else={null} />
          <Task id="phase-a-validation-gate" output={outputs.phaseAValidationGate} retries={0}>{() => phaseValidationGate(ctx as unknown as WorkflowCtx, "phaseAFocusedValidation", "phaseARevalidation", "phase-a-focused-validation", "phase-a-revalidation")}</Task>
          <Task id="phase-a-review" output={outputs.phaseAReview} agent={agents.review}><PhaseAReviewPrompt plan={init} validation={ctx.outputMaybe("phaseAValidationGate", { nodeId: "phase-a-validation-gate" })} /></Task>
          <Task id="phase-a-review-gate" output={outputs.phaseAReviewGate} retries={0}>{() => assertReview(ctx as unknown as WorkflowCtx, "phaseAReview", "phase-a-review", "Phase A")}</Task>
        </Sequence>

        <Sequence>
          <Task id="phase-b-implement" output={outputs.phaseBImplement} agent={agents.write}><PhaseBImplementPrompt plan={init} previousPhase={ctx.outputMaybe("phaseAReviewGate", { nodeId: "phase-a-review-gate" })} /></Task>
          <Task id="phase-b-focused-validation" output={outputs.phaseBFocusedValidation} agent={agents.review}><PhaseBValidatePrompt context={{ plan: init, implementation: ctx.outputMaybe("phaseBImplement", { nodeId: "phase-b-implement" }) }} commands={[...PHASE_COMMANDS.B, ...PROOF_COMMAND_ADDITIONS.B]} /></Task>
          <Branch if={needsValidationRepair(ctx as unknown as WorkflowCtx, "phaseBFocusedValidation", "phaseBValidationGate", "phase-b-validation-gate")} then={<Loop id="phase-b-validation-repair-loop" until={ctx.latest(outputs.phaseBRevalidation, "phase-b-revalidation")?.passed === true} maxIterations={3} onMaxReached="fail"><Sequence><Task id="phase-b-repair" output={outputs.phaseBRepair} agent={agents.write}><PhaseBRepairPrompt plan={init} validation={bValidation} /></Task><Task id="phase-b-revalidation" output={outputs.phaseBRevalidation} agent={agents.review}><PhaseBValidatePrompt context={{ plan: init, repair: ctx.latest(outputs.phaseBRepair, "phase-b-repair") }} commands={[...PHASE_COMMANDS.B, ...PROOF_COMMAND_ADDITIONS.B]} /></Task></Sequence></Loop>} else={null} />
          <Task id="phase-b-validation-gate" output={outputs.phaseBValidationGate} retries={0}>{() => phaseValidationGate(ctx as unknown as WorkflowCtx, "phaseBFocusedValidation", "phaseBRevalidation", "phase-b-focused-validation", "phase-b-revalidation")}</Task>
          <Task id="phase-b-review" output={outputs.phaseBReview} agent={agents.review}><PhaseBReviewPrompt plan={init} validation={ctx.outputMaybe("phaseBValidationGate", { nodeId: "phase-b-validation-gate" })} /></Task>
          <Task id="phase-b-review-gate" output={outputs.phaseBReviewGate} retries={0}>{() => assertReview(ctx as unknown as WorkflowCtx, "phaseBReview", "phase-b-review", "Phase B")}</Task>
        </Sequence>

        <Sequence>
          <Task id="phase-c-implement" output={outputs.phaseCImplement} agent={agents.write}><PhaseCImplementPrompt plan={init} previousPhase={ctx.outputMaybe("phaseBReviewGate", { nodeId: "phase-b-review-gate" })} /></Task>
          <Task id="phase-c-focused-validation" output={outputs.phaseCFocusedValidation} agent={agents.review}><PhaseCValidatePrompt context={{ plan: init, implementation: ctx.outputMaybe("phaseCImplement", { nodeId: "phase-c-implement" }) }} commands={[...PHASE_COMMANDS.C, ...PROOF_COMMAND_ADDITIONS.C]} /></Task>
          <Branch if={needsValidationRepair(ctx as unknown as WorkflowCtx, "phaseCFocusedValidation", "phaseCValidationGate", "phase-c-validation-gate")} then={<Loop id="phase-c-validation-repair-loop" until={ctx.latest(outputs.phaseCRevalidation, "phase-c-revalidation")?.passed === true} maxIterations={3} onMaxReached="fail"><Sequence><Task id="phase-c-repair" output={outputs.phaseCRepair} agent={agents.write}><PhaseCRepairPrompt plan={init} validation={cValidation} /></Task><Task id="phase-c-revalidation" output={outputs.phaseCRevalidation} agent={agents.review}><PhaseCValidatePrompt context={{ plan: init, repair: ctx.latest(outputs.phaseCRepair, "phase-c-repair") }} commands={[...PHASE_COMMANDS.C, ...PROOF_COMMAND_ADDITIONS.C]} /></Task></Sequence></Loop>} else={null} />
          <Task id="phase-c-validation-gate" output={outputs.phaseCValidationGate} retries={0}>{() => phaseValidationGate(ctx as unknown as WorkflowCtx, "phaseCFocusedValidation", "phaseCRevalidation", "phase-c-focused-validation", "phase-c-revalidation")}</Task>
          <Task id="phase-c-review" output={outputs.phaseCReview} agent={agents.review}><PhaseCReviewPrompt plan={init} validation={ctx.outputMaybe("phaseCValidationGate", { nodeId: "phase-c-validation-gate" })} /></Task>
          <Task id="phase-c-review-gate" output={outputs.phaseCReviewGate} retries={0}>{() => assertReview(ctx as unknown as WorkflowCtx, "phaseCReview", "phase-c-review", "Phase C")}</Task>
        </Sequence>

        <Sequence>
          <Task id="phase-d-implement" output={outputs.phaseDImplement} agent={agents.write}><PhaseDImplementPrompt plan={init} previousPhase={ctx.outputMaybe("phaseCReviewGate", { nodeId: "phase-c-review-gate" })} /></Task>
          <Task id="phase-d-focused-validation" output={outputs.phaseDFocusedValidation} agent={agents.review}><PhaseDValidatePrompt context={{ plan: init, implementation: ctx.outputMaybe("phaseDImplement", { nodeId: "phase-d-implement" }) }} commands={[...PHASE_COMMANDS.D, ...PROOF_COMMAND_ADDITIONS.D]} /></Task>
          <Branch if={needsValidationRepair(ctx as unknown as WorkflowCtx, "phaseDFocusedValidation", "phaseDValidationGate", "phase-d-validation-gate")} then={<Loop id="phase-d-validation-repair-loop" until={ctx.latest(outputs.phaseDRevalidation, "phase-d-revalidation")?.passed === true} maxIterations={3} onMaxReached="fail"><Sequence><Task id="phase-d-repair" output={outputs.phaseDRepair} agent={agents.write}><PhaseDRepairPrompt plan={init} validation={dValidation} /></Task><Task id="phase-d-revalidation" output={outputs.phaseDRevalidation} agent={agents.review}><PhaseDValidatePrompt context={{ plan: init, repair: ctx.latest(outputs.phaseDRepair, "phase-d-repair") }} commands={[...PHASE_COMMANDS.D, ...PROOF_COMMAND_ADDITIONS.D]} /></Task></Sequence></Loop>} else={null} />
          <Task id="phase-d-validation-gate" output={outputs.phaseDValidationGate} retries={0}>{() => phaseValidationGate(ctx as unknown as WorkflowCtx, "phaseDFocusedValidation", "phaseDRevalidation", "phase-d-focused-validation", "phase-d-revalidation")}</Task>
          <Task id="phase-d-review" output={outputs.phaseDReview} agent={agents.review}><PhaseDReviewPrompt plan={init} validation={ctx.outputMaybe("phaseDValidationGate", { nodeId: "phase-d-validation-gate" })} /></Task>
          <Task id="phase-d-review-gate" output={outputs.phaseDReviewGate} retries={0}>{() => assertReview(ctx as unknown as WorkflowCtx, "phaseDReview", "phase-d-review", "Phase D")}</Task>
        </Sequence>

        <Sequence>
          <Task id="phase-e-implement" output={outputs.phaseEImplement} agent={agents.write}><PhaseEImplementPrompt plan={init} previousPhase={ctx.outputMaybe("phaseDReviewGate", { nodeId: "phase-d-review-gate" })} /></Task>
          <Task id="phase-e-focused-validation" output={outputs.phaseEFocusedValidation} agent={agents.review}><PhaseEValidatePrompt context={{ plan: init, implementation: ctx.outputMaybe("phaseEImplement", { nodeId: "phase-e-implement" }) }} commands={[...PHASE_COMMANDS.E, ...PROOF_COMMAND_ADDITIONS.E]} /></Task>
          <Branch if={needsValidationRepair(ctx as unknown as WorkflowCtx, "phaseEFocusedValidation", "phaseEValidationGate", "phase-e-validation-gate")} then={<Loop id="phase-e-validation-repair-loop" until={ctx.latest(outputs.phaseERevalidation, "phase-e-revalidation")?.passed === true} maxIterations={3} onMaxReached="fail"><Sequence><Task id="phase-e-repair" output={outputs.phaseERepair} agent={agents.write}><PhaseERepairPrompt plan={init} validation={eValidation} /></Task><Task id="phase-e-revalidation" output={outputs.phaseERevalidation} agent={agents.review}><PhaseEValidatePrompt context={{ plan: init, repair: ctx.latest(outputs.phaseERepair, "phase-e-repair") }} commands={[...PHASE_COMMANDS.E, ...PROOF_COMMAND_ADDITIONS.E]} /></Task></Sequence></Loop>} else={null} />
          <Task id="phase-e-validation-gate" output={outputs.phaseEValidationGate} retries={0}>{() => phaseValidationGate(ctx as unknown as WorkflowCtx, "phaseEFocusedValidation", "phaseERevalidation", "phase-e-focused-validation", "phase-e-revalidation")}</Task>
          <Task id="phase-e-review" output={outputs.phaseEReview} agent={agents.review}><PhaseEReviewPrompt plan={init} validation={ctx.outputMaybe("phaseEValidationGate", { nodeId: "phase-e-validation-gate" })} /></Task>
          <Task id="phase-e-review-gate" output={outputs.phaseEReviewGate} retries={0}>{() => assertReview(ctx as unknown as WorkflowCtx, "phaseEReview", "phase-e-review", "Phase E")}</Task>
          <Task id="phase-e-migration-preflight" output={outputs.phaseEMigrationPreflight} agent={agents.review}><PhaseEMigrationPreflightPrompt plan={init} /></Task>
          <Task id="phase-e-migration-readiness" output={outputs.phaseEMigrationReadiness} retries={0}>{() => assertMigrationReadiness(ctx as unknown as WorkflowCtx)}</Task>
          <Approval id="approve-phase-e-migration" output={outputs.migrationApproval} request={{ title: "Approve migration 0072", summary: "Review the green Phase A-E gates, protected baseline, drain evidence, stopped services, and unapplied migration 0072 before allowing the one migration command." }} onDeny="fail" />
          <Task id="phase-e-migrate" output={outputs.phaseEMigrate} retries={0}>{() => runMigration(ctx as unknown as WorkflowCtx)}</Task>
        </Sequence>

        <Sequence>
          <Task id="phase-f-implement" output={outputs.phaseFImplement} agent={agents.write}><PhaseFImplementPrompt plan={init} previousPhase={ctx.outputMaybe("phaseEMigrate", { nodeId: "phase-e-migrate" })} /></Task>
          <Task id="phase-f-focused-validation" output={outputs.phaseFFocusedValidation} agent={agents.review}><PhaseFValidatePrompt context={{ plan: init, implementation: ctx.outputMaybe("phaseFImplement", { nodeId: "phase-f-implement" }) }} commands={[...PHASE_COMMANDS.F, ...PROOF_COMMAND_ADDITIONS.F]} /></Task>
          <Branch if={needsValidationRepair(ctx as unknown as WorkflowCtx, "phaseFFocusedValidation", "phaseFValidationGate", "phase-f-validation-gate")} then={<Loop id="phase-f-validation-repair-loop" until={ctx.latest(outputs.phaseFRevalidation, "phase-f-revalidation")?.passed === true} maxIterations={3} onMaxReached="fail"><Sequence><Task id="phase-f-repair" output={outputs.phaseFRepair} agent={agents.write}><PhaseFRepairPrompt plan={init} validation={fValidation} /></Task><Task id="phase-f-revalidation" output={outputs.phaseFRevalidation} agent={agents.review}><PhaseFValidatePrompt context={{ plan: init, repair: ctx.latest(outputs.phaseFRepair, "phase-f-repair") }} commands={[...PHASE_COMMANDS.F, ...PROOF_COMMAND_ADDITIONS.F]} /></Task></Sequence></Loop>} else={null} />
          <Task id="phase-f-validation-gate" output={outputs.phaseFValidationGate} retries={0}>{() => phaseValidationGate(ctx as unknown as WorkflowCtx, "phaseFFocusedValidation", "phaseFRevalidation", "phase-f-focused-validation", "phase-f-revalidation")}</Task>
          <Task id="phase-f-review" output={outputs.phaseFReview} agent={agents.review}><PhaseFReviewPrompt plan={init} validation={ctx.outputMaybe("phaseFValidationGate", { nodeId: "phase-f-validation-gate" })} /></Task>
          <Task id="phase-f-review-gate" output={outputs.phaseFReviewGate} retries={0}>{() => assertReview(ctx as unknown as WorkflowCtx, "phaseFReview", "phase-f-review", "Phase F")}</Task>
        </Sequence>

        <Task id="final-full-suite-validation" output={outputs.finalFullSuiteValidation} agent={agents.review}><FinalValidationPrompt commands={[...FINAL_COMMANDS]} /></Task>
        <Task id="final-evidence-snapshot" output={outputs.finalEvidenceSnapshot} retries={0}>{() => collectFinalEvidence(ctx as unknown as WorkflowCtx)}</Task>
        <Task id="final-readiness" output={outputs.finalReadiness} agent={agents.review}><FinalReadinessPrompt evidence={ctx.outputMaybe("finalEvidenceSnapshot", { nodeId: "final-evidence-snapshot" })} initialization={init} migration={ctx.outputMaybe("phaseEMigrate", { nodeId: "phase-e-migrate" })} preflight={ctx.outputMaybe("phaseEMigrationPreflight", { nodeId: "phase-e-migration-preflight" })} commands={[...FINAL_COMMANDS]} /></Task>
        <Task id="final-report" output={outputs.finalReport} agent={agents.mechanical}><FinalReportPrompt readiness={ctx.outputMaybe("finalReadiness", { nodeId: "final-readiness" })} /></Task>
        <Task id="final-readiness-gate" output={outputs.finalReadinessGate} retries={0}>{() => assertFinalReadiness(ctx as unknown as WorkflowCtx)}</Task>
      </Sequence>
    </Workflow>
  );
});

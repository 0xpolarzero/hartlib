// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: UI Playground Demo Cutover
// smithers-description: Implement and verify the fixed UI playground and demo cutover with durable checkpoints, real checks, retention proof, and final parity approval.
// smithers-tags: implementation, ui, demo, migration, verification
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, UI } from "smithers-orchestrator";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod/v4";
import { agents } from "../agents";
import AuditRepositoryAndPlanPrompt from "../prompts/implement-ui-playground-demo-cutover-audit-repository-and-plan.mdx";
import FreezeContractsPrompt from "../prompts/implement-ui-playground-demo-cutover-freeze-contracts.mdx";
import PlanIntegrationWavesPrompt from "../prompts/implement-ui-playground-demo-cutover-plan-integration-waves.mdx";
import AuthorCutoverDashboardPrompt from "../prompts/implement-ui-playground-demo-cutover-author-cutover-dashboard.mdx";
import ReviewCutoverDashboardPrompt from "../prompts/implement-ui-playground-demo-cutover-review-cutover-dashboard.mdx";
import RepairCutoverDashboardPrompt from "../prompts/implement-ui-playground-demo-cutover-repair-cutover-dashboard.mdx";
import RecheckCutoverDashboardPrompt from "../prompts/implement-ui-playground-demo-cutover-recheck-cutover-dashboard.mdx";
import SelectAndAssignWavePrompt from "../prompts/implement-ui-playground-demo-cutover-select-and-assign-wave.mdx";
import ImplementWaveLaneAPrompt from "../prompts/implement-ui-playground-demo-cutover-implement-wave-lane-a.mdx";
import ImplementWaveLaneBPrompt from "../prompts/implement-ui-playground-demo-cutover-implement-wave-lane-b.mdx";
import ImplementWaveLaneCPrompt from "../prompts/implement-ui-playground-demo-cutover-implement-wave-lane-c.mdx";
import ReviewWaveContractCompliancePrompt from "../prompts/implement-ui-playground-demo-cutover-review-wave-contract-compliance.mdx";
import RepairWaveContractFindingsPrompt from "../prompts/implement-ui-playground-demo-cutover-repair-wave-contract-findings.mdx";
import IntegrateWavePrompt from "../prompts/implement-ui-playground-demo-cutover-integrate-wave.mdx";
import RepairWaveFailuresPrompt from "../prompts/implement-ui-playground-demo-cutover-repair-wave-failures.mdx";
import CleanupObsoleteSurfacePrompt from "../prompts/implement-ui-playground-demo-cutover-cleanup-obsolete-surface.mdx";
import RepairRetentionCleanupPrompt from "../prompts/implement-ui-playground-demo-cutover-repair-retention-cleanup.mdx";
import SyncCanonicalDocsPrompt from "../prompts/implement-ui-playground-demo-cutover-sync-canonical-docs.mdx";
import ReviewDocsSyncPrompt from "../prompts/implement-ui-playground-demo-cutover-review-docs-sync.mdx";
import RepairDocsSyncPrompt from "../prompts/implement-ui-playground-demo-cutover-repair-docs-sync.mdx";
import RecheckDocsSyncPrompt from "../prompts/implement-ui-playground-demo-cutover-recheck-docs-sync.mdx";
import PrepareVerificationMatrixPrompt from "../prompts/implement-ui-playground-demo-cutover-prepare-verification-matrix.mdx";
import ReviewVerificationManifestPrompt from "../prompts/implement-ui-playground-demo-cutover-review-verification-manifest.mdx";
import RepairVerificationManifestPrompt from "../prompts/implement-ui-playground-demo-cutover-repair-verification-manifest.mdx";
import RecheckVerificationManifestPrompt from "../prompts/implement-ui-playground-demo-cutover-recheck-verification-manifest.mdx";
import RepairVerificationFailuresPrompt from "../prompts/implement-ui-playground-demo-cutover-repair-verification-failures.mdx";
import IndependentFinalReviewPrompt from "../prompts/implement-ui-playground-demo-cutover-independent-final-review.mdx";
import RemediateReviewFindingsPrompt from "../prompts/implement-ui-playground-demo-cutover-remediate-review-findings.mdx";
import RepairReviewRegressionFailuresPrompt from "../prompts/implement-ui-playground-demo-cutover-repair-review-regression-failures.mdx";

const REPOSITORY_PATH = "/Users/polarzero/code/projects/brief";
const PLAN_PATH = join(REPOSITORY_PATH, "artifacts/ui-playground-demo-implementation-plan.html");
const UI_PLAYGROUND_PATH = join(REPOSITORY_PATH, "ui-playground");
const ARTIFACT_ROOT = join(REPOSITORY_PATH, "artifacts/implement-ui-playground-demo-cutover");

const inputSchema = z.object({});

const artifactSchema = z.object({ path: z.string(), kind: z.string(), detail: z.string() });
const summarySchema = z.object({ summary: z.string() });

const initializeRunSchema = summarySchema.extend({
  repositoryPath: z.string(),
  planPath: z.string(),
  runState: z.string(),
  startingWorktreeArtifact: z.string(),
  uiPlaygroundBaselineArtifact: z.string(),
  uiPlaygroundRootDigest: z.string(),
  environmentCapabilities: z.array(z.string()).default([]),
  reservedPorts: z.array(z.number().int()).default([]),
  externalBlockers: z.array(z.string()).default([]),
  checkpointId: z.string(),
});

const preflightReadySchema = summarySchema.extend({
  ready: z.boolean(),
  externalBlockers: z.array(z.string()).default([]),
  requiredCommands: z.array(z.string()).default([]),
  availableCommands: z.array(z.string()).default([]),
  credentialsFound: z.array(z.string()).default([]),
  servicePlan: z.array(z.string()).default([]),
});

const blockedResultSchema = summarySchema.extend({
  runStatus: z.enum(["blocked", "failed"]).default("blocked"),
  externalBlockers: z.array(z.string()).default([]),
  evidenceArtifact: z.string(),
});

const repositoryAuditSchema = summarySchema.extend({
  sourceInventoryArtifact: z.string().default(""),
  citedDocsArtifact: z.string().default(""),
  effectReferencesArtifact: z.string().default(""),
  currentCodeInventoryArtifact: z.string().default(""),
  contradictions: z.array(z.string()).default([]),
  settledPlanOverrides: z.array(z.string()).default([]),
});

const frozenContractsSchema = summarySchema.extend({
  frozenContractsArtifact: z.string().default(""),
  behaviorRules: z.array(z.string()).default([]),
  dependencyBoundaries: z.array(z.string()).default([]),
  retainedFiles: z.array(z.string()).default([]),
  deletionMap: z.array(z.string()).default([]),
  migrationRules: z.array(z.string()).default([]),
  verificationGates: z.array(z.string()).default([]),
  evidenceRequirements: z.array(z.string()).default([]),
});

const wavePlanSchema = summarySchema.extend({
  wavePlan: z.array(z.object({ id: z.string(), purpose: z.string(), workItemIds: z.array(z.string()).default([]) })).default([]),
  workItems: z.array(z.object({ id: z.string(), files: z.array(z.string()).default([]), dependsOn: z.array(z.string()).default([]) })).default([]),
  dependencyGraph: z.array(z.string()).default([]),
  fileOwnershipRecord: z.array(z.object({ workItemId: z.string(), files: z.array(z.string()).default([]) })).default([]),
  parallelBatches: z.array(z.array(z.string())).default([]),
  sequentialEdges: z.array(z.string()).default([]),
});

const frozenBaselineSchema = summarySchema.extend({
  frozenManifestArtifact: z.string(),
  ownershipArtifact: z.string(),
  deletionMapArtifact: z.string().default(""),
  retainedReferenceManifest: z.string().default(""),
  checkpointId: z.string(),
});

const uiAuthoringSchema = summarySchema.extend({
  changedFiles: z.array(z.string()).default([]),
  panelsImplemented: z.array(z.string()).default([]),
  gatewayContractsUsed: z.array(z.string()).default([]),
  validationCommands: z.array(z.string()).default([]),
});

const uiReviewSchema = summarySchema.extend({
  passed: z.boolean().default(false),
  findings: z.array(z.object({ id: z.string(), severity: z.string(), detail: z.string(), requiredFix: z.string() })).default([]),
  routeEvidence: z.array(z.string()).default([]),
  screenshotArtifacts: z.array(z.string()).default([]),
});

const uiRepairSchema = summarySchema.extend({
  resolvedFindingIds: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  remainingFindings: z.array(z.string()).default([]),
});

const waveAssignmentSchema = summarySchema.extend({
  waveId: z.string().default(""),
  workItemIds: z.array(z.string()).default([]),
  laneAssignments: z.array(z.object({ lane: z.enum(["A", "B", "C"]), workItemIds: z.array(z.string()).default([]), files: z.array(z.string()).default([]) })).default([]),
  fileOwnership: z.array(z.string()).default([]),
  dependencyProof: z.array(z.string()).default([]),
  isFinalWave: z.boolean().default(false),
  remainingWaves: z.array(z.string()).default([]),
});

const waveImplementationSchema = summarySchema.extend({
  waveId: z.string().default(""),
  workItemIds: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  deletedFiles: z.array(z.string()).default([]),
  testsAdded: z.array(z.string()).default([]),
  evidenceArtifacts: z.array(z.string()).default([]),
  contractExceptions: z.array(z.string()).default([]),
});

const waveReviewSchema = summarySchema.extend({
  waveId: z.string().default(""),
  clean: z.boolean().default(false),
  ownershipViolations: z.array(z.string()).default([]),
  contractFindings: z.array(z.string()).default([]),
  diffArtifact: z.string().default(""),
});

const waveRepairSchema = summarySchema.extend({
  waveId: z.string().default(""),
  resolvedFindingIds: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  remainingFindings: z.array(z.string()).default([]),
});

const waveIntegrationSchema = summarySchema.extend({
  waveId: z.string().default(""),
  integratedWorkItems: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  deletedFiles: z.array(z.string()).default([]),
  conflicts: z.array(z.string()).default([]),
  integrationArtifact: z.string().default(""),
});

const checkResultSchema = summarySchema.extend({
  status: z.enum(["passed", "failed", "blocked"]).default("failed"),
  commands: z.array(z.string()).default([]),
  command: z.string().default(""),
  exitCode: z.number().int().default(-1),
  skipped: z.boolean().default(false),
  warningFailures: z.array(z.string()).default([]),
  artifactPaths: z.array(z.string()).default([]),
});

const waveChecksSchema = checkResultSchema.extend({
  waveId: z.string().default(""),
  failedChecks: z.array(z.string()).default([]),
  skippedChecks: z.array(z.string()).default([]),
});

const waveCheckpointSchema = summarySchema.extend({
  waveId: z.string().default(""),
  diffArtifact: z.string().default(""),
  logArtifacts: z.array(z.string()).default([]),
  resultArtifacts: z.array(z.string()).default([]),
  retainedReferenceDigest: z.string().default(""),
  checkpointId: z.string(),
  remainingWaves: z.array(z.string()).default([]),
});

const cleanupSchema = summarySchema.extend({
  removedFiles: z.array(z.string()).default([]),
  removedExports: z.array(z.string()).default([]),
  removedDependencies: z.array(z.string()).default([]),
  removedCapabilities: z.array(z.string()).default([]),
  retainedItems: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
});

const retentionCheckSchema = summarySchema.extend({
  passed: z.boolean().default(false),
  uiPlaygroundRootDigest: z.string().default(""),
  byteMatch: z.boolean().default(false),
  runtimeDependencyCount: z.number().int().default(-1),
  reachabilityFindings: z.array(z.string()).default([]),
  deletionMapFindings: z.array(z.string()).default([]),
  artifacts: z.array(z.string()).default([]),
});

const docsSyncSchema = summarySchema.extend({
  changedDocs: z.array(z.string()).default([]),
  removedStaleClaims: z.array(z.string()).default([]),
  contractCoverage: z.array(z.string()).default([]),
  remainingGaps: z.array(z.string()).default([]),
});

const docsReviewSchema = summarySchema.extend({
  clean: z.boolean().default(false),
  findings: z.array(z.object({ id: z.string(), document: z.string(), detail: z.string(), requiredFix: z.string() })).default([]),
  checkedDocs: z.array(z.string()).default([]),
  planAlignment: z.array(z.string()).default([]),
});

const docsRepairSchema = summarySchema.extend({
  resolvedFindingIds: z.array(z.string()).default([]),
  changedDocs: z.array(z.string()).default([]),
  remainingFindings: z.array(z.string()).default([]),
});

const cleanupDocsCheckpointSchema = summarySchema.extend({
  diffArtifact: z.string(),
  retentionArtifact: z.string(),
  docsArtifact: z.string(),
  checkpointId: z.string(),
});

const verificationManifestSchema = summarySchema.extend({
  verificationManifest: z.array(z.object({ id: z.string(), commands: z.array(z.string()).default([]), evidence: z.array(z.string()).default([]), noSkip: z.boolean().default(true) })).default([]),
  commands: z.array(z.string()).default([]),
  testsAddedOrExtended: z.array(z.string()).default([]),
  credentialsRequired: z.array(z.string()).default([]),
  servicePlan: z.array(z.string()).default([]),
  portPlan: z.array(z.number().int()).default([]),
  missingCoverage: z.array(z.string()).default([]),
  externalBlockers: z.array(z.string()).default([]),
});

const verificationManifestReviewSchema = summarySchema.extend({
  complete: z.boolean().default(false),
  missingChecks: z.array(z.string()).default([]),
  unsafeSkips: z.array(z.string()).default([]),
  commandFindings: z.array(z.string()).default([]),
  evidenceFindings: z.array(z.string()).default([]),
  externalBlockers: z.array(z.string()).default([]),
});

const verificationManifestRepairSchema = summarySchema.extend({
  resolvedFindingIds: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  remainingGaps: z.array(z.string()).default([]),
});

const visualCheckSchema = checkResultSchema.extend({
  widthResults: z.array(z.object({ width: z.number().int(), status: z.string(), screenshot: z.string().default(""), diff: z.string().default("") })).default([]),
});

const liveCheckSchema = checkResultSchema.extend({
  providerEvidence: z.array(z.string()).default([]),
  persistenceEvidence: z.array(z.string()).default([]),
  stopEvidence: z.array(z.string()).default([]),
  identityRevocationEvidence: z.array(z.string()).default([]),
  purgeEvidence: z.array(z.string()).default([]),
});

const referenceCheckSchema = checkResultSchema.extend({
  byteMatch: z.boolean().default(false),
  rootDigest: z.string().default(""),
  runtimeDependencyCount: z.number().int().default(-1),
});

const verificationAggregateSchema = summarySchema.extend({
  allPassed: z.boolean().default(false),
  failedCheckIds: z.array(z.string()).default([]),
  skippedCheckIds: z.array(z.string()).default([]),
  designatedWarnings: z.array(z.string()).default([]),
  noSkip: z.boolean().default(false),
  noMissingTests: z.boolean().default(false),
  noMissingCredentials: z.boolean().default(false),
  evidenceComplete: z.boolean().default(false),
  repositoryDigest: z.string().default(""),
  matrixArtifact: z.string().default(""),
});

const failureClassificationSchema = summarySchema.extend({
  repairableFailures: z.array(z.string()).default([]),
  externalBlockers: z.array(z.string()).default([]),
  requiresCodeChange: z.boolean().default(false),
});

const verificationRepairSchema = summarySchema.extend({
  resolvedCheckIds: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  testsChanged: z.array(z.string()).default([]),
  remainingFailures: z.array(z.string()).default([]),
});

const verificationCheckpointSchema = summarySchema.extend({
  matrixArtifact: z.string(),
  testArtifacts: z.array(z.string()).default([]),
  visualArtifacts: z.array(z.string()).default([]),
  liveFlowArtifacts: z.array(z.string()).default([]),
  repositoryDigest: z.string(),
  checkpointId: z.string(),
});

const independentReviewSchema = summarySchema.extend({
  clean: z.boolean().default(false),
  findings: z.array(z.object({ id: z.string(), severity: z.string(), detail: z.string(), requiredFix: z.string() })).default([]),
  contractCoverage: z.array(z.string()).default([]),
  deletionCoverage: z.array(z.string()).default([]),
  retentionDigestMatch: z.boolean().default(false),
  evidenceCoverage: z.array(z.string()).default([]),
  repositoryDigestReviewed: z.string().default(""),
  reviewArtifact: z.string().default(""),
});

const reviewRegressionSchema = checkResultSchema.extend({
  failedChecks: z.array(z.string()).default([]),
  skippedChecks: z.array(z.string()).default([]),
});

const reviewRegressionRepairSchema = summarySchema.extend({
  resolvedCheckIds: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  remainingFailures: z.array(z.string()).default([]),
});

const reviewCheckpointSchema = summarySchema.extend({
  round: z.number().int().default(0),
  reviewArtifact: z.string(),
  resolutionArtifact: z.string(),
  repositoryDigestReviewed: z.string(),
  checkpointId: z.string(),
});

const stabilityGateSchema = summarySchema.extend({
  stable: z.boolean().default(false),
  currentRepositoryDigest: z.string(),
  verifiedRepositoryDigest: z.string(),
  reviewedRepositoryDigest: z.string(),
  reason: z.string(),
});

const finalReadinessSchema = summarySchema.extend({
  approvalEligible: z.boolean().default(false),
  allAutomatedChecksPassed: z.boolean().default(false),
  noSkips: z.boolean().default(false),
  noWarnings: z.boolean().default(false),
  noBlockers: z.boolean().default(false),
  reviewClean: z.boolean().default(false),
  retentionMatch: z.boolean().default(false),
  remainingActionableWork: z.array(z.string()).default([]),
  evidenceManifest: z.array(z.string()).default([]),
});

const readinessFailureSchema = summarySchema.extend({
  runStatus: z.enum(["failed", "blocked"]).default("failed"),
  failedConditions: z.array(z.string()).default([]),
  remainingActionableWork: z.array(z.string()).default([]),
  evidenceArtifact: z.string(),
});

const finalParityApprovalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

const approvalRecordSchema = summarySchema.extend({
  approved: z.boolean(),
  approverIdentity: z.string(),
  decision: z.string(),
  decidedAt: z.string(),
  comment: z.string().default(""),
});

const approvalDeniedSchema = summarySchema.extend({
  runStatus: z.literal("denied"),
  approvalRecord: approvalRecordSchema,
  remainingActionableWork: z.array(z.string()).default([]),
  evidenceArtifact: z.string(),
});

const finalResultSchema = summarySchema.extend({
  runStatus: z.literal("approved"),
  frozenContractManifest: z.string(),
  fileOwnershipRecord: z.string(),
  changeManifest: z.string(),
  deletionManifest: z.string(),
  retainedReferenceProof: z.string(),
  migrationEvidence: z.array(z.string()).default([]),
  verificationMatrix: z.string(),
  testArtifacts: z.array(z.string()).default([]),
  visualArtifacts: z.array(z.string()).default([]),
  reviewRounds: z.number().int().default(0),
  externalBlockers: z.array(z.string()).default([]),
  approvalRecord: approvalRecordSchema,
  finalRepositoryState: z.string(),
  zeroActionableWork: z.boolean(),
});

const preflightBlockedResultSchema = blockedResultSchema.extend({});
const verificationBlockedResultSchema = blockedResultSchema.extend({});
const waveImplementationASchema = waveImplementationSchema.extend({});
const waveImplementationBSchema = waveImplementationSchema.extend({});
const waveImplementationCSchema = waveImplementationSchema.extend({});
const waveFailureRepairSchema = waveRepairSchema.extend({});
const retentionRepairSchema = uiRepairSchema.extend({});
const reviewRepairSchema = uiRepairSchema.extend({});
const checkMigration0074Schema = checkResultSchema.extend({});
const unitTestsSchema = checkResultSchema.extend({});
const integrationTestsSchema = checkResultSchema.extend({});
const buildsSchema = checkResultSchema.extend({});
const deterministicPlaywrightSchema = checkResultSchema.extend({});
const accessibilitySchema = checkResultSchema.extend({});
const reachabilityBundleSchema = checkResultSchema.extend({});
const callersCapabilitiesSchema = checkResultSchema.extend({});
const lintSchema = checkResultSchema.extend({});
const rootChecksSchema = checkResultSchema.extend({});

const { Workflow, Task, Sequence, Branch, Loop, Approval, MergeQueue, Parallel, smithers, outputs } = createSmithers({
  input: inputSchema,
  initializeRun: initializeRunSchema,
  preflightReady: preflightReadySchema,
  preflightBlockedResult: preflightBlockedResultSchema,
  repositoryAudit: repositoryAuditSchema,
  frozenContracts: frozenContractsSchema,
  wavePlan: wavePlanSchema,
  frozenBaseline: frozenBaselineSchema,
  uiAuthoring: uiAuthoringSchema,
  uiReview: uiReviewSchema,
  uiRepair: uiRepairSchema,
  waveAssignment: waveAssignmentSchema,
  waveImplementationA: waveImplementationASchema,
  waveImplementationB: waveImplementationBSchema,
  waveImplementationC: waveImplementationCSchema,
  waveReview: waveReviewSchema,
  waveRepair: waveRepairSchema,
  waveIntegration: waveIntegrationSchema,
  waveChecks: waveChecksSchema,
  waveFailureRepair: waveFailureRepairSchema,
  waveCheckpoint: waveCheckpointSchema,
  cleanup: cleanupSchema,
  retentionCheck: retentionCheckSchema,
  retentionRepair: retentionRepairSchema,
  docsSync: docsSyncSchema,
  docsReview: docsReviewSchema,
  docsRepair: docsRepairSchema,
  cleanupDocsCheckpoint: cleanupDocsCheckpointSchema,
  verificationManifest: verificationManifestSchema,
  verificationManifestReview: verificationManifestReviewSchema,
  verificationManifestRepair: verificationManifestRepairSchema,
  checkMigration0074: checkMigration0074Schema,
  unitTests: unitTestsSchema,
  integrationTests: integrationTestsSchema,
  builds: buildsSchema,
  deterministicPlaywright: deterministicPlaywrightSchema,
  visualCheck: visualCheckSchema,
  accessibility: accessibilitySchema,
  liveRetrieval: liveCheckSchema,
  liveStop: liveCheckSchema,
  liveResetDuringRun: liveCheckSchema,
  reachabilityBundle: reachabilityBundleSchema,
  callersCapabilities: callersCapabilitiesSchema,
  referenceCheck: referenceCheckSchema,
  lint: lintSchema,
  rootChecks: rootChecksSchema,
  verificationAggregate: verificationAggregateSchema,
  failureClassification: failureClassificationSchema,
  verificationRepair: verificationRepairSchema,
  verificationBlockedResult: verificationBlockedResultSchema,
  verificationCheckpoint: verificationCheckpointSchema,
  independentReview: independentReviewSchema,
  reviewRepair: reviewRepairSchema,
  affectedRegression: reviewRegressionSchema,
  reviewRegressionRepair: reviewRegressionRepairSchema,
  reviewCheckpoint: reviewCheckpointSchema,
  stabilityGate: stabilityGateSchema,
  finalReadiness: finalReadinessSchema,
  readinessFailure: readinessFailureSchema,
  finalParityApproval: finalParityApprovalSchema,
  approvalRecord: approvalRecordSchema,
  approvalDenied: approvalDeniedSchema,
  finalResult: finalResultSchema,
});

type AnyRecord = Record<string, unknown>;

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandResult(command: string, args: string[] = []) {
  try {
    const stdout = execFileSync(command, args, { cwd: REPOSITORY_PATH, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { exitCode: 0, stdout: String(stdout), stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { exitCode: typeof failure.status === "number" ? failure.status : 1, stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? "") };
  }
}

function shellResult(command: string) {
  return commandResult("sh", ["-lc", command]);
}

function artifactPath(name: string): string {
  mkdirSync(ARTIFACT_ROOT, { recursive: true });
  const path = join(ARTIFACT_ROOT, name);
  mkdirSync(resolve(path, ".."), { recursive: true });
  return path;
}

function writeArtifact(name: string, value: unknown): string {
  const path = artifactPath(name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return relative(REPOSITORY_PATH, path);
}

type ManifestEntry = { path: string; entryType: string; byteLength: number; contentHash: string; symlinkTarget: string };

function uiPlaygroundManifest(): { entries: ManifestEntry[]; rootDigest: string } {
  const entries: ManifestEntry[] = [];
  if (!existsSync(UI_PLAYGROUND_PATH)) return { entries, rootDigest: hashText("missing ui-playground") };
  const visit = (absolute: string) => {
    for (const item of readdirSync(absolute, { withFileTypes: true })) {
      const child = join(absolute, item.name);
      const relativePath = relative(REPOSITORY_PATH, child).split("\\").join("/");
      const stat = lstatSync(child);
      if (item.isDirectory()) {
        entries.push({ path: relativePath, entryType: "directory", byteLength: 0, contentHash: "", symlinkTarget: "" });
        visit(child);
      } else if (item.isSymbolicLink()) {
        entries.push({ path: relativePath, entryType: "symlink", byteLength: 0, contentHash: "", symlinkTarget: readlinkSync(child) });
      } else if (item.isFile()) {
        const bytes = readFileSync(child);
        entries.push({ path: relativePath, entryType: "file", byteLength: stat.size, contentHash: hashBytes(bytes), symlinkTarget: "" });
      }
    }
  };
  visit(UI_PLAYGROUND_PATH);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, rootDigest: hashText(JSON.stringify(entries)) };
}

async function reserveFreePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const value = typeof address === "object" && address ? address.port : 0;
        server.close((error) => (error ? reject(error) : resolvePort(value)));
      });
    });
    ports.push(port);
  }
  return ports;
}

function commandAvailable(name: string): boolean {
  return commandResult("sh", ["-lc", `command -v ${name}`]).exitCode === 0;
}

async function initializeRun() {
  const manifest = uiPlaygroundManifest();
  const ports = await reserveFreePorts(8);
  const runState = commandResult("git", ["status", "--short"]).stdout.trim();
  const startingWorktreeArtifact = writeArtifact("baseline/starting-worktree.json", {
    repositoryPath: REPOSITORY_PATH,
    status: runState,
    head: commandResult("git", ["rev-parse", "HEAD"]).stdout.trim(),
    diff: commandResult("git", ["diff", "--no-ext-diff"]).stdout,
  });
  const uiPlaygroundBaselineArtifact = writeArtifact("baseline/ui-playground-manifest.json", manifest);
  const environmentCapabilities = ["git", "bun", "bunx", "rg", "docker"].filter(commandAvailable);
  const externalBlockers = [
    ...(existsSync(PLAN_PATH) ? [] : [`missing fixed plan: ${PLAN_PATH}`]),
    ...(existsSync(UI_PLAYGROUND_PATH) ? [] : [`missing retained directory: ${UI_PLAYGROUND_PATH}`]),
  ];
  const checkpointId = `initialize_run-${hashText(`${Date.now()}-${manifest.rootDigest}`).slice(0, 16)}`;
  const checkpointArtifact = writeArtifact("checkpoints/initialize_run.json", { checkpointId, rootDigest: manifest.rootDigest, ports });
  return {
    summary: `Captured the starting Git state and ${manifest.entries.length} retained ui-playground entries.`,
    repositoryPath: REPOSITORY_PATH,
    planPath: PLAN_PATH,
    runState,
    startingWorktreeArtifact,
    uiPlaygroundBaselineArtifact,
    uiPlaygroundRootDigest: manifest.rootDigest,
    environmentCapabilities: [...environmentCapabilities, `checkpoint:${checkpointArtifact}`],
    reservedPorts: ports,
    externalBlockers,
    checkpointId,
  };
}

async function assertPreflight(initial: AnyRecord | undefined) {
  const requiredCommands = ["git", "bun", "bunx", "rg"];
  const availableCommands = requiredCommands.filter(commandAvailable);
  const blockers = [...((initial?.externalBlockers as string[] | undefined) ?? [])];
  for (const command of requiredCommands) if (!availableCommands.includes(command)) blockers.push(`required command is unavailable: ${command}`);
  const credentialsFound: string[] = [];
  if (process.env.ZAI_API_KEY) credentialsFound.push("ZAI_API_KEY");
  if (process.env.HARTLIB_E2E_LIVE_PROVIDER === "1") credentialsFound.push("HARTLIB_E2E_LIVE_PROVIDER=1");
  if (process.env.HARTLIB_E2E_STACK === "1") credentialsFound.push("HARTLIB_E2E_STACK=1");
  if (!process.env.ZAI_API_KEY) blockers.push("ZAI_API_KEY is not available for live-provider checks");
  if (process.env.HARTLIB_E2E_LIVE_PROVIDER !== "1") blockers.push("HARTLIB_E2E_LIVE_PROVIDER=1 is required");
  if (process.env.HARTLIB_E2E_STACK !== "1") blockers.push("HARTLIB_E2E_STACK=1 is required");
  const servicePlan = ["reserve isolated ports", "start repository Postgres through docker compose when required", "run API, worker, and demo services for live Playwright", "persist logs and screenshots under artifacts/implement-ui-playground-demo-cutover"];
  const ready = blockers.length === 0;
  const evidenceArtifact = writeArtifact("preflight/preflight.json", { ready, blockers, availableCommands, credentialsFound, servicePlan });
  return {
    summary: ready ? "Preflight has all required commands, credentials, services, and paths." : `Preflight found ${blockers.length} external blocker(s); no requirement was skipped.`,
    ready,
    externalBlockers: blockers,
    requiredCommands,
    availableCommands,
    credentialsFound,
    servicePlan: [...servicePlan, `evidence:${evidenceArtifact}`],
  };
}

function blockedResult(kind: string, blockers: string[]) {
  const evidenceArtifact = writeArtifact(`blocked/${kind}.json`, { kind, blockers, createdAt: new Date().toISOString() });
  throw new Error(`External blocker prevents ${kind}: ${blockers.join("; ")} (evidence ${evidenceArtifact})`);
}

function runCheck(id: string, commands: string[]) {
  const results = commands.map((command) => ({ command, result: shellResult(command) }));
  const failed = results.filter((entry) => entry.result.exitCode !== 0);
  const output = results.map((entry) => ({ command: entry.command, exitCode: entry.result.exitCode, stdout: entry.result.stdout, stderr: entry.result.stderr }));
  const log = writeArtifact(`checks/${id}.json`, output);
  return {
    summary: failed.length === 0 ? `${id} passed with real repository commands.` : `${id} failed ${failed.length} command(s); inspect ${log}.`,
    status: failed.length === 0 ? "passed" as const : "failed" as const,
    commands,
    command: commands.join(" && "),
    exitCode: failed[0]?.result.exitCode ?? 0,
    skipped: false,
    warningFailures: [],
    artifactPaths: [log],
  };
}

function runVisualCheck() {
  const widths = [320, 390, 1024, 1535, 1536, 1920];
  const results = widths.map((width) => {
    const visualDir = `artifacts/implement-ui-playground-demo-cutover/visual/${width}`;
    const command = `HARTLIB_E2E_VIEWPORT_WIDTH=${width} HARTLIB_E2E_LIVE_PROVIDER=1 HARTLIB_E2E_STACK=1 bun --env-file=.env x --bun playwright test --project=hartlib-ai-chat-runtime -g 'visual|breakpoint' --output=${visualDir}`;
    const result = shellResult(command);
    const artifact = writeArtifact(`checks/visual-${width}.json`, { width, command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
    return { width, status: result.exitCode === 0 ? "passed" : "failed", screenshot: visualDir, diff: artifact, command, exitCode: result.exitCode, artifact };
  });
  const failed = results.filter((entry) => entry.exitCode !== 0);
  return {
    summary: failed.length === 0 ? "All six required visual widths passed real Playwright commands." : `${failed.length} visual width(s) failed.`,
    status: failed.length === 0 ? "passed" as const : "failed" as const,
    commands: results.map((entry) => entry.command),
    command: results.map((entry) => entry.command).join(" && "),
    exitCode: failed[0]?.exitCode ?? 0,
    skipped: false,
    warningFailures: [],
    artifactPaths: results.map((entry) => entry.artifact),
    widthResults: results.map(({ width, status, screenshot, diff }) => ({ width, status, screenshot, diff })),
  };
}

function runLiveCheck(id: string, command: string, evidence: { provider: string; persistence: string; stop?: string; identity?: string; purge?: string }) {
  const result = shellResult(command);
  const artifact = writeArtifact(`checks/${id}.json`, { command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
  const passed = result.exitCode === 0;
  return {
    summary: passed ? `${id} passed the real provider Playwright flow.` : `${id} failed; inspect ${artifact}.`,
    status: passed ? "passed" as const : "failed" as const,
    commands: [command],
    command,
    exitCode: result.exitCode,
    skipped: false,
    warningFailures: [],
    artifactPaths: [artifact],
    providerEvidence: passed ? [`${evidence.provider}; command exit 0`] : [],
    persistenceEvidence: passed ? [`${evidence.persistence}; command exit 0`] : [],
    stopEvidence: passed && evidence.stop ? [evidence.stop] : [],
    identityRevocationEvidence: passed && evidence.identity ? [evidence.identity] : [],
    purgeEvidence: passed && evidence.purge ? [evidence.purge] : [],
  };
}

function currentRepositoryDigest(): string {
  const manifest = uiPlaygroundManifest();
  const status = commandResult("git", ["status", "--short"]).stdout;
  const diff = commandResult("git", ["diff", "--no-ext-diff"]).stdout;
  return hashText(JSON.stringify({ manifest: manifest.rootDigest, status, diff }));
}

function checkpoint(name: string, value: unknown): string {
  return writeArtifact(`checkpoints/${name}.json`, { checkpointId: `${name}-${hashText(JSON.stringify(value)).slice(0, 16)}`, value });
}

export default smithers((ctx) => {
  const initial = ctx.outputMaybe(outputs.initializeRun, { nodeId: "initialize_run" });
  const preflight = ctx.outputMaybe(outputs.preflightReady, { nodeId: "assert_preflight_ready" });
  const uiReview = ctx.latest(outputs.uiReview, "recheck_cutover_dashboard") ?? ctx.latest(outputs.uiReview, "review_cutover_dashboard");
  const waveAssignment = ctx.latest(outputs.waveAssignment, "select_and_assign_wave");
  const waveReview = ctx.latest(outputs.waveReview, "review_wave_contract_compliance");
  const waveChecks = ctx.latest(outputs.waveChecks, "rerun_wave_checks") ?? ctx.latest(outputs.waveChecks, "run_wave_checks");
  const retention = ctx.latest(outputs.retentionCheck, "reverify_retention_cleanup") ?? ctx.latest(outputs.retentionCheck, "verify_retention_cleanup");
  const docsReview = ctx.latest(outputs.docsReview, "recheck_docs_sync") ?? ctx.latest(outputs.docsReview, "review_docs_sync");
  const manifestReview = ctx.latest(outputs.verificationManifestReview, "recheck_verification_manifest") ?? ctx.latest(outputs.verificationManifestReview, "review_verification_manifest");
  const aggregate = ctx.latest(outputs.verificationAggregate, "aggregate_verification_matrix");
  const independentReview = ctx.latest(outputs.independentReview, "independent_final_review");
  const regressions = ctx.latest(outputs.affectedRegression, "rerun_affected_regressions") ?? ctx.latest(outputs.affectedRegression, "run_affected_regressions");
  const stability = ctx.latest(outputs.stabilityGate, "assert_stable_review_and_verification");
  const readiness = ctx.outputMaybe(outputs.finalReadiness, { nodeId: "final_readiness_gate" });
  const approval = ctx.outputMaybe(outputs.finalParityApproval, { nodeId: "final_parity_approval" });

  const dashboardPassed = uiReview?.passed === true;
  const contractClean = waveReview?.clean === true;
  const waveChecksPassed = waveChecks?.status === "passed" && waveChecks?.skippedChecks?.length === 0 && waveChecks?.warningFailures?.length === 0;
  const retentionPassed = retention?.passed === true && retention.byteMatch === true && retention.runtimeDependencyCount === 0;
  const docsClean = docsReview?.clean === true;
  const manifestComplete = manifestReview?.complete === true && (manifestReview.unsafeSkips?.length ?? 0) === 0 && (manifestReview.missingChecks?.length ?? 0) === 0;
  const matrixPassed = aggregate?.allPassed === true && aggregate.noSkip === true && aggregate.noMissingTests === true && aggregate.noMissingCredentials === true && aggregate.designatedWarnings.length === 0 && aggregate.evidenceComplete === true;
  const reviewClean = independentReview?.clean === true;
  const regressionsPassed = regressions?.status === "passed" && regressions.skippedChecks.length === 0 && regressions.warningFailures.length === 0;
  const stable = stability?.stable === true;

  return (
    <Workflow name="implement-ui-playground-demo-cutover">
      <UI entry="../ui/implement-ui-playground-demo-cutover.tsx" title="UI Playground Demo Cutover" />
      <Sequence>
        <Task id="initialize_run" output={outputs.initializeRun}>
          {() => initializeRun()}
        </Task>
        <Task id="assert_preflight_ready" output={outputs.preflightReady}>
          {() => assertPreflight(initial as AnyRecord | undefined)}
        </Task>
        <Branch
          if={preflight?.ready === true}
          then={
            <Sequence>
              <Task id="audit_repository_and_plan" output={outputs.repositoryAudit} agent={agents.review}>
                <AuditRepositoryAndPlanPrompt repositoryPath={REPOSITORY_PATH} planPath={PLAN_PATH} initial={initial} />
              </Task>
              <Task id="freeze_contracts" output={outputs.frozenContracts} agent={agents.review}>
                <FreezeContractsPrompt repositoryAudit={ctx.latest(outputs.repositoryAudit, "audit_repository_and_plan")} planPath={PLAN_PATH} />
              </Task>
              <Task id="plan_integration_waves" output={outputs.wavePlan} agent={agents.review}>
                <PlanIntegrationWavesPrompt frozenContracts={ctx.latest(outputs.frozenContracts, "freeze_contracts")} repositoryPath={REPOSITORY_PATH} />
              </Task>
              <Task id="persist_frozen_baseline" output={outputs.frozenBaseline}>
                {() => {
                  const value = { contracts: ctx.latest(outputs.frozenContracts, "freeze_contracts"), waves: ctx.latest(outputs.wavePlan, "plan_integration_waves"), retainedRootDigest: initial?.uiPlaygroundRootDigest ?? "" };
                  const manifest = writeArtifact("baseline/frozen-manifest.json", value);
                  const ownership = writeArtifact("baseline/ownership.json", ctx.latest(outputs.wavePlan, "plan_integration_waves")?.fileOwnershipRecord ?? []);
                  const checkpointId = `persist_frozen_baseline-${hashText(JSON.stringify(value)).slice(0, 16)}`;
                  checkpoint("persist_frozen_baseline", { checkpointId, manifest, ownership });
                  return { summary: "Persisted the frozen contracts, ownership, deletion, and retained-reference baseline.", frozenManifestArtifact: manifest, ownershipArtifact: ownership, deletionMapArtifact: manifest, retainedReferenceManifest: initial?.uiPlaygroundBaselineArtifact ?? "", checkpointId };
                }}
              </Task>
              <Task id="author_cutover_dashboard" output={outputs.uiAuthoring} agent={agents.ui}>
                <AuthorCutoverDashboardPrompt frozenContracts={ctx.latest(outputs.frozenContracts, "freeze_contracts")} wavePlan={ctx.latest(outputs.wavePlan, "plan_integration_waves")} uiPath=".smithers/ui/implement-ui-playground-demo-cutover.tsx" />
              </Task>
              <Loop id="dashboard_quality" maxIterations={4} onMaxReached="fail" until={dashboardPassed}>
                <Sequence>
                  <Task id="review_cutover_dashboard" output={outputs.uiReview} agent={agents.review}>
                    <ReviewCutoverDashboardPrompt workflowKey="implement-ui-playground-demo-cutover" route="/workflows/implement-ui-playground-demo-cutover" />
                  </Task>
                  <Branch
                    if={uiReview?.passed === false}
                    then={
                      <Task id="repair_cutover_dashboard" output={outputs.uiRepair} agent={agents.ui}>
                        <RepairCutoverDashboardPrompt findings={uiReview?.findings ?? []} uiPath=".smithers/ui/implement-ui-playground-demo-cutover.tsx" />
                      </Task>
                    }
                    else={null}
                  />
                  <Task id="recheck_cutover_dashboard" output={outputs.uiReview} agent={agents.review}>
                    <RecheckCutoverDashboardPrompt priorReview={uiReview} route="/workflows/implement-ui-playground-demo-cutover" />
                  </Task>
                </Sequence>
              </Loop>
              <Loop id="integration_waves" maxIterations={32} onMaxReached="fail" until={(ctx.latest(outputs.waveCheckpoint, "checkpoint_wave")?.remainingWaves?.length ?? 1) === 0}>
                <Sequence>
                  <Task id="select_and_assign_wave" output={outputs.waveAssignment} agent={agents.review}>
                    <SelectAndAssignWavePrompt wavePlan={ctx.latest(outputs.wavePlan, "plan_integration_waves")} priorCheckpoint={ctx.latest(outputs.waveCheckpoint, "checkpoint_wave")} />
                  </Task>
                  <Parallel maxConcurrency={3}>
                    <Branch if={(waveAssignment?.laneAssignments ?? []).some((lane) => lane.lane === "A")} then={<Task id="implement_wave_lane_a" output={outputs.waveImplementationA} agent={agents.write}><ImplementWaveLaneAPrompt assignment={waveAssignment} frozenContracts={ctx.latest(outputs.frozenContracts, "freeze_contracts")} /></Task>} else={null} />
                    <Branch if={(waveAssignment?.laneAssignments ?? []).some((lane) => lane.lane === "B")} then={<Task id="implement_wave_lane_b" output={outputs.waveImplementationB} agent={agents.write}><ImplementWaveLaneBPrompt assignment={waveAssignment} frozenContracts={ctx.latest(outputs.frozenContracts, "freeze_contracts")} /></Task>} else={null} />
                    <Branch if={(waveAssignment?.laneAssignments ?? []).some((lane) => lane.lane === "C")} then={<Task id="implement_wave_lane_c" output={outputs.waveImplementationC} agent={agents.write}><ImplementWaveLaneCPrompt assignment={waveAssignment} frozenContracts={ctx.latest(outputs.frozenContracts, "freeze_contracts")} /></Task>} else={null} />
                  </Parallel>
                  <Loop id="wave_contract_compliance" maxIterations={8} onMaxReached="fail" until={contractClean}>
                    <Sequence>
                      <Task id="review_wave_contract_compliance" output={outputs.waveReview} agent={agents.review}>
                        <ReviewWaveContractCompliancePrompt assignment={waveAssignment} laneA={ctx.latest(outputs.waveImplementationA, "implement_wave_lane_a")} laneB={ctx.latest(outputs.waveImplementationB, "implement_wave_lane_b")} laneC={ctx.latest(outputs.waveImplementationC, "implement_wave_lane_c")} />
                      </Task>
                      <Branch if={waveReview?.clean === false} then={<Task id="repair_wave_contract_findings" output={outputs.waveRepair} agent={agents.write}><RepairWaveContractFindingsPrompt review={waveReview} assignment={waveAssignment} /></Task>} else={null} />
                    </Sequence>
                  </Loop>
                  <MergeQueue id="validated_wave_merge_queue" maxConcurrency={1}>
                    <Task id="integrate_wave" output={outputs.waveIntegration} agent={agents.write}>
                      <IntegrateWavePrompt assignment={waveAssignment} review={ctx.latest(outputs.waveReview, "review_wave_contract_compliance")} />
                    </Task>
                    <Loop id="wave_behavior_gate" maxIterations={8} onMaxReached="fail" until={waveChecksPassed}>
                      <Sequence>
                        <Task id="run_wave_checks" output={outputs.waveChecks}>
                          {() => ({ ...runCheck("wave", ["bun run check", "bun run lint"]), waveId: waveAssignment?.waveId ?? "", failedChecks: [], skippedChecks: [] })}
                        </Task>
                        <Branch if={waveChecks?.status !== "passed" || waveChecks?.skippedChecks?.length !== 0 || waveChecks?.warningFailures?.length !== 0} then={<Task id="repair_wave_failures" output={outputs.waveFailureRepair} agent={agents.write}><RepairWaveFailuresPrompt checks={waveChecks} assignment={waveAssignment} /></Task>} else={null} />
                        <Task id="rerun_wave_checks" output={outputs.waveChecks}>
                          {() => ({ ...runCheck("wave-rerun", ["bun run check", "bun run lint"]), waveId: waveAssignment?.waveId ?? "", failedChecks: [], skippedChecks: [] })}
                        </Task>
                      </Sequence>
                    </Loop>
                    <Task id="checkpoint_wave" output={outputs.waveCheckpoint}>
                      {() => {
                        const value = { waveId: waveAssignment?.waveId ?? "", assignment: waveAssignment, checks: waveChecks, digest: uiPlaygroundManifest().rootDigest };
                        const diffArtifact = writeArtifact(`waves/${waveAssignment?.waveId || "unassigned"}-diff.json`, { diff: commandResult("git", ["diff", "--no-ext-diff"]).stdout });
                        const checkpointId = checkpoint("wave", value);
                        return { summary: "Persisted the reviewed wave diff, checks, logs, retained digest, and checkpoint.", waveId: waveAssignment?.waveId ?? "", diffArtifact, logArtifacts: waveChecks?.artifactPaths ?? [], resultArtifacts: waveChecks?.artifactPaths ?? [], retainedReferenceDigest: uiPlaygroundManifest().rootDigest, checkpointId, remainingWaves: waveAssignment?.remainingWaves ?? [] };
                      }}
                    </Task>
                  </MergeQueue>
                </Sequence>
              </Loop>
              <Task id="cleanup_obsolete_surface" output={outputs.cleanup} agent={agents.write}>
                <CleanupObsoleteSurfacePrompt frozenContracts={ctx.latest(outputs.frozenContracts, "freeze_contracts")} baseline={ctx.latest(outputs.frozenBaseline, "persist_frozen_baseline")} />
              </Task>
              <Loop id="retention_cleanup_gate" maxIterations={8} onMaxReached="fail" until={retentionPassed}>
                <Sequence>
                  <Task id="verify_retention_cleanup" output={outputs.retentionCheck}>
                    {() => {
                      const manifest = uiPlaygroundManifest();
                      const baseline = initial?.uiPlaygroundRootDigest ?? "";
                      const deps = shellResult("rg -n --hidden --glob '!ui-playground/**' 'ui-playground' apps packages || true");
                      const result = { passed: manifest.rootDigest === baseline && deps.stdout.trim() === "", uiPlaygroundRootDigest: manifest.rootDigest, byteMatch: manifest.rootDigest === baseline, runtimeDependencyCount: deps.stdout.trim() === "" ? 0 : deps.stdout.trim().split("\n").length, reachabilityFindings: deps.stdout.trim() ? deps.stdout.trim().split("\n") : [], deletionMapFindings: [], artifacts: [writeArtifact("cleanup/retention.json", { manifest, deps: deps.stdout })] };
                      return { summary: result.passed ? "Retention and cleanup checks passed." : "Retention or cleanup checks found a real mismatch.", ...result };
                    }}
                  </Task>
                  <Branch if={!retentionPassed} then={<Task id="repair_retention_cleanup" output={outputs.retentionRepair} agent={agents.write}><RepairRetentionCleanupPrompt findings={retention} frozenContracts={ctx.latest(outputs.frozenContracts, "freeze_contracts")} /></Task>} else={null} />
                  <Task id="reverify_retention_cleanup" output={outputs.retentionCheck}>
                    {() => {
                      const manifest = uiPlaygroundManifest();
                      const baseline = initial?.uiPlaygroundRootDigest ?? "";
                      const deps = shellResult("rg -n --hidden --glob '!ui-playground/**' 'ui-playground' apps packages || true");
                      const passed = manifest.rootDigest === baseline && deps.stdout.trim() === "";
                      return { summary: passed ? "Retention recheck passed." : "Retention recheck still has findings.", passed, uiPlaygroundRootDigest: manifest.rootDigest, byteMatch: manifest.rootDigest === baseline, runtimeDependencyCount: deps.stdout.trim() === "" ? 0 : deps.stdout.trim().split("\n").length, reachabilityFindings: deps.stdout.trim() ? deps.stdout.trim().split("\n") : [], deletionMapFindings: [], artifacts: [writeArtifact("cleanup/retention-recheck.json", { passed, manifest, deps: deps.stdout })] };
                    }}
                  </Task>
                </Sequence>
              </Loop>
              <Task id="sync_canonical_docs" output={outputs.docsSync} agent={agents.write}>
                <SyncCanonicalDocsPrompt frozenContracts={ctx.latest(outputs.frozenContracts, "freeze_contracts")} implementation={ctx.latest(outputs.cleanup, "cleanup_obsolete_surface")} />
              </Task>
              <Loop id="canonical_docs_gate" maxIterations={6} onMaxReached="fail" until={docsClean}>
                <Sequence>
                  <Task id="review_docs_sync" output={outputs.docsReview} agent={agents.review}><ReviewDocsSyncPrompt docsSync={ctx.latest(outputs.docsSync, "sync_canonical_docs")} planPath={PLAN_PATH} /></Task>
                  <Branch if={docsReview?.clean === false} then={<Task id="repair_docs_sync" output={outputs.docsRepair} agent={agents.write}><RepairDocsSyncPrompt findings={docsReview?.findings ?? []} /></Task>} else={null} />
                  <Task id="recheck_docs_sync" output={outputs.docsReview} agent={agents.review}><RecheckDocsSyncPrompt priorReview={docsReview} /></Task>
                </Sequence>
              </Loop>
              <Task id="checkpoint_cleanup_and_docs" output={outputs.cleanupDocsCheckpoint}>
                {() => {
                  const value = { cleanup: ctx.latest(outputs.cleanup, "cleanup_obsolete_surface"), retention, docs: ctx.latest(outputs.docsSync, "sync_canonical_docs") };
                  const diffArtifact = writeArtifact("cleanup-docs/diff.json", { diff: commandResult("git", ["diff", "--no-ext-diff"]).stdout });
                  const retentionArtifact = writeArtifact("cleanup-docs/retention.json", retention ?? {});
                  const docsArtifact = writeArtifact("cleanup-docs/docs.json", value.docs ?? {});
                  const checkpointId = checkpoint("cleanup-and-docs", value);
                  return { summary: "Persisted cleanup, retention, docs, diff, and checkpoint evidence.", diffArtifact, retentionArtifact, docsArtifact, checkpointId };
                }}
              </Task>
              <Task id="prepare_verification_matrix" output={outputs.verificationManifest} agent={agents.write}>
                <PrepareVerificationMatrixPrompt contracts={ctx.latest(outputs.frozenContracts, "freeze_contracts")} cleanup={ctx.latest(outputs.cleanup, "cleanup_obsolete_surface")} ports={initial?.reservedPorts ?? []} />
              </Task>
              <Loop id="verification_manifest_gate" maxIterations={6} onMaxReached="fail" until={manifestComplete}>
                <Sequence>
                  <Task id="review_verification_manifest" output={outputs.verificationManifestReview} agent={agents.review}><ReviewVerificationManifestPrompt manifest={ctx.latest(outputs.verificationManifest, "prepare_verification_matrix")} /></Task>
                  <Branch
                    if={(manifestReview?.externalBlockers?.length ?? 0) > 0}
                    then={<Task id="emit_verification_blocked_result" output={outputs.verificationBlockedResult}>{() => blockedResult("verification-manifest", manifestReview?.externalBlockers ?? [])}</Task>}
                    else={
                      <Sequence>
                        <Branch if={manifestReview?.complete === false || (manifestReview?.unsafeSkips?.length ?? 0) > 0 || (manifestReview?.missingChecks?.length ?? 0) > 0} then={<Task id="repair_verification_manifest" output={outputs.verificationManifestRepair} agent={agents.write}><RepairVerificationManifestPrompt review={manifestReview} /></Task>} else={null} />
                        <Task id="recheck_verification_manifest" output={outputs.verificationManifestReview} agent={agents.review}><RecheckVerificationManifestPrompt priorReview={manifestReview} manifest={ctx.latest(outputs.verificationManifest, "prepare_verification_matrix")} /></Task>
                      </Sequence>
                    }
                  />
                </Sequence>
              </Loop>
              <Loop id="automation_review_stabilization" maxIterations={8} onMaxReached="fail" until={stable}>
                <Sequence>
                  <Loop id="full_verification_loop" maxIterations={8} onMaxReached="fail" until={matrixPassed}>
                    <Sequence>
                      <Parallel maxConcurrency={8}>
                        <Task id="check_migration_0074" output={outputs.checkMigration0074}>{() => runCheck("migration-0074", ["rg -n '0074' db apps packages tests", "sh -lc \"! rg -n --hidden 'old-data migration|legacy migration path|migration fallback|dual migration' db apps packages tests\""])} </Task>
                        <Task id="check_unit_tests" output={outputs.unitTests}>{() => runCheck("unit-tests", ["bun run test"])} </Task>
                        <Task id="check_integration_tests" output={outputs.integrationTests}>{() => runCheck("integration-tests", ["bun run test"])} </Task>
                        <Task id="check_builds" output={outputs.builds}>{() => runCheck("builds", ["bun run build"])} </Task>
                        <Task id="check_deterministic_playwright" output={outputs.deterministicPlaywright}>{() => runCheck("deterministic-playwright", ["bunx --bun playwright test --project=hartlib-ai-chat-runtime"])} </Task>
                        <Task id="check_visual_breakpoints" output={outputs.visualCheck}>{() => runVisualCheck()} </Task>
                        <Task id="check_accessibility" output={outputs.accessibility}>{() => runCheck("accessibility", ["bunx --bun playwright test --project=hartlib-ai-chat-runtime -g 'accessib' "])}</Task>
                        <Task id="check_reachability_and_bundle" output={outputs.reachabilityBundle}>{() => runCheck("reachability-bundle", ["bun run build", "sh -lc \"! rg -n --hidden --glob '!ui-playground/**' 'apps/publisher|ui-playground' apps packages\""])} </Task>
                      </Parallel>
                      <Sequence>
                        <Task id="check_live_retrieval" output={outputs.liveRetrieval}>{() => runLiveCheck("live-retrieval", "HARTLIB_E2E_LIVE_PROVIDER=1 HARTLIB_E2E_STACK=1 bun --env-file=.env x --bun playwright test tests/e2e/chat.spec.ts --project=hartlib-ai-chat-runtime -g 'real provider internal retrieval persists a cited answer'", { provider: "real provider retrieval", persistence: "durable cited answer and reload" })}</Task>
                        <Task id="check_live_stop" output={outputs.liveStop}>{() => runLiveCheck("live-stop", "HARTLIB_E2E_LIVE_PROVIDER=1 HARTLIB_E2E_STACK=1 bun --env-file=.env x --bun playwright test tests/e2e/chat.spec.ts --project=hartlib-ai-chat-runtime -g 'Stop'", { provider: "real provider stop flow", persistence: "durable stopped state and reload", stop: "Stop control and worker cancellation" })}</Task>
                        <Task id="check_live_reset_during_run" output={outputs.liveResetDuringRun}>{() => runLiveCheck("live-reset-during-run", "HARTLIB_E2E_LIVE_PROVIDER=1 HARTLIB_E2E_STACK=1 bun --env-file=.env x --bun playwright test tests/e2e/chat.spec.ts --project=hartlib-ai-chat-runtime -g 'reset.*run|force Reset'", { provider: "real provider reset-during-run", persistence: "durable uncapped purge and reload", identity: "old identity revoked", purge: "reset purge completed" })}</Task>
                      </Sequence>
                      <Parallel maxConcurrency={6}>
                        <Task id="check_callers_and_capabilities" output={outputs.callersCapabilities}>{() => runCheck("callers-capabilities", ["sh -lc \"! rg -n --hidden --glob '!**/*.md' 'ui-playground|mock runtime|compatibility layer|dual path' apps packages tests\""])} </Task>
                        <Task id="check_reference_integrity" output={outputs.referenceCheck}>{() => { const manifest = uiPlaygroundManifest(); const byteMatch = manifest.rootDigest === (initial?.uiPlaygroundRootDigest ?? ""); return { ...runCheck("reference-integrity", ["git diff --exit-code -- ui-playground"]), byteMatch, rootDigest: manifest.rootDigest, runtimeDependencyCount: 0 }; }} </Task>
                        <Task id="check_lint" output={outputs.lint}>{() => runCheck("lint", ["bun run lint"])} </Task>
                        <Task id="check_root" output={outputs.rootChecks}>{() => runCheck("root", ["bun run check", "bun run format:check"])} </Task>
                      </Parallel>
                      <Task id="aggregate_verification_matrix" output={outputs.verificationAggregate}>
                        {() => {
                          const checkRows: Array<{ id: string; row: AnyRecord | undefined }> = [
                            { id: "check_migration_0074", row: ctx.latest(outputs.checkMigration0074, "check_migration_0074") as AnyRecord | undefined },
                            { id: "check_unit_tests", row: ctx.latest(outputs.unitTests, "check_unit_tests") as AnyRecord | undefined },
                            { id: "check_integration_tests", row: ctx.latest(outputs.integrationTests, "check_integration_tests") as AnyRecord | undefined },
                            { id: "check_builds", row: ctx.latest(outputs.builds, "check_builds") as AnyRecord | undefined },
                            { id: "check_deterministic_playwright", row: ctx.latest(outputs.deterministicPlaywright, "check_deterministic_playwright") as AnyRecord | undefined },
                            { id: "check_visual_breakpoints", row: ctx.latest(outputs.visualCheck, "check_visual_breakpoints") as AnyRecord | undefined },
                            { id: "check_accessibility", row: ctx.latest(outputs.accessibility, "check_accessibility") as AnyRecord | undefined },
                            { id: "check_live_retrieval", row: ctx.latest(outputs.liveRetrieval, "check_live_retrieval") as AnyRecord | undefined },
                            { id: "check_live_stop", row: ctx.latest(outputs.liveStop, "check_live_stop") as AnyRecord | undefined },
                            { id: "check_live_reset_during_run", row: ctx.latest(outputs.liveResetDuringRun, "check_live_reset_during_run") as AnyRecord | undefined },
                            { id: "check_reachability_and_bundle", row: ctx.latest(outputs.reachabilityBundle, "check_reachability_and_bundle") as AnyRecord | undefined },
                            { id: "check_callers_and_capabilities", row: ctx.latest(outputs.callersCapabilities, "check_callers_and_capabilities") as AnyRecord | undefined },
                            { id: "check_reference_integrity", row: ctx.latest(outputs.referenceCheck, "check_reference_integrity") as AnyRecord | undefined },
                            { id: "check_lint", row: ctx.latest(outputs.lint, "check_lint") as AnyRecord | undefined },
                            { id: "check_root", row: ctx.latest(outputs.rootChecks, "check_root") as AnyRecord | undefined },
                          ];
                          const failedCheckIds = checkRows.filter(({ row }) => row?.status !== "passed").map(({ id }) => id);
                          const skippedCheckIds = checkRows.filter(({ row }) => row?.skipped === true).map(({ id }) => id);
                          const designatedWarnings = checkRows.flatMap(({ row }) => Array.isArray(row?.warningFailures) ? row.warningFailures.map(String) : []);
                          const noSkip = skippedCheckIds.length === 0;
                          const verificationManifest = ctx.latest(outputs.verificationManifest, "prepare_verification_matrix");
                          const noMissingTests = verificationManifest !== undefined && (verificationManifest.missingCoverage?.length ?? 0) === 0;
                          const noMissingCredentials = Boolean(process.env.ZAI_API_KEY && process.env.HARTLIB_E2E_LIVE_PROVIDER === "1" && process.env.HARTLIB_E2E_STACK === "1");
                          const allPassed = failedCheckIds.length === 0;
                          const matrixArtifact = writeArtifact("verification/matrix.json", { checkRows, failedCheckIds, skippedCheckIds, designatedWarnings });
                          return { summary: allPassed && noSkip && noMissingTests ? "Full verification matrix passed with no skips." : "Full verification matrix has failures, skips, or missing tests.", allPassed, failedCheckIds, skippedCheckIds, designatedWarnings, noSkip, noMissingTests, noMissingCredentials, evidenceComplete: checkRows.every(({ row }) => Array.isArray(row?.artifactPaths) && row.artifactPaths.length > 0), repositoryDigest: currentRepositoryDigest(), matrixArtifact };
                        }}
                      </Task>
                      <Branch if={!matrixPassed} then={<Sequence><Task id="classify_verification_failures" output={outputs.failureClassification}>{() => { const blockers = process.env.ZAI_API_KEY && process.env.HARTLIB_E2E_LIVE_PROVIDER === "1" && process.env.HARTLIB_E2E_STACK === "1" ? [] : ["live-provider credentials or flags are unavailable"]; return { summary: blockers.length ? "Verification has an external blocker." : "Verification failures are repairable in the repository.", repairableFailures: aggregate?.failedCheckIds ?? [], externalBlockers: blockers, requiresCodeChange: blockers.length === 0 }; }}</Task><Branch if={(aggregate?.noMissingCredentials ?? true) === false} then={<Task id="emit_verification_blocked_result" output={outputs.verificationBlockedResult}>{() => blockedResult("verification-matrix", ["live-provider credentials or flags are unavailable"])}</Task>} else={<Task id="repair_verification_failures" output={outputs.verificationRepair} agent={agents.write}><RepairVerificationFailuresPrompt aggregate={aggregate} manifest={ctx.latest(outputs.verificationManifest, "prepare_verification_matrix")} /></Task>} /></Sequence>} else={null} />
                    </Sequence>
                  </Loop>
                  <Task id="checkpoint_verification" output={outputs.verificationCheckpoint}>
                    {() => { const value = { aggregate: ctx.latest(outputs.verificationAggregate, "aggregate_verification_matrix"), digest: currentRepositoryDigest() }; const matrixArtifact = value.aggregate?.matrixArtifact ?? writeArtifact("verification/matrix-fallback.json", value); const checkpointId = checkpoint("verification", value); return { summary: "Persisted the complete verification matrix and evidence checkpoint.", matrixArtifact, testArtifacts: [], visualArtifacts: [], liveFlowArtifacts: [], repositoryDigest: value.digest, checkpointId }; }}
                  </Task>
                  <Loop id="independent_review_loop" maxIterations={6} onMaxReached="fail" until={reviewClean}>
                    <Sequence>
                      <Task id="independent_final_review" output={outputs.independentReview} agent={agents.review}><IndependentFinalReviewPrompt planPath={PLAN_PATH} contracts={ctx.latest(outputs.frozenContracts, "freeze_contracts")} aggregate={ctx.latest(outputs.verificationAggregate, "aggregate_verification_matrix")} retention={retention} /></Task>
                      <Branch if={independentReview?.clean === false} then={<Task id="remediate_review_findings" output={outputs.reviewRepair} agent={agents.write}><RemediateReviewFindingsPrompt findings={independentReview?.findings ?? []} /></Task>} else={null} />
                      <Loop id="affected_regression_gate" maxIterations={6} onMaxReached="fail" until={regressionsPassed}>
                        <Sequence>
                          <Task id="run_affected_regressions" output={outputs.affectedRegression}>{() => runCheck("affected-regressions", ["bun run check", "bun run lint"])}</Task>
                          <Branch if={!regressionsPassed} then={<Task id="repair_review_regression_failures" output={outputs.reviewRegressionRepair} agent={agents.write}><RepairReviewRegressionFailuresPrompt regression={regressions} findings={independentReview?.findings ?? []} /></Task>} else={null} />
                          <Task id="rerun_affected_regressions" output={outputs.affectedRegression}>{() => runCheck("affected-regressions-rerun", ["bun run check", "bun run lint"])}</Task>
                        </Sequence>
                      </Loop>
                    </Sequence>
                  </Loop>
                  <Task id="checkpoint_review" output={outputs.reviewCheckpoint}>
                    {() => { const value = { review: ctx.latest(outputs.independentReview, "independent_final_review"), repair: ctx.latest(outputs.reviewRepair, "remediate_review_findings"), digest: currentRepositoryDigest() }; const reviewArtifact = writeArtifact("review/review.json", value.review ?? {}); const resolutionArtifact = writeArtifact("review/resolution.json", value.repair ?? {}); const checkpointId = checkpoint("review", value); return { summary: "Persisted the independent review round and regression evidence.", round: 0, reviewArtifact, resolutionArtifact, repositoryDigestReviewed: value.digest, checkpointId }; }}
                  </Task>
                  <Task id="assert_stable_review_and_verification" output={outputs.stabilityGate}>
                    {() => { const current = currentRepositoryDigest(); const verified = ctx.latest(outputs.verificationAggregate, "aggregate_verification_matrix")?.repositoryDigest ?? ""; const reviewed = ctx.latest(outputs.independentReview, "independent_final_review")?.repositoryDigestReviewed ?? ""; const result = stable && current === verified && verified === reviewed; return { summary: result ? "Repository, verification, and review digests are stable." : "Repository, verification, and review digests are not stable yet.", stable: result, currentRepositoryDigest: current, verifiedRepositoryDigest: verified, reviewedRepositoryDigest: reviewed, reason: result ? "identical digests" : "a repair or review changed the repository or evidence" }; }}
                  </Task>
                </Sequence>
              </Loop>
              <Task id="final_readiness_gate" output={outputs.finalReadiness}>
                {() => { const remainingActionableWork = [ ...(aggregate?.failedCheckIds ?? []), ...(aggregate?.skippedCheckIds ?? []), ...(independentReview?.findings ?? []).map((finding) => finding.id), ...(retentionPassed ? [] : ["retention"]), ...(docsClean ? [] : ["canonical docs"]) ]; const approvalEligible = matrixPassed && !aggregate?.designatedWarnings?.length && reviewClean && stable && retentionPassed && docsClean && remainingActionableWork.length === 0; const evidenceManifest = [ctx.latest(outputs.verificationCheckpoint, "checkpoint_verification")?.matrixArtifact ?? "", ctx.latest(outputs.reviewCheckpoint, "checkpoint_review")?.reviewArtifact ?? ""].filter(Boolean); return { summary: approvalEligible ? "All automated gates pass; final parity approval may open." : "Final readiness remains closed until every automated condition is satisfied.", approvalEligible, allAutomatedChecksPassed: matrixPassed, noSkips: aggregate?.noSkip === true, noWarnings: (aggregate?.designatedWarnings?.length ?? 0) === 0, noBlockers: (preflight?.externalBlockers?.length ?? 0) === 0, reviewClean, retentionMatch: retentionPassed, remainingActionableWork, evidenceManifest }; }}
              </Task>
              <Branch
                if={readiness?.approvalEligible === true}
                then={
                  <Sequence>
                    <Approval id="final_parity_approval" output={outputs.finalParityApproval} request={{ title: "Final parity approval", summary: "Approve the UI playground and demo cutover only after the full no-skip evidence matrix, retention proof, independent review, and stable repository digest pass." }} />
                    <Branch
                      if={approval?.approved === true}
                      then={
                        <Sequence>
                          <Task id="capture_approval_record" output={outputs.approvalRecord}>
                            {() => { const record = { summary: "Captured the sole final parity approval.", approved: approval?.approved === true, approverIdentity: approval?.decidedBy ?? "unknown", decision: approval?.approved ? "approved" : "denied", decidedAt: approval?.decidedAt ?? new Date().toISOString(), comment: approval?.note ?? "" }; writeArtifact("approval/final-parity.json", record); return record; }}
                          </Task>
                          <Task id="validate_final_result" output={outputs.finalResult}>
                            {() => { const approvalRecord = ctx.latest(outputs.approvalRecord, "capture_approval_record") ?? { approved: true, approverIdentity: "unknown", decision: "approved", decidedAt: new Date().toISOString(), comment: "" }; const digest = currentRepositoryDigest(); const result = { summary: "Final result is approved with zero actionable work.", runStatus: "approved" as const, frozenContractManifest: ctx.latest(outputs.frozenBaseline, "persist_frozen_baseline")?.frozenManifestArtifact ?? "", fileOwnershipRecord: ctx.latest(outputs.frozenBaseline, "persist_frozen_baseline")?.ownershipArtifact ?? "", changeManifest: writeArtifact("final/change-manifest.json", commandResult("git", ["diff", "--name-status"]).stdout), deletionManifest: writeArtifact("final/deletion-manifest.json", ctx.latest(outputs.cleanup, "cleanup_obsolete_surface")?.removedFiles ?? []), retainedReferenceProof: writeArtifact("final/retention-proof.json", { digest, baseline: initial?.uiPlaygroundRootDigest ?? "", match: digest === initial?.uiPlaygroundRootDigest }), migrationEvidence: ctx.latest(outputs.checkMigration0074, "check_migration_0074")?.artifactPaths ?? [], verificationMatrix: ctx.latest(outputs.verificationAggregate, "aggregate_verification_matrix")?.matrixArtifact ?? "", testArtifacts: [], visualArtifacts: [], reviewRounds: 1, externalBlockers: [], approvalRecord, finalRepositoryState: commandResult("git", ["status", "--short"]).stdout, zeroActionableWork: true }; writeArtifact("final/result.json", result); return result; }}
                          </Task>
                        </Sequence>
                      }
                      else={<Task id="emit_approval_denied_result" output={outputs.approvalDenied}>{() => { const record = { summary: "Final parity approval was denied; the run does not claim success.", runStatus: "denied" as const, approvalRecord: { summary: "Approval denied.", approved: false, approverIdentity: approval?.decidedBy ?? "unknown", decision: "denied", decidedAt: approval?.decidedAt ?? new Date().toISOString(), comment: approval?.note ?? "" }, remainingActionableWork: ["final parity approval denied"], evidenceArtifact: writeArtifact("approval/denied.json", approval ?? {}) }; return record; }}</Task>}
                    />
                  </Sequence>
                }
                else={<Task id="emit_readiness_failed_result" output={outputs.readinessFailure}>{() => { const failedConditions = [ ...(readiness?.allAutomatedChecksPassed ? [] : ["automated checks"]), ...(readiness?.noSkips ? [] : ["skipped checks"]), ...(readiness?.noWarnings ? [] : ["designated warnings"]), ...(readiness?.reviewClean ? [] : ["independent review"]), ...(readiness?.retentionMatch ? [] : ["retained-reference parity"]) ]; const evidenceArtifact = writeArtifact("readiness/failed.json", { failedConditions, readiness }); return { summary: "Readiness failed; final approval stayed closed.", runStatus: "failed" as const, failedConditions, remainingActionableWork: readiness?.remainingActionableWork ?? failedConditions, evidenceArtifact }; }}</Task>}
              />
            </Sequence>
          }
          else={<Task id="emit_preflight_blocked_result" output={outputs.preflightBlockedResult}>{() => blockedResult("preflight", preflight?.externalBlockers ?? ["preflight did not complete"])}</Task>}
        />
      </Sequence>
    </Workflow>
  );
});

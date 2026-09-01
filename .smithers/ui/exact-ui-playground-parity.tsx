/** @jsxImportSource react */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRunTree,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import {
  ApprovalPanel,
  ConnectionBadge,
  FleetTable,
  LaunchButton,
  NodeChatStream,
  NodeOutputCard,
  NodeOutputView,
  NodeStageStrip,
  RunEventLog,
  RunList,
  RunTree,
  nodeStatusIndex,
  rollupNodeStatus,
  StatusPill as GatewayStatusPill,
  WorkflowUiShell,
} from "smithers-orchestrator/gateway-ui";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DiffHunks,
  EmptyState,
  FileTree,
  KpiStat,
  Progress,
  SmithersUiStyles,
  StatusPill as UiStatusPill,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  parseUnifiedFile,
  type DiffFile,
} from "smithers-orchestrator/ui";

const WORKFLOW_KEY = "exact-ui-playground-parity";

const STAGES = [
  { nodeId: "audit_and_plan", label: "Audit" },
  { nodeId: "implement_slice", label: "Implement" },
  { nodeId: "integrate_initial", label: "Integrate" },
  { nodeId: "focused_checks_initial", label: "Checks" },
  { nodeId: "browser_smoke_initial", label: "Browser" },
  { nodeId: "independent_review_initial", label: "Review" },
  { nodeId: "repair_slice", label: "Repair" },
  { nodeId: "integrate_repair", label: "Repair merge" },
  { nodeId: "focused_checks_repair", label: "Repair checks" },
  { nodeId: "browser_smoke_repair", label: "Repair browser" },
  { nodeId: "independent_review_repair", label: "Repair review" },
  { nodeId: "focused_checks_final", label: "Final checks" },
  { nodeId: "browser_smoke_final", label: "Final browser" },
  { nodeId: "final_proof", label: "Proof" },
  { nodeId: "enforce_result", label: "Result" },
];

const AGENT_NODES: Array<{ nodeId: string; title: string; subtitle: string }> = [
  { nodeId: "audit_and_plan", title: "Audit and plan", subtitle: "Sol · read-only audit" },
  { nodeId: "implement_slice", title: "Implementation slice", subtitle: "Luna · isolated worktree" },
  { nodeId: "integrate_initial", title: "Initial integration", subtitle: "Luna · merge owner" },
  { nodeId: "browser_smoke_initial", title: "Initial browser smoke", subtitle: "Spark · read-only browser" },
  { nodeId: "independent_review_initial", title: "Initial independent review", subtitle: "Sol · read-only review" },
  { nodeId: "repair_slice", title: "Repair slice", subtitle: "Luna · isolated worktree" },
  { nodeId: "integrate_repair", title: "Repair integration", subtitle: "Luna · merge owner" },
  { nodeId: "browser_smoke_repair", title: "Repair browser smoke", subtitle: "Spark · read-only browser" },
  { nodeId: "independent_review_repair", title: "Repair independent review", subtitle: "Sol · read-only review" },
  { nodeId: "browser_smoke_final", title: "Final browser smoke", subtitle: "Spark · read-only browser" },
  { nodeId: "final_proof", title: "Final proof", subtitle: "Sol · read-only reconciliation" },
];

type Row = Record<string, unknown>;

type Column = {
  key: string;
  label: string;
  render?: (row: Row) => ReactNode;
};

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

function rowOf(value: unknown): Row {
  let current: unknown = value;
  for (let index = 0; index < 4; index += 1) {
    if (!isRecord(current)) return {};
    if (isRecord(current.row)) {
      current = current.row;
      continue;
    }
    if (isRecord(current.data)) {
      current = current.data;
      continue;
    }
    break;
  }
  if (!isRecord(current)) return {};
  const normalized: Row = {};
  for (const [key, entry] of Object.entries(current)) normalized[key] = parseMaybeJson(entry);
  for (const [key, entry] of Object.entries(normalized)) {
    const camel = camelKey(key);
    if (camel !== key && normalized[camel] === undefined) normalized[camel] = entry;
  }
  return normalized;
}

function records(value: unknown): Row[] {
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) return parsed.filter(isRecord).map(rowOf);
  if (isRecord(parsed)) {
    const nested = parsed.items ?? parsed.rows ?? parsed.results ?? parsed.runs;
    return Array.isArray(nested) ? nested.filter(isRecord).map(rowOf) : [];
  }
  return [];
}

function strings(value: unknown): string[] {
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) return parsed.map((entry) => text(entry)).filter(Boolean);
  const single = text(parsed);
  return single ? [single] : [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;
}

function numberOf(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return fallback;
}

function compact(value: unknown, fallback = "—"): string {
  const parsed = parseMaybeJson(value);
  if (parsed === undefined || parsed === null || parsed === "") return fallback;
  if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") return String(parsed);
  try {
    const serialized = JSON.stringify(parsed);
    return serialized.length > 280 ? `${serialized.slice(0, 277)}…` : serialized;
  } catch {
    return fallback;
  }
}

function hasRow(row: Row): boolean {
  return Object.keys(row).length > 0;
}

function booleanStatus(value: unknown): string {
  if (value === undefined || value === null || value === "") return "pending";
  return bool(value) ? "passed" : "failed";
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function runIdFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("runId") ?? undefined;
}

function canonicalAgentNode(nodeId: string | undefined): string | undefined {
  if (!nodeId) return undefined;
  return AGENT_NODES.find(({ nodeId: candidate }) => nodeId === candidate || nodeId.startsWith(`${candidate}:`))?.nodeId;
}

function nodeIdOf(value: Row): string {
  return text(value.id ?? value.nodeId);
}

function iterationsFor(nodes: ReadonlyArray<Row>): number[] {
  const repairIds = new Set([
    "repair_slice",
    "integrate_repair",
    "focused_checks_repair",
    "browser_smoke_repair",
    "independent_review_repair",
  ]);
  const iterations = new Set<number>();
  for (const node of nodes) {
    const nodeId = nodeIdOf(node);
    if ([...repairIds].some((id) => nodeId === id || nodeId.startsWith(`${id}:`))) {
      iterations.add(numberOf(node.iteration, 0));
    }
  }
  return [...iterations].sort((left, right) => left - right);
}

function artifactHref(value: unknown): string | undefined {
  const artifact = text(value).trim();
  return artifact || undefined;
}

function ArtifactRef({ value, label }: { value: unknown; label?: string }) {
  const href = artifactHref(value);
  if (!href) return <span>—</span>;
  const display = label ?? href;
  if (/^(https?:\/\/|\/)/.test(href)) {
    return <a href={href} target="_blank" rel="noreferrer">{display}</a>;
  }
  return <code>{display}</code>;
}

function Value({ value }: { value: unknown }) {
  const raw = text(value);
  if (/^(https?:\/\/|\/)/.test(raw)) return <ArtifactRef value={raw} />;
  return <span>{compact(value)}</span>;
}

function Panel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <p>{description}</p> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function RecordTable({ rows, columns, empty = "No recorded output yet." }: { rows: Row[]; columns: Column[]; empty?: string }) {
  if (rows.length === 0) return <EmptyState title="No evidence yet" description={empty} />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column) => <TableHead key={column.key}>{column.label}</TableHead>)}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={`${text(row.entryId ?? row.differenceId ?? row.sliceId ?? row.checkId ?? row.name ?? row.path, "row")}-${index}`}>
            {columns.map((column) => <TableCell key={column.key}>{column.render ? column.render(row) : <Value value={row[column.key]} />}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function statusFor(row: Row, key = "passed"): string {
  if (row[key] === undefined) return "pending";
  return bool(row[key]) ? "passed" : "failed";
}

function evidencePreview(value: unknown, label: string) {
  const href = artifactHref(value);
  if (!href) return <EmptyState title={`No ${label.toLowerCase()}`} description="The task has not supplied an artifact." />;
  const isImage = /\.(png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(href);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {isImage && /^(https?:\/\/|\/)/.test(href) ? <img src={href} alt={label} style={{ maxWidth: "100%", height: "auto" }} /> : null}
      <ArtifactRef value={href} label={label} />
    </div>
  );
}

function EvidencePair({ comparison }: { comparison: Row }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
      <Card><CardHeader><CardTitle>Current app</CardTitle></CardHeader><CardContent>{evidencePreview(comparison.currentCapture, "Current capture")}</CardContent></Card>
      <Card><CardHeader><CardTitle>UI playground</CardTitle></CardHeader><CardContent>{evidencePreview(comparison.playgroundCapture, "Playground capture")}</CardContent></Card>
      <Card><CardHeader><CardTitle>Visual diff</CardTitle></CardHeader><CardContent>{evidencePreview(comparison.diffArtifact, "Diff artifact")}</CardContent></Card>
    </div>
  );
}

function firstUnifiedDiff(rows: Row[]): DiffFile | undefined {
  for (const row of rows) {
    const diffBundle = text(row.diffBundle).trim();
    if (!diffBundle || !diffBundle.includes("@@")) continue;
    try {
      const parsed = parseUnifiedFile(diffBundle);
      if (parsed.lines.length > 0) return parsed;
    } catch {
      continue;
    }
  }
  return undefined;
}

function nodeSuffix(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-") || "slice";
}

function sliceTaskId(prefix: "implement_slice" | "repair_slice", slice: Row): string {
  return `${prefix}:${nodeSuffix(text(slice.sliceId))}`;
}

function SliceImplementationCard({ runId, slice }: { runId: string | undefined; slice: Row }) {
  const taskId = sliceTaskId("implement_slice", slice);
  const output = useGatewayNodeOutput({ runId, nodeId: taskId, iteration: 0 });
  const result = rowOf(output.data);
  const diff = firstUnifiedDiff([result]);

  return (
    <Card>
      <CardHeader><CardTitle>{text(slice.sliceId, taskId)}</CardTitle></CardHeader>
      <CardContent>
        {!hasRow(result) ? <EmptyState title="Slice output pending" description="This isolated implementation task has not returned a typed result." /> : <>
          <RecordTable
            rows={[result]}
            columns={[
              { key: "resolvedDifferenceIds", label: "Resolved" },
              { key: "unresolvedDifferenceIds", label: "Unresolved" },
              { key: "changedFiles", label: "Changed files" },
              { key: "ownershipViolations", label: "Ownership violations" },
              { key: "passed", label: "Status", render: (row) => <UiStatusPill status={statusFor(row)} /> },
            ]}
          />
          {diff ? <div style={{ marginTop: 12 }}><DiffHunks file={diff} /></div> : null}
        </>}
      </CardContent>
    </Card>
  );
}

function RepairSliceCard({ runId, iteration, slice }: { runId: string | undefined; iteration: number; slice: Row }) {
  const taskId = sliceTaskId("repair_slice", slice);
  const output = useGatewayNodeOutput({ runId, nodeId: taskId, iteration });
  const result = rowOf(output.data);
  const diff = firstUnifiedDiff([result]);

  if (!hasRow(result)) return null;
  return (
    <Card>
      <CardHeader><CardTitle>{text(slice.sliceId, taskId)}</CardTitle></CardHeader>
      <CardContent>
        <RecordTable
          rows={[result]}
          columns={[
            { key: "reportedDifferenceIds", label: "Reported" },
            { key: "resolvedDifferenceIds", label: "Resolved" },
            { key: "unresolvedDifferenceIds", label: "Unresolved" },
            { key: "changedFiles", label: "Changed files" },
            { key: "ownershipViolations", label: "Ownership violations" },
            { key: "passed", label: "Status", render: (row) => <UiStatusPill status={statusFor(row)} /> },
          ]}
        />
        {diff ? <div style={{ marginTop: 12 }}><DiffHunks file={diff} /></div> : null}
      </CardContent>
    </Card>
  );
}

function RepairIterationCard({ runId, iteration, slices }: { runId: string | undefined; iteration: number; slices: Row[] }) {
  const integration = useGatewayNodeOutput({ runId, nodeId: "integrate_repair", iteration });
  const focused = useGatewayNodeOutput({ runId, nodeId: "focused_checks_repair", iteration });
  const smoke = useGatewayNodeOutput({ runId, nodeId: "browser_smoke_repair", iteration });
  const review = useGatewayNodeOutput({ runId, nodeId: "independent_review_repair", iteration });
  const integrationRow = rowOf(integration.data);
  const focusedRow = rowOf(focused.data);
  const smokeRow = rowOf(smoke.data);
  const reviewRow = rowOf(review.data);
  const coverage = rowOf(reviewRow.coverageResult);
  const repairDifferences = records(reviewRow.differences);
  const comparisons = records(reviewRow.comparisonResults);
  const reviewPending = !hasRow(reviewRow);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Repair iteration {iteration + 1}</CardTitle>
      </CardHeader>
      <CardContent>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
          <KpiStat label="Repair slices" value={slices.length} hint="assigned owners" />
          <KpiStat label="Resolved" value={strings(integrationRow.resolvedDifferenceIds).length} hint="integrated" />
          <KpiStat label="Stable pixels" value={comparisons.reduce((sum, entry) => sum + numberOf(entry.changedStablePixels), 0)} hint="fresh review" />
          <KpiStat label="Visible differences" value={repairDifferences.length} hint={text(reviewRow.verdict, "pending")} />
        </div>
        <div style={{ marginTop: 12 }}>
          <RecordTable
            rows={repairDifferences}
            columns={[
              { key: "differenceId", label: "Difference" },
              { key: "entryId", label: "Entry" },
              { key: "category", label: "Category" },
              { key: "region", label: "Region" },
              { key: "owner", label: "Owner" },
            ]}
            empty="The repair reviewer has not returned differences for this iteration."
          />
        </div>
        <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
          {slices.map((slice) => <RepairSliceCard key={text(slice.sliceId)} runId={runId} iteration={iteration} slice={slice} />)}
        </div>
        {hasRow(integrationRow) ? <div style={{ marginTop: 12 }}>
          <RecordTable
            rows={[integrationRow]}
            columns={[
              { key: "mergedSlices", label: "Merged slices" },
              { key: "resolvedDifferenceIds", label: "Resolved" },
              { key: "sharedFilesChanged", label: "Shared files" },
              { key: "conflicts", label: "Conflicts" },
              { key: "ownershipViolations", label: "Violations" },
              { key: "passed", label: "Status", render: (row) => <UiStatusPill status={statusFor(row)} /> },
            ]}
          />
        </div> : null}
        {comparisons[0] ? <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
          <EvidencePair comparison={comparisons[0]} />
          <RecordTable
            rows={comparisons}
            columns={[
              { key: "entryId", label: "Entry" },
              { key: "changedStablePixels", label: "Changed stable pixels" },
              { key: "visibleDifferenceCount", label: "Visible differences" },
              { key: "normalizationRuleIds", label: "Normalization" },
              { key: "diffArtifact", label: "Diff", render: (row) => <ArtifactRef value={row.diffArtifact} /> },
            ]}
          />
        </div> : null}
        <div style={{ marginTop: 12 }}>
          <RecordTable
            rows={records(focusedRow.results).map((entry) => ({ ...entry, phase: "focused" })).concat(records(smokeRow.results).map((entry) => ({ ...entry, phase: "browser" })))}
            columns={[
              { key: "phase", label: "Phase" },
              { key: "name", label: "Check", render: (row) => <Value value={row.name ?? row.checkId} /> },
              { key: "passed", label: "Status", render: (row) => <UiStatusPill status={statusFor(row)} /> },
              { key: "skipped", label: "Skipped" },
              { key: "artifact", label: "Evidence", render: (row) => <ArtifactRef value={row.artifact ?? row.evidence} /> },
            ]}
            empty="Repair checks have not produced output yet."
          />
        </div>
        <div style={{ marginTop: 12 }}>
          <KpiStat label="Review coverage" value={reviewPending ? "pending" : `${strings(coverage.reviewedEntryIds).length}/${strings(coverage.expectedEntryIds).length}`} hint={reviewPending ? "waiting for reviewer" : bool(coverage.complete) ? "complete" : "incomplete"} />
        </div>
      </CardContent>
    </Card>
  );
}

function App() {
  const runsQuery = useGatewayRuns({ filter: { workflow: WORKFLOW_KEY, limit: 30 } });
  const runs = useMemo(() => records(runsQuery.data), [runsQuery.data]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const fallbackRunId = text(runs[0]?.runId ?? runs[0]?.id) || undefined;
  const activeRunId = selectedRunId ?? fallbackRunId;
  const [selectedSliceId, setSelectedSliceId] = useState<string | undefined>();
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>("audit_and_plan");
  const [selectedNodeIteration, setSelectedNodeIteration] = useState(0);
  const [activeAgentNode, setActiveAgentNode] = useState<string>("audit_and_plan");
  const [cancelling, setCancelling] = useState(false);

  const actions = useGatewayActions();
  const runQuery = useGatewayRun(activeRunId);
  const tree = useGatewayRunTree(activeRunId);
  const events = useGatewayRunEvents(activeRunId, { maxEvents: 500 });

  const auditOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "audit_and_plan", iteration: 0 });
  const integrateInitialOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "integrate_initial", iteration: 0 });
  const focusedInitialOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "focused_checks_initial", iteration: 0 });
  const smokeInitialOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "browser_smoke_initial", iteration: 0 });
  const reviewInitialOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "independent_review_initial", iteration: 0 });
  const focusedFinalOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "focused_checks_final", iteration: 0 });
  const smokeFinalOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "browser_smoke_final", iteration: 0 });
  const finalProofOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "final_proof", iteration: 0 });
  const enforceResultOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "enforce_result", iteration: 0 });

  const run = rowOf(runQuery.data);
  const audit = rowOf(auditOutput.data);
  const initialIntegration = rowOf(integrateInitialOutput.data);
  const focusedInitial = rowOf(focusedInitialOutput.data);
  const smokeInitial = rowOf(smokeInitialOutput.data);
  const initialReview = rowOf(reviewInitialOutput.data);
  const focusedFinal = rowOf(focusedFinalOutput.data);
  const smokeFinal = rowOf(smokeFinalOutput.data);
  const finalProof = rowOf(finalProofOutput.data);
  const enforceResult = rowOf(enforceResultOutput.data);
  const runStatus = text(run.status, activeRunId ? "pending" : "unknown");
  const coverageMatrix = records(audit.coverageMatrix);
  const inventory = records(audit.differenceInventory);
  const ownership = rowOf(audit.ownershipPlan);
  const slices = records(ownership.slices);
  const initialComparison = records(initialReview.comparisonResults);
  const initialDifferences = records(initialReview.differences);
  const initialCoverage = rowOf(initialReview.coverageResult);
  const finalReview = rowOf(finalProof.reviewVerdict);
  const treeRows = tree.nodes as unknown as ReadonlyArray<Row>;
  const nodeStatuses = useMemo(() => nodeStatusIndex(tree.nodes), [tree.nodes]);
  const repairIterations = useMemo(() => iterationsFor(treeRows), [treeRows]);
  const repairLimit = numberOf(rowOf(audit.validatedInputs).maxRepairIterations, 3);
  const selectedSlice = slices.find((slice) => text(slice.sliceId) === selectedSliceId) ?? slices[0];
  const selectedFiles = unique([
    ...strings(selectedSlice?.ownedFiles),
    ...strings(ownership.sharedFiles),
    ...strings(initialIntegration.sharedFilesChanged),
  ]);
  const selectedAgent = AGENT_NODES.find((entry) => entry.nodeId === canonicalAgentNode(activeAgentNode)) ?? AGENT_NODES[0]!;
  const selectedAgentStatus = nodeStatuses.get(activeAgentNode) ?? rollupNodeStatus(nodeStatuses, [activeAgentNode]);
  const approval = rowOf(audit.approval);
  const auditApprovalRequired = bool(approval.required);
  const reviewStablePixels = initialComparison.reduce((sum, comparison) => sum + numberOf(comparison.changedStablePixels), 0);
  const hasFinalReview = hasRow(finalReview);
  const finalStablePixels: number | string = hasFinalReview ? numberOf(finalReview.stableChangedPixels) : "pending";
  const finalVisibleDifferences: number | string = hasFinalReview ? numberOf(finalReview.visibleDifferenceCount) : "pending";
  const evidenceManifest = records(audit.evidenceManifest);
  const latestComparison = initialComparison[0];
  const integrationOverlaps = records(initialIntegration.userChangeOverlaps);
  const finalOverlaps = records(rowOf(finalProof.guardStatus).userChangeOverlaps);
  const checkRows = records(focusedInitial.results).map((entry) => ({ ...entry, phase: "initial focused" }))
    .concat(records(smokeInitial.results).map((entry) => ({ ...entry, phase: "initial browser" })))
    .concat(records(focusedFinal.results).map((entry) => ({ ...entry, phase: "final focused" })))
    .concat(records(smokeFinal.results).map((entry) => ({ ...entry, phase: "final browser" })));

  useEffect(() => {
    if (!selectedSliceId && slices[0]) setSelectedSliceId(text(slices[0].sliceId));
  }, [selectedSliceId, slices]);

  function selectRun(runId: string | undefined) {
    setSelectedRunId(runId);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (runId) url.searchParams.set("runId", runId);
    else url.searchParams.delete("runId");
    window.history.replaceState({}, "", url);
  }

  async function cancelRun() {
    if (!activeRunId) return;
    setCancelling(true);
    try {
      await actions.cancelRun({ runId: activeRunId });
    } finally {
      setCancelling(false);
    }
  }

  const fleetItems = slices.map((slice) => {
    const sliceId = text(slice.sliceId);
    return {
      key: sliceId,
      title: sliceId || "Unnamed slice",
      meta: [text(slice.owner, "unassigned"), String(strings(slice.differenceIds).length), String(strings(slice.ownedFiles).length)],
      nodeIds: [sliceTaskId("implement_slice", slice), sliceTaskId("repair_slice", slice)],
    };
  });

  return (
    <>
      <SmithersUiStyles />
      <WorkflowUiShell
        title="Exact UI Playground Parity"
        testId="exact-ui-playground-parity-ui"
        meta={<><GatewayStatusPill status={runStatus} /><Badge variant="outline">{runs.length} runs</Badge></>}
        actions={<><ConnectionBadge /><LaunchButton workflow={WORKFLOW_KEY} onLaunched={selectRun}>Launch parity audit</LaunchButton><Button variant="destructive" disabled={!activeRunId || cancelling} onClick={() => void cancelRun()}>{cancelling ? "Cancelling…" : "Cancel"}</Button></>}
      >
        <div style={{ display: "grid", gap: 14 }}>
          <Panel title="Run shell" description="Live route, state, viewport, repair, and proof progress.">
            <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 0.7fr) minmax(320px, 1.3fr)", gap: 12 }}>
              <div style={{ display: "grid", gap: 12 }}>
                <RunList filter={{ workflow: WORKFLOW_KEY, limit: 30 }} activeRunId={activeRunId} onSelect={selectRun} />
                {!activeRunId ? <EmptyState title="No run selected" description="Launch a parity audit or select an existing run." /> : null}
              </div>
              <div style={{ display: "grid", gap: 12 }}>
                <NodeStageStrip runId={activeRunId} stages={STAGES} />
                <RunTree
                  runId={activeRunId}
                  activeNodeId={selectedNodeId}
                  onSelectNode={(node) => {
                    setSelectedNodeId(node.id);
                    setSelectedNodeIteration(numberOf(node.iteration, 0));
                    const agentNode = canonicalAgentNode(node.id);
                    if (agentNode) setActiveAgentNode(node.id);
                  }}
                  style={{ minHeight: 220 }}
                />
                <RunEventLog runId={activeRunId} maxEvents={120} style={{ maxHeight: 260 }} />
              </div>
            </div>
          </Panel>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            <KpiStat label="Run status" value={runStatus} hint={activeRunId ?? "no run"} />
            <KpiStat label="Live events" value={events.events.length} hint={events.streaming ? "streaming" : "waiting"} />
            <KpiStat label="Coverage entries" value={coverageMatrix.length} hint="route · state · viewport" />
            <KpiStat label="Open inventory" value={inventory.length} hint="audit findings" />
            <KpiStat label="Repair iterations" value={repairIterations.length} hint={`limit ${repairLimit}`} />
            <KpiStat label="Final verdict" value={text(finalProof.status ?? enforceResult.status ?? initialReview.verdict, "pending")} hint="proof record" />
          </div>

          <Tabs defaultValue="coverage">
            <TabsList>
              <TabsTrigger value="coverage" count={coverageMatrix.length}>Coverage</TabsTrigger>
              <TabsTrigger value="evidence" count={initialComparison.length}>Evidence</TabsTrigger>
              <TabsTrigger value="inventory" count={inventory.length}>Differences</TabsTrigger>
              <TabsTrigger value="ownership" count={slices.length}>Ownership</TabsTrigger>
              <TabsTrigger value="repair" count={repairIterations.length}>Repairs</TabsTrigger>
              <TabsTrigger value="checks" count={checkRows.length}>Checks</TabsTrigger>
              <TabsTrigger value="proof">Verdict</TabsTrigger>
            </TabsList>

            <TabsContent value="coverage">
              <div style={{ display: "grid", gap: 12 }}>
                <Panel title="Route-state-viewport coverage" description="The audit matrix remains the reference set for every independent review.">
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
                    <KpiStat label="Expected" value={strings(initialCoverage.expectedEntryIds).length || coverageMatrix.length} hint="review reference" />
                    <KpiStat label="Reviewed" value={strings(initialCoverage.reviewedEntryIds).length} hint={bool(initialCoverage.complete) ? "complete" : "in progress"} />
                    <KpiStat label="Missing" value={strings(initialCoverage.missingEntryIds).length} hint="must be zero" />
                    <KpiStat label="Duplicates" value={strings(initialCoverage.duplicateEntryIds).length} hint="must be zero" />
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <Progress value={strings(initialCoverage.reviewedEntryIds).length} max={Math.max(strings(initialCoverage.expectedEntryIds).length, coverageMatrix.length, 1)} />
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <RecordTable
                      rows={coverageMatrix}
                      columns={[
                        { key: "entryId", label: "Entry" },
                        { key: "route", label: "Route" },
                        { key: "stateId", label: "State" },
                        { key: "stateKind", label: "Kind" },
                        { key: "viewport", label: "Viewport", render: (row) => <Value value={rowOf(row.viewport).name ?? row.viewport} /> },
                        { key: "status", label: "Audit status", render: (row) => <UiStatusPill status={text(row.status, "pending")} /> },
                      ]}
                      empty="The audit must produce a complete coverage matrix before implementation starts."
                    />
                  </div>
                </Panel>
                {repairIterations.length === 0 ? <EmptyState title="No repair review yet" description="Repair rows appear only after the initial independent review reports differences." /> : repairIterations.map((iteration) => <RepairIterationCard key={iteration} runId={activeRunId} iteration={iteration} slices={slices} />)}
              </div>
            </TabsContent>

            <TabsContent value="evidence">
              <div style={{ display: "grid", gap: 12 }}>
                <Panel title="Paired browser evidence" description="Captures, image diffs, and normalization rules come from the fresh independent review.">
                  {latestComparison ? <EvidencePair comparison={latestComparison} /> : <EmptyState title="No comparison yet" description="The independent reviewer has not published paired captures." />}
                  <div style={{ marginTop: 12 }}>
                    <RecordTable
                      rows={initialComparison}
                      columns={[
                        { key: "entryId", label: "Entry" },
                        { key: "changedStablePixels", label: "Changed stable pixels" },
                        { key: "totalStablePixels", label: "Stable pixels" },
                        { key: "visibleDifferenceCount", label: "Visible differences" },
                        { key: "normalizationRuleIds", label: "Normalization rules" },
                        { key: "diffArtifact", label: "Diff", render: (row) => <ArtifactRef value={row.diffArtifact} /> },
                      ]}
                      empty="Fresh independent review output will list every comparison here."
                    />
                  </div>
                </Panel>
                <Panel title="Audit evidence manifest">
                  <RecordTable
                    rows={evidenceManifest}
                    columns={[
                      { key: "evidenceId", label: "Evidence" },
                      { key: "entryId", label: "Entry" },
                      { key: "kind", label: "Kind" },
                      { key: "artifact", label: "Artifact", render: (row) => <ArtifactRef value={row.artifact} /> },
                      { key: "capturedAt", label: "Captured" },
                    ]}
                    empty="The audit evidence manifest is pending."
                  />
                </Panel>
              </div>
            </TabsContent>

            <TabsContent value="inventory">
              <div style={{ display: "grid", gap: 12 }}>
                <Panel title="Assigned difference inventory" description="Each audit difference belongs to one implementation slice or the integration owner.">
                  <RecordTable
                    rows={inventory.map((difference) => {
                      const resolved = strings(initialIntegration.resolvedDifferenceIds).includes(text(difference.differenceId));
                      return { ...difference, resolutionStatus: resolved ? "resolved" : text(difference.status, "open") };
                    })}
                    columns={[
                      { key: "differenceId", label: "Difference" },
                      { key: "category", label: "Category" },
                      { key: "region", label: "Region" },
                      { key: "sliceId", label: "Slice" },
                      { key: "owner", label: "Owner" },
                      { key: "resolutionStatus", label: "Status", render: (row) => <UiStatusPill status={text(row.resolutionStatus)} /> },
                    ]}
                    empty="The audit has not recorded presentation differences."
                  />
                </Panel>
                <Panel title="Independent reviewer differences">
                  <RecordTable
                    rows={initialDifferences}
                    columns={[
                      { key: "differenceId", label: "Difference" },
                      { key: "entryId", label: "Entry" },
                      { key: "category", label: "Category" },
                      { key: "region", label: "Region" },
                      { key: "expected", label: "Expected" },
                      { key: "actual", label: "Actual" },
                      { key: "owner", label: "Owner" },
                    ]}
                    empty="The initial independent review has no remaining visible differences."
                  />
                </Panel>
                {slices.length > 0 ? <div style={{ display: "grid", gap: 12 }}>
                  {slices.map((slice) => <SliceImplementationCard key={text(slice.sliceId)} runId={activeRunId} slice={slice} />)}
                </div> : <EmptyState title="No implementation slices" description="The audit has not assigned implementation work." />}
              </div>
            </TabsContent>

            <TabsContent value="ownership">
              <div style={{ display: "grid", gap: 12 }}>
                <Panel title="Slice ownership and integration">
                  {fleetItems.length > 0 ? <FleetTable runId={activeRunId} titleColumn="Slice" columns={["Owner", "Differences", "Files"]} items={fleetItems} selectedKey={text(selectedSlice?.sliceId)} onSelect={setSelectedSliceId} /> : <EmptyState title="No slice plan" description="The audit must allocate every difference and file before workers start." />}
                </Panel>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 0.9fr) minmax(340px, 1.1fr)", gap: 12 }}>
                  <Panel title="Owned and shared files">
                    {selectedFiles.length > 0 ? <FileTree nodes={selectedFiles} selected={undefined} renderAffordance={(node) => <Badge variant="outline">{strings(ownership.sharedFiles).includes(node.path) ? "shared" : "owned"}</Badge>} /> : <EmptyState title="No file ownership yet" description="The audit ownership plan has not supplied files." />}
                  </Panel>
                  <Panel title="Integration records">
                    {hasRow(initialIntegration) ? <RecordTable
                      rows={[initialIntegration]}
                      columns={[
                        { key: "mergedSlices", label: "Merged slices" },
                        { key: "sharedFilesChanged", label: "Shared files" },
                        { key: "ownershipViolations", label: "Violations" },
                        { key: "passed", label: "Status", render: (row) => <UiStatusPill status={statusFor(row)} /> },
                      ]}
                    /> : <EmptyState title="Initial integration pending" description="The integration owner has not returned a record." />}
                    <div style={{ marginTop: 12 }}>
                      <RecordTable
                        rows={integrationOverlaps.concat(finalOverlaps)}
                        columns={[
                          { key: "path", label: "Prior user change" },
                          { key: "resolution", label: "Resolution" },
                        ]}
                        empty="No user-change overlaps have been reported."
                      />
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <NodeOutputCard runId={activeRunId} nodeId="integrate_initial" title="Initial integration output" summary="Merge owner record" />
                    </div>
                  </Panel>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="repair">
              <div style={{ display: "grid", gap: 12 }}>
                <Panel title="Bounded repair loop" description="Only reviewer-reported differences enter repairs; each iteration rechecks the entire matrix.">
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
                    <KpiStat label="Limit" value={repairLimit} hint="requested maximum" />
                    <KpiStat label="Completed" value={repairIterations.length} hint="seen in run tree" />
                    <KpiStat label="Initial stable pixels" value={reviewStablePixels} hint="must reach zero" />
                    <KpiStat label="Initial visible differences" value={initialDifferences.length} hint="must reach zero" />
                  </div>
                  <div style={{ marginTop: 12 }}><Progress value={repairIterations.length} max={Math.max(repairLimit, 1)} /></div>
                </Panel>
                {repairIterations.length > 0 ? repairIterations.map((iteration) => <RepairIterationCard key={iteration} runId={activeRunId} iteration={iteration} slices={slices} />) : <EmptyState title="No repair work started" description="The workflow skips this loop when the initial reviewer reaches exact parity." />}
                <Panel title="Live agent activity">
                  <NodeChatStream runId={activeRunId} nodeId={activeAgentNode} title={selectedAgent.title} subtitle={selectedAgent.subtitle} status={selectedAgentStatus} height={360} />
                </Panel>
                <Panel title="Selected repair output">
                  <NodeOutputView runId={activeRunId} nodeId={selectedNodeId} iteration={selectedNodeIteration} />
                </Panel>
              </div>
            </TabsContent>

            <TabsContent value="checks">
              <div style={{ display: "grid", gap: 12 }}>
                <Panel title="Focused and browser checks" description="Skipped and unavailable checks fail the workflow; browser evidence must cover behavior and persistence.">
                  <RecordTable
                    rows={checkRows}
                    columns={[
                      { key: "phase", label: "Phase" },
                      { key: "name", label: "Check", render: (row) => <Value value={row.name ?? row.checkId} /> },
                      { key: "exitCode", label: "Exit code" },
                      { key: "skipped", label: "Skipped" },
                      { key: "passed", label: "Status", render: (row) => <UiStatusPill status={statusFor(row)} /> },
                      { key: "artifact", label: "Artifact", render: (row) => <ArtifactRef value={row.artifact ?? row.evidence} /> },
                    ]}
                    empty="Checks appear after their matching validation stage completes."
                  />
                </Panel>
                <Panel title="Selected node output">
                  <NodeOutputView runId={activeRunId} nodeId={selectedNodeId} iteration={selectedNodeIteration} />
                </Panel>
                <Panel title="Final-proof output card">
                  <NodeOutputCard runId={activeRunId} nodeId="final_proof" title="Final proof" summary="Typed parity proof">
                    {(row) => <code style={{ whiteSpace: "pre-wrap" }}>{compact(row, "No final proof yet.")}</code>}
                  </NodeOutputCard>
                </Panel>
              </div>
            </TabsContent>

            <TabsContent value="proof">
              <div style={{ display: "grid", gap: 12 }}>
                <Panel title="Final verdict and artifacts" description="Pass requires complete coverage, exact stable regions, zero visible differences, passing checks, and intact guards.">
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
                    <KpiStat label="Status" value={text(finalProof.status ?? enforceResult.status, "pending")} hint="enforced result" />
                    <KpiStat label="Coverage" value={hasFinalReview ? bool(finalReview.coverageComplete) ? "complete" : "incomplete" : "pending"} hint="full matrix" />
                    <KpiStat label="Stable changed pixels" value={finalStablePixels} hint="must be zero" />
                    <KpiStat label="Visible differences" value={finalVisibleDifferences} hint="must be zero" />
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <RecordTable
                      rows={records(finalProof.resolvedInventory)}
                      columns={[
                        { key: "differenceId", label: "Difference" },
                        { key: "iteration", label: "Iteration" },
                        { key: "owner", label: "Owner" },
                        { key: "status", label: "Status", render: (row) => <UiStatusPill status={text(row.status)} /> },
                      ]}
                      empty="No resolved inventory has been recorded yet."
                    />
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <RecordTable
                      rows={records(finalProof.remainingDifferences)}
                      columns={[
                        { key: "differenceId", label: "Difference" },
                        { key: "entryId", label: "Entry" },
                        { key: "category", label: "Category" },
                        { key: "region", label: "Region" },
                        { key: "evidence", label: "Evidence" },
                      ]}
                      empty="No remaining differences have been recorded."
                    />
                  </div>
                </Panel>
                <Panel title="Guards, documentation, and artifacts">
                  {hasRow(finalProof) ? <RecordTable
                    rows={[{
                      uiPlaygroundUnchanged: rowOf(finalProof.guardStatus).uiPlaygroundUnchanged,
                      userChangesPreserved: rowOf(finalProof.guardStatus).userChangesPreserved,
                      docsAccurate: rowOf(finalProof.docsStatus).accurate,
                      docsFiles: rowOf(finalProof.docsStatus).changedFiles,
                      artifacts: finalProof.artifactLinks,
                    }]}
                    columns={[
                      { key: "uiPlaygroundUnchanged", label: "UI playground", render: (row) => <UiStatusPill status={booleanStatus(row.uiPlaygroundUnchanged)} /> },
                      { key: "userChangesPreserved", label: "User changes", render: (row) => <UiStatusPill status={booleanStatus(row.userChangesPreserved)} /> },
                      { key: "docsAccurate", label: "Docs", render: (row) => <UiStatusPill status={booleanStatus(row.docsAccurate)} /> },
                      { key: "docsFiles", label: "Docs files" },
                      { key: "artifacts", label: "Artifacts" },
                    ]}
                  /> : <EmptyState title="Final guard records pending" description="The final proof task has not returned a guard record." />}
                </Panel>
                {auditApprovalRequired ? <Panel title="Approval required"><ApprovalPanel filter={{ workflow: WORKFLOW_KEY, runId: activeRunId ?? "" }} /><p>{text(approval.reason)} {text(approval.consequence)}</p></Panel> : null}
                <Panel title="Enforcement record">
                  <NodeOutputView runId={activeRunId} nodeId="enforce_result" iteration={0} />
                </Panel>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </WorkflowUiShell>
    </>
  );
}

createGatewayReactRoot(<App />);

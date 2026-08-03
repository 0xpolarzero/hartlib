/** @jsxImportSource react */
import { useMemo, useState, type ReactNode } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayApprovals,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRunTree,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import {
  ApprovalPanel,
  ConnectionBadge,
  NodeOutputView,
  RunEventLog,
  RunTree,
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
  KpiStat,
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
} from "smithers-orchestrator/ui";

const WORKFLOW_KEY = "implement-chat-reset";
const COMMANDS = ["bun run check", "bun run lint", "bun run test", "bun run e2e"];

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("[") && !text.startsWith("{")) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function rowOf(value: unknown): Row {
  let current: Row = isRecord(value) ? value : {};
  for (let i = 0; i < 3; i += 1) {
    if (isRecord(current.row)) current = current.row;
    else if (isRecord(current.data)) current = current.data;
    else break;
  }
  const result: Row = {};
  for (const [key, entry] of Object.entries(current)) {
    result[key] = parseJson(entry);
    const camel = key.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
    result[camel] = parseJson(entry);
  }
  return result;
}

function arrayOf(value: unknown): unknown[] {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed)) {
    const nested = parsed.runs ?? parsed.items ?? parsed.rows;
    return Array.isArray(nested) ? nested : [];
  }
  return [];
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;
}

function outputRow(value: unknown): Row {
  const row = rowOf(value);
  return isRecord(row.row) ? rowOf(row.row) : row;
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function JsonTable({ rows, columns }: { rows: Row[]; columns: string[] }) {
  return (
    <Table>
      <TableHeader><TableRow>{columns.map((column) => <TableHead key={column}>{column}</TableHead>)}</TableRow></TableHeader>
      <TableBody>
        {rows.length === 0 ? <TableRow><TableCell colSpan={columns.length}>No recorded output yet.</TableCell></TableRow> : rows.map((row, index) => (
          <TableRow key={`${index}-${text(row.path, "row")}`}>
            {columns.map((column) => <TableCell key={column}><code>{typeof row[column] === "string" ? row[column] as string : JSON.stringify(row[column] ?? "")}</code></TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function runIdFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("runId") ?? undefined;
}

function App() {
  const runsQuery = useGatewayRuns({ filter: { workflow: WORKFLOW_KEY, limit: 30 } });
  const runs = useMemo(() => arrayOf(runsQuery.data).filter(isRecord), [runsQuery.data]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const activeRunId = selectedRunId ?? (text(runs[0]?.runId ?? runs[0]?.id) || undefined);
  const actions = useGatewayActions();
  const [cancelling, setCancelling] = useState(false);
  const runQuery = useGatewayRun(activeRunId);
  const runTree = useGatewayRunTree(activeRunId);
  const eventStream = useGatewayRunEvents(activeRunId, { maxEvents: 500 });
  const approvals = useGatewayApprovals({ filter: { workflow: WORKFLOW_KEY, runId: activeRunId ?? "", limit: 20 } });

  const planOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "plan", iteration: 0 });
  const aggregateOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "aggregate-implementation", iteration: 0 });
  const testsOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "implement-focused-tests", iteration: 0 });
  const validateInitialOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "validate-initial", iteration: 0 });
  const validateRepair0 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "validate-after-repair", iteration: 0 });
  const validateRepair1 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "validate-after-repair", iteration: 1 });
  const validateRepair2 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "validate-after-repair", iteration: 2 });
  const reviewInitialOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "review-initial", iteration: 0 });
  const reviewFollowup0 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "review-followup", iteration: 0 });
  const reviewFollowup1 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "review-followup", iteration: 1 });
  const reviewFollowup2 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "review-followup", iteration: 2 });
  const reviewRepairOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "repair-review", iteration: 0 });
  const postReviewValidation = useGatewayNodeOutput({ runId: activeRunId, nodeId: "validate-after-review-repair", iteration: 0 });
  const postReviewRepair0 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "validate-review-repair-recheck", iteration: 0 });
  const postReviewRepair1 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "validate-review-repair-recheck", iteration: 1 });
  const postReviewRepair2 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "validate-review-repair-recheck", iteration: 2 });
  const protectedOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "protected-state-check", iteration: 0 });
  const readinessOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "readiness-check", iteration: 0 });
  const finalOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "final-report", iteration: 0 });

  const run = rowOf(runQuery.data);
  const runStatus = text(run.status, "pending");
  const plan = outputRow(planOut.data);
  const foundation = arrayOf(plan.foundationEvidence).filter(isRecord);
  const baseline = arrayOf(plan.protectedBaseline).filter(isRecord);
  const validations = [validateInitialOut.data, validateRepair0.data, validateRepair1.data, validateRepair2.data, postReviewValidation.data, postReviewRepair0.data, postReviewRepair1.data, postReviewRepair2.data].map(outputRow).filter((row) => Object.keys(row).length > 0);
  const reviews = [reviewInitialOut.data, reviewFollowup0.data, reviewFollowup1.data, reviewFollowup2.data].map(outputRow).filter((row) => Object.keys(row).length > 0);
  const changed = [aggregateOut.data, testsOut.data, reviewRepairOut.data, protectedOut.data].map(outputRow).filter((row) => Object.keys(row).length > 0);
  const protectedState = outputRow(protectedOut.data);
  const readiness = outputRow(readinessOut.data);
  const final = outputRow(finalOut.data);
  const latestValidation = validations.at(-1) ?? {};
  const commandRows = useMemo(() => {
    const found = new Map<string, Row>();
    for (const validation of validations) {
      for (const command of arrayOf(validation.commandResults).filter(isRecord)) found.set(text(command.command), command);
    }
    return COMMANDS.map((command) => ({ command, ...(found.get(command) ?? {}) }));
  }, [validations]);
  const repairCounts = {
    validation: [validateRepair0.data, validateRepair1.data, validateRepair2.data].filter(Boolean).length,
    review: reviewRepairOut.data ? 1 : 0,
    postReviewValidation: [postReviewRepair0.data, postReviewRepair1.data, postReviewRepair2.data].filter(Boolean).length,
  };

  async function cancel() {
    if (!activeRunId) return;
    setCancelling(true);
    try { await actions.cancelRun({ runId: activeRunId }); } finally { setCancelling(false); }
  }

  return (
    <>
      <SmithersUiStyles />
      <WorkflowUiShell
        title="Implement chat reset"
        testId="implement-chat-reset-ui"
        meta={<><GatewayStatusPill status={runStatus} /><Badge variant="outline">{runs.length} runs</Badge></>}
        actions={<><ConnectionBadge /><Button variant="destructive" disabled={!activeRunId || cancelling} onClick={() => void cancel()}>{cancelling ? "Cancelling…" : "Cancel"}</Button></>}
      >
        <div style={{ display: "grid", gap: 12 }}>
          <Card>
            <CardContent>
              <label htmlFor="run-select">Run</label>{" "}
              <select id="run-select" value={activeRunId ?? ""} onChange={(event) => setSelectedRunId(event.currentTarget.value || undefined)}>
                <option value="">Select a run</option>
                {runs.map((runRow) => { const id = text(runRow.runId ?? runRow.id); return <option key={id} value={id}>{id.slice(0, 12)} · {text(runRow.status, "unknown")}</option>; })}
              </select>
            </CardContent>
          </Card>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10 }}>
            <KpiStat label="Run status" value={runStatus} hint={activeRunId ?? "No run selected"} />
            <KpiStat label="Live events" value={eventStream.events.length} hint={eventStream.streaming ? "streaming" : "idle"} />
            <KpiStat label="Validation repairs" value={repairCounts.validation} hint="bounded iterations" />
            <KpiStat label="Review repairs" value={repairCounts.review} hint="independent findings" />
            <KpiStat label="Pending approvals" value={Array.isArray(approvals.data) ? approvals.data.length : 0} hint="human requests use Gateway state" />
          </div>

          <Panel title="Stage graph and routing">
            <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 1fr) minmax(240px, 1fr)", gap: 12 }}>
              <RunTree runId={activeRunId} style={{ minHeight: 240 }} />
              <div><RunEventLog runId={activeRunId} maxEvents={120} style={{ maxHeight: 300 }} /><Table><TableBody>
                {["plan · Sol", "review-initial/followup · Sol", "implementation · Luna", "validation and repair · Luna", "final-report · Luna"].map((route) => <TableRow key={route}><TableCell>{route}</TableCell></TableRow>)}
              </TableBody></Table></div>
            </div>
            <div style={{ marginTop: 10 }}><small>{runTree.root ? "Node tree connected." : "Node tree is waiting for a run."}</small></div>
          </Panel>

          <Tabs defaultValue="foundation">
            <TabsList>
              <TabsTrigger value="foundation" count={foundation.length}>Foundation</TabsTrigger>
              <TabsTrigger value="changes" count={changed.length}>Changes</TabsTrigger>
              <TabsTrigger value="commands" count={commandRows.length}>Commands</TabsTrigger>
              <TabsTrigger value="reviews" count={reviews.length}>Reviews</TabsTrigger>
              <TabsTrigger value="protected">Protected state</TabsTrigger>
            </TabsList>
            <TabsContent value="foundation">
              <Panel title="Foundation evidence"><JsonTable rows={foundation} columns={["area", "status", "evidence"]} /><JsonTable rows={baseline} columns={["path", "gitStatus", "worktreeHash", "indexHash", "diffHash"]} /></Panel>
            </TabsContent>
            <TabsContent value="changes">
              <Panel title="Changed files and diff"><JsonTable rows={changed} columns={["summary", "changedFiles", "acceptanceEvidence", "coverage"]} /><NodeOutputView runId={activeRunId} nodeId="protected-state-check" iteration={0} /></Panel>
            </TabsContent>
            <TabsContent value="commands">
              <Panel title="Four-command validation history"><JsonTable rows={commandRows} columns={["command", "status", "exitCode", "output"]} /><NodeOutputView runId={activeRunId} nodeId={latestValidation.nodeId ? text(latestValidation.nodeId) : "validate-initial"} iteration={0} /></Panel>
            </TabsContent>
            <TabsContent value="reviews">
              <Panel title="Independent review findings"><JsonTable rows={reviews} columns={["nodeId", "approved", "findings", "acceptanceCoverage"]} /><NodeOutputView runId={activeRunId} nodeId="review-followup" iteration={2} /></Panel>
            </TabsContent>
            <TabsContent value="protected">
              <Panel title="Protected-file status"><GatewayStatusPill status={protectedState.protectedFilesClean === true ? "passed" : "failed"} /><UiStatusPill status={readiness.ready === true ? "passed" : "blocked"} /><JsonTable rows={arrayOf(protectedState.violations).filter(isRecord)} columns={["path", "expectedFingerprint", "actualFingerprint"]} /><JsonTable rows={arrayOf(protectedState.forbiddenArtifacts).filter(isRecord)} columns={["path", "line"]} /></Panel>
            </TabsContent>
          </Tabs>

          <Panel title="Human requests"><ApprovalPanel filter={{ workflow: WORKFLOW_KEY, runId: activeRunId ?? "" }} /><small>Exceptional durable questions are surfaced by the Gateway approval and human-request state.</small></Panel>
          <Panel title="Final readiness"><GatewayStatusPill status={readiness.ready === true ? "passed" : "blocked"} /><JsonTable rows={[final]} columns={["summary", "finalStatus", "blocker", "changedFiles", "repairCounts", "protectedFilesClean"]} /><NodeOutputView runId={activeRunId} nodeId="final-report" iteration={0} /></Panel>
        </div>
      </WorkflowUiShell>
    </>
  );
}

createGatewayReactRoot(<App />);

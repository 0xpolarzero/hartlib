/** @jsxImportSource react */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayApprovals,
  useGatewayNodeEvents,
  useGatewayNodeOutput,
  useGatewayRpc,
  useGatewayRun,
  useGatewayRunDiff,
  useGatewayRunEvents,
  useGatewayRunTree,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import {
  ApprovalPanel,
  buildNodeChatTranscript,
  FleetTable,
  NodeChatStream,
  NodeOutputCard,
  NodeStageStrip,
  RunEventLog,
  RunMeta,
  RunTree,
  WorkflowGraph,
  WorkflowUiShell,
} from "smithers-orchestrator/gateway-ui";
import {
  Artifact,
  ArtifactContent,
  ArtifactHeader,
  ArtifactDescription,
  ArtifactTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DiffHunks,
  EmptyState,
  KpiStat,
  parseUnifiedFile,
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
  TestResults,
} from "smithers-orchestrator/ui";

import {
  nodeStatusIndex,
  rollupNodeStatus,
  unwrapNodeOutput,
} from "smithers-orchestrator/gateway-ui";

const WORKFLOW_KEY = "implement-ui-playground-demo-cutover";

type Row = Record<string, unknown>;

type TreeNode = {
  id: string;
  key?: string;
  name?: string;
  kind?: string;
  status?: string;
  output?: string;
  iteration?: number;
  attempt?: number;
  agent?: unknown;
};

type MaterializedNode = TreeNode & {
  /** The id carried by a materialized Gateway row, including a loop qualifier. */
  requestId: string;
  /** The logical id accepted by the shipped output hook. */
  outputId: string;
  /** The display id used by this dashboard's registry. */
  logicalId: string;
};

type GatewayDisplayStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "waiting"
  | "cancelled";

const TASK_REGISTRY = [
  ["initialize_run", "compute"],
  ["assert_preflight_ready", "compute"],
  ["audit_repository_and_plan", "agent"],
  ["freeze_contracts", "agent"],
  ["plan_integration_waves", "agent"],
  ["persist_frozen_baseline", "compute"],
  ["author_cutover_dashboard", "agent"],
  ["review_cutover_dashboard", "agent"],
  ["repair_cutover_dashboard", "agent"],
  ["recheck_cutover_dashboard", "agent"],
  ["select_and_assign_wave", "agent"],
  ["implement_wave_lane_a", "agent"],
  ["implement_wave_lane_b", "agent"],
  ["implement_wave_lane_c", "agent"],
  ["review_wave_contract_compliance", "agent"],
  ["repair_wave_contract_findings", "agent"],
  ["integrate_wave", "agent"],
  ["run_wave_checks", "compute"],
  ["repair_wave_failures", "agent"],
  ["rerun_wave_checks", "compute"],
  ["checkpoint_wave", "compute"],
  ["cleanup_obsolete_surface", "agent"],
  ["verify_retention_cleanup", "compute"],
  ["repair_retention_cleanup", "agent"],
  ["reverify_retention_cleanup", "compute"],
  ["sync_canonical_docs", "agent"],
  ["review_docs_sync", "agent"],
  ["repair_docs_sync", "agent"],
  ["recheck_docs_sync", "agent"],
  ["checkpoint_cleanup_and_docs", "compute"],
  ["prepare_verification_matrix", "agent"],
  ["review_verification_manifest", "agent"],
  ["repair_verification_manifest", "agent"],
  ["recheck_verification_manifest", "agent"],
  ["check_migration_0074", "compute"],
  ["check_unit_tests", "compute"],
  ["check_integration_tests", "compute"],
  ["check_builds", "compute"],
  ["check_deterministic_playwright", "compute"],
  ["check_visual_breakpoints", "compute"],
  ["check_accessibility", "compute"],
  ["check_live_retrieval", "compute"],
  ["check_live_stop", "compute"],
  ["check_live_reset_during_run", "compute"],
  ["check_reachability_and_bundle", "compute"],
  ["check_callers_and_capabilities", "compute"],
  ["check_reference_integrity", "compute"],
  ["check_lint", "compute"],
  ["check_root", "compute"],
  ["aggregate_verification_matrix", "compute"],
  ["classify_verification_failures", "compute"],
  ["repair_verification_failures", "agent"],
  ["checkpoint_verification", "compute"],
  ["independent_final_review", "agent"],
  ["remediate_review_findings", "agent"],
  ["run_affected_regressions", "compute"],
  ["repair_review_regression_failures", "agent"],
  ["rerun_affected_regressions", "compute"],
  ["checkpoint_review", "compute"],
  ["assert_stable_review_and_verification", "compute"],
  ["final_readiness_gate", "compute"],
  ["capture_approval_record", "compute"],
  ["validate_final_result", "compute"],
] as const;

const STAGE_IDS = [
  "initialize_run",
  "assert_preflight_ready",
  "freeze_contracts",
  "plan_integration_waves",
  "checkpoint_wave",
  "checkpoint_verification",
  "checkpoint_review",
  "assert_stable_review_and_verification",
  "final_readiness_gate",
  "validate_final_result",
];
const CHECK_NODE_IDS = [
  "check_migration_0074",
  "check_unit_tests",
  "check_integration_tests",
  "check_builds",
  "check_deterministic_playwright",
  "check_visual_breakpoints",
  "check_accessibility",
  "check_live_retrieval",
  "check_live_stop",
  "check_live_reset_during_run",
  "check_reachability_and_bundle",
  "check_callers_and_capabilities",
  "check_reference_integrity",
  "check_lint",
  "check_root",
];
const CHECK_RESULT_NODE_IDS = [
  "check_migration_0074",
  "check_live_retrieval",
  "check_live_stop",
  "check_live_reset_during_run",
  "check_visual_breakpoints",
  "aggregate_verification_matrix",
] as const;
const RETENTION_SOURCE_NODE_IDS = [
  "integrate_wave",
  "cleanup_obsolete_surface",
  "verify_retention_cleanup",
  "reverify_retention_cleanup",
] as const;
const VISUAL_WIDTHS = [320, 390, 1024, 1535, 1536, 1920] as const;
const OUTPUT_NODE_IDS = [
  "initialize_run",
  "assert_preflight_ready",
  "audit_repository_and_plan",
  "freeze_contracts",
  "plan_integration_waves",
  "persist_frozen_baseline",
  "author_cutover_dashboard",
  "review_cutover_dashboard",
  "repair_cutover_dashboard",
  "recheck_cutover_dashboard",
  "select_and_assign_wave",
  "implement_wave_lane_a",
  "implement_wave_lane_b",
  "implement_wave_lane_c",
  "review_wave_contract_compliance",
  "repair_wave_contract_findings",
  "integrate_wave",
  "run_wave_checks",
  "repair_wave_failures",
  "rerun_wave_checks",
  "checkpoint_wave",
  "cleanup_obsolete_surface",
  "verify_retention_cleanup",
  "repair_retention_cleanup",
  "reverify_retention_cleanup",
  "sync_canonical_docs",
  "review_docs_sync",
  "repair_docs_sync",
  "recheck_docs_sync",
  "checkpoint_cleanup_and_docs",
  "prepare_verification_matrix",
  "review_verification_manifest",
  "repair_verification_manifest",
  "recheck_verification_manifest",
  ...CHECK_NODE_IDS,
  "aggregate_verification_matrix",
  "classify_verification_failures",
  "repair_verification_failures",
  "checkpoint_verification",
  "emit_preflight_blocked_result",
  "emit_readiness_failed_result",
  "final_parity_approval",
  "independent_final_review",
  "remediate_review_findings",
  "run_affected_regressions",
  "repair_review_regression_failures",
  "rerun_affected_regressions",
  "checkpoint_review",
  "assert_stable_review_and_verification",
  "final_readiness_gate",
  "capture_approval_record",
  "validate_final_result",
] as const;

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!(text.startsWith("{") || text.startsWith("["))) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function outputState(value: unknown): "pending" | "produced" | "failed" {
  if (value == null) return "pending";
  try {
    const parsed = parseMaybeJson(value);
    // Gateway envelopes are objects. Keep malformed serialized objects and
    // empty strings out of the produced bucket instead of letting the shared
    // bare-row fallback turn bad transport data into a false pass.
    if (typeof value === "string") {
      const raw = value.trim();
      if (!raw) return "pending";
      if ((raw.startsWith("{") || raw.startsWith("[")) && parsed === value) return "pending";
    }
    if (Array.isArray(parsed) || (typeof parsed !== "string" && !isRecord(parsed)))
      return "pending";
    if (isRecord(parsed) && "status" in parsed) {
      const status = text(parsed.status).toLowerCase();
      if (status === "pending") return "pending";
      if (status === "skipped" || status === "cancelled" || status === "canceled") return "pending";
      if (["failed", "failure", "error", "errored"].includes(status)) return "failed";
      if (status === "produced") {
        if (!("row" in parsed) || parsed.row == null) return "pending";
        const rowStatus = explicitOutcomeStatus(parsed.row);
        if (rowStatus === "failed") return "failed";
        if (rowStatus === "skipped" || rowStatus === "waiting") return "pending";
        return "produced";
      }
      // An unknown status with envelope-only fields is malformed, not proof
      // that the node produced a result.
      if ("row" in parsed || "schema" in parsed || "error" in parsed) return "pending";
    }
    const envelope = unwrapNodeOutput(parsed);
    if (envelope.status === "failed") return "failed";
    if (envelope.status === "pending") return "pending";
    return envelope.status === "produced" ? "produced" : "pending";
  } catch {
    return "pending";
  }
}

function treeNodeKey(node: TreeNode): string {
  return text(node.key ?? node.id);
}

function withoutLoopQualifier(value: string): string {
  const separator = value.indexOf("@@");
  return separator >= 0 ? value.slice(0, separator) : value;
}

function embeddedNodeId(node: TreeNode): string {
  const id = text(node.id);
  if (id.includes("@@")) return id;
  const key = text(node.key);
  if (key.startsWith(`${id}@@`)) {
    const lastSeparator = key.lastIndexOf(":");
    const trailingIteration = key.slice(lastSeparator + 1);
    return lastSeparator > id.length && /^\d+$/.test(trailingIteration)
      ? key.slice(0, lastSeparator)
      : key;
  }
  const firstSeparator = key.indexOf(":");
  const lastSeparator = key.lastIndexOf(":");
  if (firstSeparator >= 0 && lastSeparator > firstSeparator) {
    const embeddedId = key.slice(firstSeparator + 1, lastSeparator);
    const trailingIteration = key.slice(lastSeparator + 1);
    if (embeddedId && /^\d+$/.test(trailingIteration)) return embeddedId;
  }
  return id || key;
}

function nodeLogicalId(node: TreeNode): string {
  return withoutLoopQualifier(embeddedNodeId(node));
}

function nodeRequestId(node: TreeNode): string {
  // Snapshot rows expose the physical loop id directly. Electric rows keep
  // that same id in the middle of a structural key such as
  // `run-id:check_migration_0074@@automation_review_stabilization=0:0`.
  // Keep this physical id for durable Gateway lookups.
  return embeddedNodeId(node);
}

function nodeOutputId(node: TreeNode): string {
  // Output hooks speak the logical task id plus the materialized iteration.
  // Resolve that id from the selected row rather than asking for a display id
  // that may not exist in this run.
  return nodeLogicalId(node) || nodeRequestId(node);
}

function gatewayEventId(value: string | undefined): string | undefined {
  const candidate = withoutLoopQualifier((value ?? "").trim());
  return /^[a-zA-Z0-9:_.-]{1,160}$/.test(candidate) ? candidate : undefined;
}

function nodeCanRequestOutput(node: MaterializedNode): boolean {
  const status = displayStatus(node.status);
  const inlineOutput = text(node.output).trim();
  if (status === "failed") return false;
  // Qualified loop ids are materialized run records, not valid standalone
  // output-route ids in every Gateway deployment. Without an inline envelope,
  // keep the card pending until the record exposes a requestable output.
  if (nodeRequestId(node).includes("@@") && !inlineOutput) return false;
  if (status === "passed") return true;
  return Boolean(inlineOutput) && outputState(inlineOutput) !== "pending";
}

function usePendingOutputOnError(
  params: Parameters<typeof useGatewayNodeOutput>[0],
): ReturnType<typeof useGatewayNodeOutput> {
  const result = useGatewayNodeOutput(params);
  const malformedOrPending = result.data !== undefined && outputState(result.data) === "pending";
  if (!result.error && !malformedOrPending && explicitOutcomeStatus(result.data) === "failed") {
    return {
      ...result,
      data: { status: "failed", row: null },
      loading: false,
    };
  }
  if (!result.error && !malformedOrPending) return result;
  return {
    ...result,
    data: { status: "pending", row: null },
    error: undefined,
    loading: false,
  };
}

function useStoredFailureOutput(
  params: Parameters<typeof useGatewayNodeOutput>[0],
): ReturnType<typeof useGatewayNodeOutput> {
  const result = useGatewayNodeOutput(params);
  if (!result.error && result.data !== undefined && outputState(result.data) !== "pending")
    return result;
  return {
    ...result,
    data: { status: "failed", row: null },
    error: undefined,
    loading: false,
  };
}

function normalizedDisplayStatus(value: unknown): GatewayDisplayStatus | undefined {
  const status = text(value).toLowerCase();
  if (status === "skipped") return "skipped";
  if (["failed", "failure", "error", "errored"].includes(status)) return "failed";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  if (["running", "in-progress", "in_progress"].includes(status)) return "running";
  if (["waiting", "waiting-approval", "waiting-event", "waiting-timer", "blocked"].includes(status))
    return "waiting";
  if (["ok", "passed", "pass", "succeeded", "finished", "completed"].includes(status))
    return "passed";
  if (["pending", "queued", "todo", "unknown"].includes(status)) return "pending";
  return undefined;
}

function displayStatus(value: unknown): GatewayDisplayStatus {
  return normalizedDisplayStatus(value) ?? "pending";
}

function materializedStatusValue(value: unknown): string {
  const status = displayStatus(value);
  return status === "passed" ? "ok" : status;
}

function materializedStatus(
  node: MaterializedNode,
  statuses: ReadonlyMap<string, string>,
  skipped: ReadonlySet<string>,
): string {
  if (
    text(node.status).toLowerCase() === "skipped" ||
    [...skipped].some(
      (id) =>
        nodeMatches(node.requestId, id) ||
        nodeMatches(node.outputId, id) ||
        nodeMatches(node.logicalId, id),
    )
  )
    return "skipped";
  const direct = normalizedDisplayStatus(node.status);
  if (direct !== undefined) return direct === "passed" ? "ok" : direct;
  const exact = statuses.get(node.requestId) ?? statuses.get(node.outputId);
  if (exact !== undefined) return materializedStatusValue(exact);
  return rollupNodeStatus(statuses, [node.requestId, node.outputId, node.logicalId]);
}

function materializedNodeFor(
  logicalId: string | undefined,
  nodes: ReadonlyArray<TreeNode>,
): MaterializedNode | undefined {
  if (!logicalId) return undefined;
  const candidates = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => {
      const id = text(node.id);
      const key = treeNodeKey(node);
      const requestId = nodeRequestId(node);
      const logicalNodeId = nodeLogicalId(node);
      return (
        id === logicalId ||
        key === logicalId ||
        requestId === logicalId ||
        logicalNodeId === logicalId ||
        id.startsWith(`${logicalId}@@`) ||
        key.startsWith(`${logicalId}@@`) ||
        requestId.startsWith(`${logicalId}@@`) ||
        logicalNodeId.startsWith(`${logicalId}@@`)
      );
    })
    .sort((left, right) => {
      const leftIteration = Number.isFinite(left.node.iteration) ? Number(left.node.iteration) : -1;
      const rightIteration = Number.isFinite(right.node.iteration)
        ? Number(right.node.iteration)
        : -1;
      if (leftIteration !== rightIteration) return leftIteration - rightIteration;
      const leftAttempt = Number.isFinite(left.node.attempt) ? Number(left.node.attempt) : -1;
      const rightAttempt = Number.isFinite(right.node.attempt) ? Number(right.node.attempt) : -1;
      if (leftAttempt !== rightAttempt) return leftAttempt - rightAttempt;
      const leftQualified = nodeRequestId(left.node).includes("@@") ? 1 : 0;
      const rightQualified = nodeRequestId(right.node).includes("@@") ? 1 : 0;
      if (leftQualified !== rightQualified) return leftQualified - rightQualified;
      return left.index - right.index;
    });
  const selected = candidates.at(-1)?.node;
  return selected
    ? {
        ...selected,
        requestId: nodeRequestId(selected),
        outputId: nodeOutputId(selected),
        logicalId: nodeLogicalId(selected),
      }
    : undefined;
}

function nodeMatches(nodeId: string | undefined, candidate: unknown): boolean {
  if (!nodeId || typeof candidate !== "string") return false;
  const baseNodeId = withoutLoopQualifier(nodeId);
  const baseCandidate = withoutLoopQualifier(candidate);
  const nodeIsQualified = nodeId.includes("@@");
  const candidateIsQualified = candidate.includes("@@");
  return (
    candidate === nodeId ||
    candidate.startsWith(`${nodeId}@@`) ||
    nodeId.startsWith(`${candidate}@@`) ||
    ((!nodeIsQualified || !candidateIsQualified) && baseCandidate === baseNodeId)
  );
}

function eventPayload(value: unknown): Row {
  const parsed = parseMaybeJson(value);
  return isRecord(parsed) ? parsed : {};
}

function eventNodeIds(frame: { event?: unknown; payload?: unknown }): string[] {
  const payload = eventPayload(frame.payload);
  const trigger = isRecord(payload.trigger) ? payload.trigger : {};
  const correlation = isRecord(payload.correlation) ? payload.correlation : {};
  return [
    payload.nodeId,
    payload.node_id,
    payload.key,
    payload.nodeKey,
    payload.node_key,
    trigger.nodeId,
    trigger.node_id,
    correlation.nodeId,
    correlation.node_id,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

type ChatEvent = { event: string; payload?: unknown; seq: number };

function storedText(value: unknown): string | undefined {
  const parsed = parseMaybeJson(value);
  if (typeof parsed === "string") return parsed.trim() || undefined;
  if (Array.isArray(parsed)) {
    const parts = parsed
      .map((part) => {
        if (!isRecord(part)) return text(part);
        return firstText(part.text, part.output_text, part.input_text, part.content, part.value);
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const direct = firstText(
    parsed.text,
    parsed.message,
    parsed.output,
    parsed.answer,
    parsed.content,
  );
  if (direct) return direct;
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function storedTranscriptFrames(events: ReadonlyArray<ChatEvent>): ChatEvent[] {
  const normalized: ChatEvent[] = [];
  for (const frame of events) {
    if (frame.event !== "AgentSessionEvent") {
      normalized.push(frame);
      continue;
    }
    const payload = eventPayload(frame.payload);
    const transcriptValue = parseMaybeJson(payload.transcript);
    const transcript = isRecord(transcriptValue) ? transcriptValue : {};
    const nodeId = firstText(
      payload.nodeId,
      payload.node_id,
      transcript.nodeId,
      transcript.node_id,
    );
    if (!nodeId) continue;
    const source = isRecord(transcript.source) ? transcript.source : {};
    const raw = parseMaybeJson(transcript.raw);
    const rawRecord = isRecord(raw) ? raw : {};
    const rawPayload = parseMaybeJson(rawRecord.payload);
    const item = isRecord(rawPayload) ? rawPayload : {};
    const iteration = numberValue(payload.iteration, transcript.iteration) ?? 0;
    const attempt = numberValue(payload.attempt, transcript.attempt) ?? 1;
    const engine = firstText(source.engine, source.agentFamily, payload.engine);
    const base = {
      nodeId,
      iteration,
      attempt,
      ...(engine ? { engine } : {}),
    };
    if (typeof raw === "string" || Array.isArray(raw)) {
      const message = storedText(raw);
      if (message)
        normalized.push({
          event: "NodeOutput",
          payload: { ...base, text: message },
          seq: frame.seq,
        });
      continue;
    }
    if (rawRecord.type === "event_msg") {
      if (item.type === "agent_message") {
        const message = storedText(item.message);
        if (message)
          normalized.push({
            event: "NodeOutput",
            payload: { ...base, text: message },
            seq: frame.seq,
          });
      }
      continue;
    }
    if (rawRecord.type !== "response_item") continue;
    if (item.type === "message" && item.role === "assistant") {
      const message = storedText(item.content);
      if (message)
        normalized.push({
          event: "NodeOutput",
          payload: { ...base, text: message },
          seq: frame.seq,
        });
      continue;
    }
    if (item.type === "agent_message") {
      const message = storedText(item.message ?? item.content ?? item.text);
      if (message)
        normalized.push({
          event: "NodeOutput",
          payload: { ...base, text: message },
          seq: frame.seq,
        });
      continue;
    }
    if (item.type === "custom_tool_call" || item.type === "tool_call") {
      const title = firstText(item.name, item.tool_name, item.toolName, "tool") ?? "tool";
      const actionId =
        firstText(item.call_id, item.callId, item.id, `${title}:${frame.seq}`) ?? title;
      normalized.push({
        event: "AgentEvent",
        payload: {
          ...base,
          event: {
            type: "action",
            phase: "started",
            action: {
              kind: "tool",
              id: actionId,
              title,
              detail: { input: item.input ?? item.arguments ?? item.args },
            },
          },
        },
        seq: frame.seq,
      });
      continue;
    }
    if (item.type === "custom_tool_call_output" || item.type === "tool_result") {
      const actionId =
        firstText(item.call_id, item.callId, item.id, `tool:${frame.seq}`) ?? `tool:${frame.seq}`;
      normalized.push({
        event: "AgentEvent",
        payload: {
          ...base,
          event: {
            type: "action",
            phase: "completed",
            action: {
              kind: "tool",
              id: actionId,
              title: firstText(item.name, item.tool_name, "tool") ?? "tool",
              detail: { output: item.output ?? item.result },
            },
          },
        },
        seq: frame.seq,
      });
      continue;
    }
    if (item.type === "reasoning") {
      const message = storedText(item.summary ?? item.text);
      if (message)
        normalized.push({
          event: "NodeOutput",
          payload: { ...base, text: message },
          seq: frame.seq,
        });
    }
  }
  return normalized;
}

function transcriptFramesForNode(
  events: ReadonlyArray<ChatEvent>,
  requestedIds: ReadonlyArray<string>,
  iteration?: number,
  attempt?: number,
): ChatEvent[] {
  return storedTranscriptFrames(events).filter((frame) => {
    const ids = eventNodeIds(frame);
    if (!ids.some((id) => requestedIds.some((requested) => nodeMatches(requested, id)))) {
      return false;
    }
    const payload = eventPayload(frame.payload);
    const frameIteration = numberValue(payload.iteration);
    const frameAttempt = numberValue(payload.attempt);
    return (
      (iteration === undefined || frameIteration === undefined || frameIteration === iteration) &&
      (attempt === undefined ||
        attempt === 0 ||
        frameAttempt === undefined ||
        frameAttempt === attempt)
    );
  });
}

function eventAliasesForNode(
  node: MaterializedNode,
  events: ReadonlyArray<{ event?: unknown; payload?: unknown }>,
): string[] {
  return [
    ...new Set(
      events
        .filter((frame) => {
          const payload = eventPayload(frame.payload);
          const iteration = numberValue(payload.iteration);
          const attempt = numberValue(payload.attempt);
          return (
            (node.iteration === undefined ||
              iteration === undefined ||
              iteration === node.iteration) &&
            (node.attempt === undefined ||
              node.attempt === 0 ||
              attempt === undefined ||
              attempt === node.attempt)
          );
        })
        .flatMap((frame) => eventNodeIds(frame))
        .filter(
          (id) =>
            nodeMatches(node.requestId, id) ||
            nodeMatches(node.outputId, id) ||
            nodeMatches(node.logicalId, id),
        ),
    ),
  ];
}

function materializedTreeNodes(
  nodes: ReadonlyArray<TreeNode>,
  events: ReadonlyArray<{ event?: unknown; payload?: unknown }>,
): TreeNode[] {
  return nodes.map((node) => {
    const materialized: MaterializedNode = {
      ...node,
      requestId: nodeRequestId(node),
      outputId: nodeOutputId(node),
      logicalId: nodeLogicalId(node),
    };
    const qualifiedAliases = eventAliasesForNode(materialized, events).filter((id) =>
      id.includes("@@"),
    );
    const qualifiedId = qualifiedAliases.at(-1);
    return qualifiedId && !nodeRequestId(node).includes("@@")
      ? { ...node, id: qualifiedId, key: `${treeNodeKey(node)}|${qualifiedId}` }
      : node;
  });
}

function skippedNodeIds(
  events: ReadonlyArray<{ event?: unknown; payload?: unknown }>,
): Set<string> {
  const skipped = new Set<string>();
  for (const frame of events) {
    const payload = eventPayload(frame.payload);
    const status = text(payload.status ?? payload.state).toLowerCase();
    if (frame.event === "NodeSkipped" || status === "skipped" || isTrue(payload.skipped)) {
      for (const id of eventNodeIds(frame)) skipped.add(id);
    }
  }
  return skipped;
}

function checkStatusForNode(
  logicalId: string,
  nodes: ReadonlyArray<TreeNode>,
  statuses: ReadonlyMap<string, string>,
  output: unknown,
  skipped: ReadonlySet<string>,
): GatewayDisplayStatus {
  const skippedByEvent = [...skipped].some((id) => nodeMatches(logicalId, id));
  const node = materializedNodeFor(logicalId, nodes);
  // A missing row means the branch has not materialized. Do not ask Gateway
  // for a base id: a 404 there is not a failed check.
  if (!node) return skippedByEvent ? "skipped" : "pending";

  const requestId = node.requestId;
  const outputId = node.outputId;
  const nodeSkippedByEvent = [...skipped].some(
    (id) => nodeMatches(requestId, id) || nodeMatches(outputId, id) || nodeMatches(logicalId, id),
  );
  const row = rowOf(output, true);
  const rowStatus = text(row.status).toLowerCase();
  if (
    nodeSkippedByEvent ||
    text(node.status).toLowerCase() === "skipped" ||
    isTrue(row.skipped) ||
    rowStatus === "skipped"
  )
    return "skipped";

  const envelopeOutcome = explicitOutcomeStatus(output);
  const rowOutcome = explicitOutcomeStatus(row);
  if (envelopeOutcome === "skipped" || rowOutcome === "skipped") return "skipped";
  if (envelopeOutcome === "failed" || rowOutcome === "failed") return "failed";
  if (envelopeOutcome === "cancelled" || rowOutcome === "cancelled") return "cancelled";

  const envelope = outputState(output);
  if (envelope === "failed" || ["failed", "failure", "error", "errored"].includes(rowStatus))
    return "failed";

  // The selected materialized row is authoritative. A logical-id rollup can
  // point at an older loop/retry attempt and turn a pending row into a false
  // failure, so only use the shared index as a fallback when the row has no
  // usable status of its own.
  const lifecycle =
    normalizedDisplayStatus(node.status) ??
    normalizedDisplayStatus(statuses.get(requestId)) ??
    normalizedDisplayStatus(statuses.get(outputId)) ??
    normalizedDisplayStatus(rollupNodeStatus(statuses, [requestId, outputId, logicalId]));
  if (envelope === "pending") {
    if (lifecycle === "failed") return "failed";
    if (lifecycle === "running") return "running";
    if (lifecycle === "waiting") return "waiting";
    if (lifecycle === "cancelled") return "cancelled";
    return "pending";
  }
  if (lifecycle === "failed") return "failed";
  if (lifecycle === "passed") return "passed";
  if (lifecycle === "running") return "running";
  if (lifecycle === "waiting") return "waiting";
  if (lifecycle === "cancelled") return "cancelled";
  // A produced envelope is durable success evidence even if the tree still
  // reports a queued lifecycle row.
  return "passed";
}

function explicitOutcomeStatus(value: unknown, depth = 0): GatewayDisplayStatus | undefined {
  const parsed = parseMaybeJson(value);
  if (isRecord(parsed)) {
    if (
      isTrue(parsed.skipped) ||
      text(parsed.status ?? parsed.state ?? parsed.runStatus).toLowerCase() === "skipped"
    )
      return "skipped";
    if (
      parsed.approved === false ||
      parsed.approved === 0 ||
      text(parsed.approved).toLowerCase() === "false"
    )
      return "failed";
    if (isTrue(parsed.approved)) return "passed";
    const status = text(
      parsed.runStatus ??
        parsed.status ??
        parsed.state ??
        parsed.outcome ??
        parsed.decision ??
        parsed.result,
    ).toLowerCase();
    if (
      ["failed", "failure", "error", "errored", "denied", "deny", "rejected", "declined"].includes(
        status,
      )
    )
      return "failed";
    if (
      [
        "passed",
        "pass",
        "ok",
        "succeeded",
        "finished",
        "completed",
        "approved",
        "accepted",
      ].includes(status)
    )
      return "passed";
    if (["running", "queued", "pending", "requested", "open"].includes(status)) return "waiting";
    if (["waiting", "waiting-approval", "waiting-event"].includes(status)) return "waiting";
    if (["cancelled", "canceled"].includes(status)) return "cancelled";
    if (depth < 2) {
      for (const nested of [
        parsed.decision,
        parsed.result,
        parsed.outcome,
        parsed.approval,
        parsed.approvalRecord,
        parsed.row,
      ]) {
        if (nested === value) continue;
        const nestedStatus = explicitOutcomeStatus(nested, depth + 1);
        if (nestedStatus) return nestedStatus;
      }
    }
  }
  return undefined;
}

function derivedConditionalStatus(
  nodeId: string,
  run: Row | undefined,
  approvalRows: ReadonlyArray<Row>,
): GatewayDisplayStatus {
  const runState = rowOf(run?.runState);
  const runEvidence =
    nodeId === "emit_preflight_blocked_result"
      ? [run?.preflightBlocked, run?.preflight_blocked]
      : nodeId === "emit_verification_blocked_result"
        ? [
            run?.verificationBlocked,
            run?.verification_blocked,
            run?.verificationBlockedResult,
            run?.verification_blocked_result,
            runState.verificationBlocked,
            runState.verification_blocked,
          ]
        : nodeId === "emit_readiness_failed_result"
          ? [
              run?.readinessFailure,
              run?.readiness_failure,
              run?.readinessFailed,
              run?.readiness_failed,
              runState.readinessFailure,
              runState.readiness_failure,
            ]
          : [];
  for (const evidence of runEvidence) {
    if (isTrue(evidence)) return "failed";
    const status = explicitOutcomeStatus(evidence);
    if (status) return status;
  }

  if (nodeId !== "emit_approval_denied_result") return "pending";
  const approvalEvidence = approvalRows.filter((row) => {
    const approvalNode = firstText(
      row.nodeId,
      row.node_id,
      row.taskId,
      row.task_id,
      row.approvalId,
      row.approval_id,
    );
    return (
      !approvalNode ||
      nodeMatches("final_parity_approval", approvalNode) ||
      nodeMatches(nodeId, approvalNode)
    );
  });
  const statuses = approvalEvidence
    .map((row) => explicitOutcomeStatus(row))
    .filter((status): status is GatewayDisplayStatus => Boolean(status));
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("skipped")) return "skipped";
  if (statuses.includes("passed")) return "passed";
  if (statuses.includes("waiting")) return "waiting";
  return "pending";
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = parseMaybeJson(value);
    if (typeof parsed === "number" && Number.isFinite(parsed)) return parsed;
    if (typeof parsed === "string" && parsed.trim() !== "" && Number.isFinite(Number(parsed))) {
      return Number(parsed);
    }
  }
  return undefined;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = text(value).trim();
    if (candidate) return candidate;
  }
  return undefined;
}

function agentMetadata(agent: unknown): {
  name?: string;
  engine?: string;
  model?: string;
  ranOn?: string;
  declaredName?: string;
  declaredEngine?: string;
  declaredModel?: string;
} {
  if (typeof agent === "string") {
    const parsed = parseMaybeJson(agent);
    if (isRecord(parsed)) return agentMetadata(parsed);
    return { name: agent };
  }
  if (!isRecord(agent)) return {};
  const declared = isRecord(agent.summary)
    ? agent.summary
    : isRecord(agent.declared)
      ? agent.declared
      : {};
  const ranOn = isRecord(agent.ranOn) ? agent.ranOn : {};
  const declaredName = firstText(agent.name, agent.label, declared.name, declared.label);
  const declaredEngine = firstText(agent.engine, declared.engine);
  const declaredModel = firstText(agent.model, declared.model);
  const ranOnAgentId = firstText(ranOn.agentId, ranOn.agent_id);
  const ranOnEngine = firstText(ranOn.engine);
  const ranOnModel = firstText(ranOn.model);
  const actualName = firstText(ranOnModel, ranOnEngine, ranOnAgentId);
  return {
    name: actualName ?? declaredName,
    engine: ranOnEngine ?? declaredEngine,
    model: ranOnModel ?? declaredModel,
    ranOn: firstText(ranOnModel, ranOnEngine, ranOnAgentId),
    declaredName,
    declaredEngine,
    declaredModel,
  };
}

function agentSubtitle(agent: unknown): string {
  const meta = agentMetadata(agent);
  const assignment = [...new Set([meta.name, meta.engine, meta.model].filter(Boolean))].join(" · ");
  const ranOn =
    meta.ranOn && meta.ranOn !== meta.name && meta.ranOn !== meta.model
      ? `ran on ${meta.ranOn}`
      : "";
  return [assignment || "Gateway agent", ranOn].filter(Boolean).join(" · ");
}

function materializedAgentKey(node: MaterializedNode): string {
  return [treeNodeKey(node), node.requestId, node.iteration ?? "", node.attempt ?? ""].join("|");
}

function chatTranscriptFor(
  events: ReadonlyArray<ChatEvent>,
  requestedIds: ReadonlyArray<string>,
  iteration?: number,
  attempt?: number,
): { id: string; transcript: ReturnType<typeof buildNodeChatTranscript> } {
  const transcriptEvents = transcriptFramesForNode(events, requestedIds, iteration, attempt);
  // Run-wide events may contain every agent's transcript. Only add aliases
  // that match the requested node, otherwise a completed node with no chat
  // could display another node's conversation.
  const scopedEventIds = transcriptEvents
    .flatMap((frame) => eventNodeIds(frame))
    .filter((id) => requestedIds.some((requested) => nodeMatches(requested, id)));
  const candidateIds = [...requestedIds, ...scopedEventIds].filter(
    (id, index, all): id is string => Boolean(id) && all.indexOf(id) === index,
  );
  let selected = {
    id: candidateIds[0] ?? "",
    transcript: buildNodeChatTranscript(transcriptEvents, candidateIds[0] ?? ""),
  };
  for (const id of candidateIds.slice(1)) {
    const transcript = buildNodeChatTranscript(transcriptEvents, id);
    if (transcript.items.length > selected.transcript.items.length) selected = { id, transcript };
  }
  return selected;
}

function rowOf(value: unknown, outputEnvelope = false): Row {
  let source = parseMaybeJson(value);
  if (outputEnvelope) source = parseMaybeJson(unwrapNodeOutput(source).row);
  let current: Row = isRecord(source) ? source : {};
  for (let index = 0; index < 4; index += 1) {
    if (isRecord(current.row)) current = current.row;
    else if (isRecord(current.data)) current = current.data;
    else break;
  }
  const row: Row = {};
  for (const [key, entry] of Object.entries(current)) {
    const parsed = parseMaybeJson(entry);
    row[key] = parsed;
    const camel = key.replace(/_([a-z0-9])/g, (_match, character: string) =>
      character.toUpperCase(),
    );
    row[camel] = parsed;
  }
  return row;
}

function arrayOf(value: unknown): unknown[] {
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed)) {
    const nested = [
      parsed.items,
      parsed.rows,
      parsed.runs,
      parsed.tests,
      parsed.approvals,
      parsed.widthResults,
      parsed.width_results,
      parsed.patches,
      parsed.artifacts,
      parsed.artifactPaths,
      parsed.artifact_paths,
      parsed.events,
      parsed.nodes,
    ].find((candidate) => Array.isArray(parseMaybeJson(candidate)));
    const parsedNested = parseMaybeJson(nested);
    return Array.isArray(parsedNested) ? parsedNested : [];
  }
  return [];
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : fallback;
}

function cellText(value: unknown): string {
  const parsed = parseMaybeJson(value);
  if (parsed == null || parsed === "") return "—";
  if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean")
    return String(parsed);
  try {
    return JSON.stringify(parsed) ?? "—";
  } catch {
    return String(parsed);
  }
}

function digestValue(row: Row): string | undefined {
  return firstText(
    row.digest,
    row.uiPlaygroundRootDigest,
    row.ui_playground_root_digest,
    row.sha256,
    row.hash,
  );
}

function isTrue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function checkStatus(row: Row): string {
  if (isTrue(row.skipped) || text(row.status).toLowerCase() === "skipped") return "skipped";
  const status = text(row.status).toLowerCase();
  if (["passed", "ok", "succeeded", "finished", "completed"].includes(status)) return "passed";
  if (["failed", "blocked", "error", "errored"].includes(status)) return "failed";
  if (
    ["running", "queued", "waiting", "waiting-approval", "waiting-event", "waiting-timer"].includes(
      status,
    )
  ) {
    return status === "waiting" || status.startsWith("waiting") ? "waiting" : "running";
  }
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  return "pending";
}

function testStatus(row: Row): "passed" | "failed" | "skipped" | "running" | "todo" {
  const status = checkStatus(row);
  if (status === "passed" || status === "ok" || status === "succeeded") return "passed";
  if (status === "skipped") return "skipped";
  if (status === "running" || status === "queued" || status === "waiting") return "running";
  if (status === "failed" || status === "blocked" || status === "error") return "failed";
  return "todo";
}

function humanizeNodeId(nodeId: string): string {
  return nodeId.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function visualRows(value: unknown): Row[] {
  const observed = arrayOf(value).filter(isRecord);
  return VISUAL_WIDTHS.map((width) => {
    const match = observed.find(
      (entry) => Number(entry.width ?? entry.viewportWidth ?? entry.viewport_width) === width,
    );
    return match ?? { width, status: "pending", screenshot: "", diff: "" };
  });
}

function diffStatus(operation: unknown): "added" | "modified" | "deleted" | "renamed" | "unknown" {
  switch (operation) {
    case "add":
      return "added";
    case "delete":
      return "deleted";
    case "rename":
      return "renamed";
    case "modify":
      return "modified";
    default:
      return "unknown";
  }
}

function runIdFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("runId") || undefined;
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box" }}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent
        style={{
          width: "100%",
          minWidth: 0,
          maxWidth: "100%",
          boxSizing: "border-box",
          overflowX: "hidden",
        }}
      >
        {children}
      </CardContent>
    </Card>
  );
}

function JsonTable({ rows, columns }: { rows: Row[]; columns: string[] }) {
  return (
    <div style={{ width: "100%", maxWidth: "100%", minWidth: 0, overflowX: "auto" }}>
      <Table style={{ minWidth: 560 }}>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length}>No recorded output yet.</TableCell>
            </TableRow>
          ) : (
            rows.map((entry, index) => (
              <TableRow key={`${index}-${text(entry.id, "row")}`}>
                {columns.map((column) => (
                  <TableCell key={column}>
                    <code>{cellText(entry[column])}</code>
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function CheckResultsTable({ rows }: { rows: Row[] }) {
  return (
    <div style={{ width: "100%", maxWidth: "100%", minWidth: 0, overflowX: "auto" }}>
      <Table style={{ minWidth: 560 }}>
        <TableHeader>
          <TableRow>
            <TableHead>check</TableHead>
            <TableHead>status</TableHead>
            <TableHead>skipped</TableHead>
            <TableHead>exit code</TableHead>
            <TableHead>evidence</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5}>No verification result yet.</TableCell>
            </TableRow>
          ) : (
            rows.map((check, index) => {
              const status = checkStatus(check);
              return (
                <TableRow key={`${text(check.id, "check")}-${index}`}>
                  <TableCell>{text(check.id, "check")}</TableCell>
                  <TableCell>
                    <UiStatusPill status={status} />
                  </TableCell>
                  <TableCell>
                    {isTrue(check.skipped) || status === "skipped" ? "yes" : "no"}
                  </TableCell>
                  <TableCell>{text(check.exitCode, "—")}</TableCell>
                  <TableCell>
                    {arrayOf(check.artifactPaths)
                      .map((path) => text(path))
                      .join(", ") || "—"}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function VisualWidthsTable({ rows }: { rows: Row[] }) {
  return (
    <div style={{ width: "100%", maxWidth: "100%", minWidth: 0, overflowX: "auto" }}>
      <Table style={{ minWidth: 560 }}>
        <TableHeader>
          <TableRow>
            <TableHead>viewport width</TableHead>
            <TableHead>status</TableHead>
            <TableHead>screenshot</TableHead>
            <TableHead>diff evidence</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((entry) => (
            <TableRow key={text(entry.width, "width")}>
              <TableCell>{text(entry.width, "—")}px</TableCell>
              <TableCell>
                <UiStatusPill status={checkStatus(entry)} />
              </TableCell>
              <TableCell>
                <code>{cellText(entry.screenshot)}</code>
              </TableCell>
              <TableCell>
                <code>{cellText(entry.diff)}</code>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ArtifactLedger({ paths }: { paths: string[] }) {
  if (paths.length === 0)
    return (
      <EmptyState
        title="No artifacts recorded"
        description="Artifact paths will appear after the Gateway records a check or checkpoint."
      />
    );
  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        width: "100%",
        minWidth: 0,
        maxWidth: "100%",
        boxSizing: "border-box",
      }}
    >
      {paths.map((path) => (
        <Artifact key={path}>
          <ArtifactHeader>
            <ArtifactTitle>{path}</ArtifactTitle>
          </ArtifactHeader>
          <ArtifactContent>
            <ArtifactDescription>
              Gateway-recorded evidence path. The dashboard does not read the repository or a
              private database.
            </ArtifactDescription>
          </ArtifactContent>
        </Artifact>
      ))}
    </div>
  );
}

function ResolvedNodeOutputCard({
  runId,
  nodes,
  nodeId,
  iteration,
  title,
}: {
  runId: string | undefined;
  nodes: ReadonlyArray<TreeNode>;
  nodeId: string;
  iteration?: number;
  title: string;
}) {
  const target = materializedNodeFor(nodeId, nodes);
  const targetStatus = target ? displayStatus(target.status) : "pending";
  if (target && ["skipped", "cancelled"].includes(targetStatus)) {
    return (
      <Card style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box" }}>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent style={{ display: "grid", gap: 8 }}>
          <UiStatusPill status={targetStatus} />
          <span>
            {targetStatus === "skipped"
              ? "Gateway marked this node as skipped; no output was requested."
              : "Gateway cancelled this node; no output was requested."}
          </span>
        </CardContent>
      </Card>
    );
  }
  if (target && targetStatus === "failed" && !nodeCanRequestOutput(target)) {
    return (
      <Card style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box" }}>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent style={{ display: "grid", gap: 8 }}>
          <UiStatusPill status="failed" />
          <span>Gateway marked this node as failed; it has no output envelope to display.</span>
        </CardContent>
      </Card>
    );
  }
  const requestOutput = target && nodeCanRequestOutput(target);
  return (
    <NodeOutputCard
      runId={runId}
      nodeId={requestOutput ? target?.outputId : undefined}
      iteration={target?.iteration ?? iteration ?? 0}
      title={title}
      style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box" }}
      useNodeOutput={targetStatus === "failed" ? useStoredFailureOutput : usePendingOutputOnError}
      summary={
        target
          ? requestOutput
            ? undefined
            : "Pending · node has no available output yet"
          : "Pending · node not materialized"
      }
    />
  );
}

function ResolvedNodeOutputView({
  runId,
  nodes,
  nodeId,
  iteration,
}: {
  runId: string | undefined;
  nodes: ReadonlyArray<TreeNode>;
  nodeId: string;
  iteration?: number;
}) {
  const target = materializedNodeFor(nodeId, nodes);
  if (!target) {
    return (
      <EmptyState
        title="Output pending"
        description={`${humanizeNodeId(nodeId)} has not materialized in this run.`}
      />
    );
  }
  const targetStatus = displayStatus(target.status);
  if (["skipped", "cancelled"].includes(targetStatus)) {
    return (
      <Card style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box" }}>
        <CardContent style={{ display: "grid", gap: 8 }}>
          <UiStatusPill status={targetStatus} />
          <EmptyState
            title={targetStatus === "skipped" ? "Output skipped" : "Output cancelled"}
            description={`${humanizeNodeId(nodeId)} was ${targetStatus} by the Gateway.`}
          />
        </CardContent>
      </Card>
    );
  }
  if (targetStatus === "failed" && !nodeCanRequestOutput(target)) {
    return (
      <Card style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box" }}>
        <CardContent style={{ display: "grid", gap: 8 }}>
          <UiStatusPill status="failed" />
          <EmptyState
            title="Output failed"
            description={`${humanizeNodeId(nodeId)} failed before producing a Gateway output envelope.`}
          />
        </CardContent>
      </Card>
    );
  }
  if (!nodeCanRequestOutput(target)) {
    return (
      <EmptyState
        title="Output pending"
        description={`${humanizeNodeId(nodeId)} has not produced a Gateway output envelope yet.`}
      />
    );
  }
  return (
    <NodeOutputCard
      runId={runId}
      nodeId={target.outputId}
      iteration={target.iteration ?? iteration ?? 0}
      title={humanizeNodeId(nodeId)}
      style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box" }}
      useNodeOutput={usePendingOutputOnError}
    />
  );
}

function ConditionalOutputCard({
  runId,
  nodes,
  nodeId,
  title,
  description,
  run,
  approvalRows = [],
}: {
  runId: string | undefined;
  nodes: ReadonlyArray<TreeNode>;
  nodeId: string;
  title: string;
  description: string;
  run?: Row;
  approvalRows?: ReadonlyArray<Row>;
}) {
  const target = materializedNodeFor(nodeId, nodes);
  if (!target) {
    const status = derivedConditionalStatus(nodeId, run, approvalRows);
    return (
      <Card style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box" }}>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent style={{ display: "grid", gap: 8 }}>
          <UiStatusPill status={status} />
          <span>
            {status === "pending"
              ? description
              : status === "failed"
                ? "Gateway recorded a failed conditional outcome from its durable records."
                : status === "passed"
                  ? "Gateway recorded an approved conditional outcome; no separate output node is present."
                  : status === "skipped"
                    ? "Gateway recorded this conditional outcome as skipped."
                    : "Gateway recorded this conditional outcome but no output node is present yet."}
          </span>
        </CardContent>
      </Card>
    );
  }
  return <ResolvedNodeOutputCard runId={runId} nodes={nodes} nodeId={nodeId} title={title} />;
}

function ResolvedAgentChat({
  runId,
  node,
  status,
  eventAliases = [],
  runEvents,
}: {
  runId: string | undefined;
  node: MaterializedNode;
  status: string;
  eventAliases?: ReadonlyArray<string>;
  runEvents: {
    events: ReadonlyArray<{ event: string; payload?: unknown; seq: number }>;
    loading: boolean;
    error?: Error;
    streaming?: boolean;
  };
}) {
  const requestId = gatewayEventId(node.requestId) ?? gatewayEventId(node.outputId);
  const logicalId =
    gatewayEventId(node.logicalId || node.outputId || text(node.id, node.requestId)) ||
    requestId ||
    "agent";
  const alternateId = logicalId !== requestId ? logicalId : undefined;
  const eventAliasId = eventAliases
    .map((id) => gatewayEventId(id))
    .find((id): id is string => Boolean(id) && id !== requestId && id !== alternateId);
  const requestEvents = useGatewayNodeEvents(runId, requestId);
  const alternateEvents = useGatewayNodeEvents(runId, alternateId);
  const eventAliasEvents = useGatewayNodeEvents(runId, eventAliasId);
  const requestTranscript = chatTranscriptFor(
    requestEvents.events,
    [requestId, logicalId].filter(Boolean) as string[],
    node.iteration,
    node.attempt,
  );
  const alternateTranscript = chatTranscriptFor(
    alternateEvents.events,
    [alternateId, requestId].filter(Boolean) as string[],
    node.iteration,
    node.attempt,
  );
  const eventAliasTranscript = chatTranscriptFor(
    eventAliasEvents.events,
    [eventAliasId, requestId, logicalId].filter(Boolean) as string[],
    node.iteration,
    node.attempt,
  );
  const runTranscript = chatTranscriptFor(
    runEvents.events,
    [node.requestId, ...eventAliases, requestId, logicalId].filter((id): id is string =>
      Boolean(id),
    ),
    node.iteration,
    node.attempt,
  );
  const sources = [
    {
      events: runEvents,
      transcript: runTranscript,
    },
    { events: requestEvents, transcript: requestTranscript },
    { events: alternateEvents, transcript: alternateTranscript },
    { events: eventAliasEvents, transcript: eventAliasTranscript },
  ];
  const selectedSource = sources.reduce((best, source) => {
    const sourceItems = source.transcript.transcript.items.length;
    const bestItems = best.transcript.transcript.items.length;
    if (sourceItems > bestItems) return source;
    if (sourceItems < bestItems) return best;
    if (source.events.error && !best.events.error) return source;
    if (source.events.loading && !best.events.loading && !best.events.error) return source;
    return best;
  });
  const selectedEvents = selectedSource.events;
  const selectedTranscript = selectedSource.transcript;
  const selectedId = selectedTranscript.id || eventAliasId || requestId || logicalId;
  const selectedError = selectedEvents.error;
  const selectedNodeEvents = {
    ...selectedEvents,
    events: transcriptFramesForNode(
      selectedEvents.events,
      [node.requestId, node.logicalId, ...eventAliases, requestId, logicalId].filter(
        (id): id is string => Boolean(id),
      ),
      node.iteration,
      node.attempt,
    ),
    streaming: selectedEvents.streaming ?? !selectedEvents.loading,
  } as ReturnType<typeof useGatewayNodeEvents>;
  const observedStatus = selectedTranscript.transcript.status;
  const effectiveStatus = observedStatus ? materializedStatusValue(observedStatus) : status;
  const settled = [
    "ok",
    "finished",
    "completed",
    "succeeded",
    "failed",
    "cancelled",
    "canceled",
  ].includes(effectiveStatus.toLowerCase());

  if (!selectedEvents.loading && settled && selectedTranscript.transcript.items.length === 0) {
    return (
      <Card style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box" }}>
        <CardHeader>
          <CardTitle>
            {node.name ?? logicalId}
            {node.iteration !== undefined ? ` · iteration ${node.iteration}` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            title={selectedError ? "Transcript source failed" : "Transcript unavailable"}
            description={
              selectedError
                ? `Gateway node events for ${selectedId} failed: ${selectedError.message}`
                : `Gateway returned no durable chat transcript for completed node ${selectedId}.`
            }
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <NodeChatStream
      runId={runId}
      nodeId={selectedId}
      title={`${node.name ?? logicalId}${node.iteration !== undefined ? ` · iteration ${node.iteration}` : ""}`}
      subtitle={agentSubtitle(node.agent)}
      status={effectiveStatus}
      height={180}
      style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box" }}
      useNodeEvents={() => selectedNodeEvents}
    />
  );
}

function OutputLedger({
  runId,
  nodes,
}: {
  runId: string | undefined;
  nodes: ReadonlyArray<TreeNode>;
}) {
  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        width: "100%",
        minWidth: 0,
        maxWidth: "100%",
        boxSizing: "border-box",
      }}
    >
      {OUTPUT_NODE_IDS.map((nodeId) => (
        <ResolvedNodeOutputCard
          key={nodeId}
          runId={runId}
          nodes={nodes}
          nodeId={nodeId}
          title={humanizeNodeId(nodeId)}
        />
      ))}
    </div>
  );
}

type CrashResumeProof = {
  status: "verified" | "partial" | "unavailable";
  latestCheckpointId?: string;
  latestFrameNo?: number;
  latestFrameHash?: string;
  workerEvent?: string;
  workerEventSeq?: number;
  restartBoundary?: string;
  restartBoundarySeq?: number;
  restartCause?: string;
  resumeEvent?: string;
  resumeEventSeq?: number;
  resumeTimestamp?: string | number;
  restoredNodeState?: string;
  linkedEvents: Row[];
};

function crashResumeProof(
  run: Row,
  events: ReadonlyArray<{ event?: unknown; payload?: unknown; seq?: number; timestampMs?: number }>,
  snapshot?: unknown,
): CrashResumeProof {
  const runState = rowOf(run.runState);
  const snapshotRow = rowOf(snapshot);
  const snapshotRunState = rowOf(snapshotRow.runState);
  const checkpointEvents = events.filter((frame) =>
    /checkpoint|snapshot|frame/i.test(text(frame.event)),
  );
  const runStartedEvents = events.filter((frame) => text(frame.event) === "RunStarted");
  const runStatusEvents = events.filter((frame) => text(frame.event) === "RunStatusChanged");
  const workerEvents = events.filter((frame) =>
    /(?:worker|process).*(?:lost|restart|crash|terminat|exit|dead)|(?:lost|restart|crash|terminat).*(?:worker|process)/i.test(
      text(frame.event),
    ),
  );
  const resumeEvents = events.filter((frame) =>
    /resume|recovered|restored/i.test(text(frame.event)),
  );
  const candidates = [
    firstText(
      run.checkpointId,
      run.latestCheckpointId,
      run.latest_checkpoint_id,
      run.snapshotId,
      run.snapshot_id,
      runState.checkpointId,
      runState.latestCheckpointId,
      snapshotRow.checkpointId,
      snapshotRow.checkpoint_id,
      snapshotRow.snapshotId,
      snapshotRow.snapshot_id,
      snapshotRow.frameId,
      snapshotRow.frame_id,
      snapshotRunState.checkpointId,
      snapshotRunState.checkpoint_id,
      snapshotRunState.snapshotId,
      snapshotRunState.snapshot_id,
      snapshotRunState.frameId,
      snapshotRunState.frame_id,
    ),
    ...checkpointEvents
      .slice()
      .sort((left, right) => Number(left.seq ?? -1) - Number(right.seq ?? -1))
      .reverse()
      .map((frame) => {
        const payload = eventPayload(frame.payload);
        const checkpointData = isRecord(payload.checkpoint) ? payload.checkpoint : {};
        const snapshotData = isRecord(payload.snapshot) ? payload.snapshot : {};
        const frameData = isRecord(payload.frame) ? payload.frame : {};
        return firstText(
          payload.checkpointId,
          payload.checkpoint_id,
          payload.snapshotId,
          payload.snapshot_id,
          payload.frameId,
          payload.frame_id,
          payload.checkpoint,
          payload.snapshot,
          payload.frame,
          checkpointData.id,
          checkpointData.checkpointId,
          checkpointData.checkpoint_id,
          snapshotData.id,
          snapshotData.snapshotId,
          snapshotData.snapshot_id,
          frameData.checkpointId,
          frameData.checkpoint_id,
          frameData.snapshotId,
          frameData.snapshot_id,
          frameData.frameId,
          frameData.frame_id,
        );
      }),
  ];
  const latestCheckpointId = candidates.find(Boolean);
  const latestFrame = checkpointEvents
    .slice()
    .sort((left, right) => Number(left.seq ?? -1) - Number(right.seq ?? -1))
    .at(-1);
  const latestFramePayload = eventPayload(latestFrame?.payload);
  const latestCheckpointData = isRecord(latestFramePayload.checkpoint)
    ? latestFramePayload.checkpoint
    : {};
  const latestSnapshotData = isRecord(latestFramePayload.snapshot)
    ? latestFramePayload.snapshot
    : {};
  const latestFrameData = isRecord(latestFramePayload.frame) ? latestFramePayload.frame : {};
  const latestFrameNo = numberValue(
    run.frameNo,
    run.frameNumber,
    run.latestFrameNo,
    run.latest_frame_no,
    runState.frameNo,
    snapshotRow.frameNo,
    snapshotRow.frame_no,
    snapshotRow.frameNumber,
    snapshotRow.frame_number,
    snapshotRunState.frameNo,
    snapshotRunState.frame_no,
    snapshotRunState.frameNumber,
    snapshotRunState.frame_number,
    latestFramePayload.frame,
    latestFramePayload.checkpoint,
    latestFramePayload.snapshot,
    latestFramePayload.frameNo,
    latestFramePayload.frame_no,
    latestFramePayload.frameNumber,
    latestFramePayload.frame_number,
    latestCheckpointData.frameNo,
    latestCheckpointData.frame_no,
    latestCheckpointData.frameNumber,
    latestCheckpointData.frame_number,
    latestSnapshotData.frameNo,
    latestSnapshotData.frame_no,
    latestSnapshotData.frameNumber,
    latestSnapshotData.frame_number,
    latestFrameData.frameNo,
    latestFrameData.frame_no,
    latestFrameData.frameNumber,
    latestFrameData.frame_number,
  );
  const latestFrameHash = firstText(
    run.frameHash,
    run.frame_hash,
    run.latestFrameHash,
    run.latest_frame_hash,
    runState.frameHash,
    runState.frame_hash,
    snapshotRow.frameHash,
    snapshotRow.frame_hash,
    snapshotRow.xmlHash,
    snapshotRow.xml_hash,
    snapshotRow.contentHash,
    snapshotRow.content_hash,
    snapshotRow.hash,
    snapshotRunState.frameHash,
    snapshotRunState.frame_hash,
    snapshotRunState.xmlHash,
    snapshotRunState.xml_hash,
    snapshotRunState.contentHash,
    snapshotRunState.content_hash,
    snapshotRunState.hash,
    latestFramePayload.frameHash,
    latestFramePayload.frame_hash,
    latestFramePayload.xmlHash,
    latestFramePayload.xml_hash,
    latestFramePayload.contentHash,
    latestFramePayload.content_hash,
    latestFramePayload.hash,
    latestCheckpointData.frameHash,
    latestCheckpointData.frame_hash,
    latestCheckpointData.xmlHash,
    latestCheckpointData.xml_hash,
    latestCheckpointData.contentHash,
    latestCheckpointData.content_hash,
    latestCheckpointData.hash,
    latestSnapshotData.frameHash,
    latestSnapshotData.frame_hash,
    latestSnapshotData.xmlHash,
    latestSnapshotData.xml_hash,
    latestSnapshotData.contentHash,
    latestSnapshotData.content_hash,
    latestSnapshotData.hash,
    latestFrameData.frameHash,
    latestFrameData.frame_hash,
    latestFrameData.xmlHash,
    latestFrameData.xml_hash,
    latestFrameData.contentHash,
    latestFrameData.content_hash,
    latestFrameData.hash,
  );
  const latestWorker = workerEvents.at(-1);
  const latestResume = resumeEvents.at(-1);
  const latestRunStarted = runStartedEvents.at(-1);
  const latestQuotaStatus = runStatusEvents
    .filter((frame) => {
      const payload = eventPayload(frame.payload);
      return /waiting[-_ ]quota/i.test(text(payload.status ?? payload.state));
    })
    .at(-1);
  const resumePayload = eventPayload(latestResume?.payload);
  const resumeTimestamp =
    numberValue(
      latestResume?.timestampMs,
      resumePayload.timestampMs,
      resumePayload.timestamp_ms,
      resumePayload.resumedAtMs,
      resumePayload.resumed_at_ms,
      resumePayload.timestamp,
      resumePayload.resumedTimestampMs,
      resumePayload.resumed_timestamp_ms,
      run.resumeAtMs,
      run.resumedAtMs,
      run.resumeTimestampMs,
    ) ??
    firstText(
      resumePayload.resumedAt,
      resumePayload.resumed_at,
      resumePayload.timestamp,
      run.resumeAt,
      run.resumedAt,
      run.resumeTimestamp,
    );
  const restoredNodeState = firstText(
    run.restoredNodeState,
    run.restored_node_state,
    runState.restoredNodeState,
    runState.restored_node_state,
    resumePayload.restoredNodeState,
    resumePayload.restored_node_state,
    resumePayload.nodeState,
    resumePayload.node_state,
  );
  const restoredStateValue =
    restoredNodeState ??
    [
      run.restoredState,
      runState.restoredState,
      run.restoredNodeState,
      run.restored_node_state,
      runState.restoredNodeState,
      runState.restored_node_state,
      resumePayload.restoredState,
      resumePayload.restoredNodeState,
      resumePayload.restored_node_state,
      resumePayload.state,
      resumePayload.nodeState,
    ]
      .map((value) => {
        const parsed = parseMaybeJson(value);
        if (!isRecord(parsed) && !Array.isArray(parsed)) return firstText(parsed);
        try {
          return JSON.stringify(parsed);
        } catch {
          return undefined;
        }
      })
      .find(Boolean);
  const restartBoundary = latestWorker
    ? text(latestWorker.event, "worker restart")
    : latestRunStarted && (runStartedEvents.length > 1 || latestQuotaStatus)
      ? text(latestRunStarted.event, "RunStarted")
      : undefined;
  const restartBoundarySeq = restartBoundary
    ? (latestWorker?.seq ?? latestRunStarted?.seq)
    : undefined;
  const restartPayload = eventPayload((latestWorker ?? latestRunStarted)?.payload);
  const restartCause = firstText(
    restartPayload.reason,
    restartPayload.cause,
    restartPayload.restartReason,
    restartPayload.restart_reason,
    eventPayload(latestQuotaStatus?.payload).status,
    run.restartCause,
    run.restart_cause,
    restartBoundary ? "additional RunStarted event" : undefined,
  );
  const quotaRestartDetected = Boolean(latestQuotaStatus) || /quota/i.test(restartCause ?? "");
  const snapshotSeq = numberValue(snapshotRow.seq, snapshotRow.frameSeq, snapshotRow.frame_seq);
  const snapshotLinkedEvent =
    snapshotSeq !== undefined &&
    (latestFrameNo !== undefined || latestFrameHash || latestCheckpointId)
      ? {
          seq: snapshotSeq,
          event: "SnapshotCaptured",
          timestamp: numberValue(snapshotRow.timestampMs, snapshotRow.timestamp_ms),
          nodeId: "—",
          frameNo: latestFrameNo,
          hash: latestFrameHash,
          cause: "latest Gateway snapshot",
        }
      : undefined;
  const linkedEvents = [
    ...(snapshotLinkedEvent ? [snapshotLinkedEvent] : []),
    ...new Map(
      [
        ...checkpointEvents,
        ...workerEvents,
        ...resumeEvents,
        ...runStartedEvents.slice(-2),
        ...(latestQuotaStatus ? [latestQuotaStatus] : []),
      ]
        .filter((frame) => typeof frame.seq === "number")
        .map((frame) => [frame.seq, frame]),
    ).values(),
  ]
    .sort((left, right) => Number(left.seq) - Number(right.seq))
    .map((frame) => {
      const payload = eventPayload(frame.payload);
      const checkpointData = isRecord(payload.checkpoint) ? payload.checkpoint : {};
      const snapshotData = isRecord(payload.snapshot) ? payload.snapshot : {};
      const frameData = isRecord(payload.frame) ? payload.frame : {};
      return {
        seq: frame.seq,
        event: text(frame.event, "—"),
        timestamp: frame.timestampMs ?? payload.timestampMs,
        nodeId: eventNodeIds(frame)[0] ?? "—",
        frameNo: numberValue(
          payload.frameNo,
          payload.frame_no,
          payload.frameNumber,
          payload.frame_number,
          frameData.frameNo,
          frameData.frame_no,
          frameData.frameNumber,
          frameData.frame_number,
          checkpointData.frameNo,
          checkpointData.frame_no,
          checkpointData.frameNumber,
          checkpointData.frame_number,
          snapshotData.frameNo,
          snapshotData.frame_no,
          snapshotData.frameNumber,
          snapshotData.frame_number,
        ),
        hash: firstText(
          payload.frameHash,
          payload.frame_hash,
          payload.xmlHash,
          payload.xml_hash,
          payload.contentHash,
          payload.content_hash,
          payload.hash,
          frameData.frameHash,
          frameData.frame_hash,
          frameData.xmlHash,
          frameData.xml_hash,
          frameData.contentHash,
          frameData.content_hash,
          frameData.hash,
          checkpointData.frameHash,
          checkpointData.frame_hash,
          checkpointData.xmlHash,
          checkpointData.xml_hash,
          checkpointData.contentHash,
          checkpointData.content_hash,
          checkpointData.hash,
          snapshotData.frameHash,
          snapshotData.frame_hash,
          snapshotData.xmlHash,
          snapshotData.xml_hash,
          snapshotData.contentHash,
          snapshotData.content_hash,
          snapshotData.hash,
        ),
        cause: firstText(
          payload.reason,
          payload.cause,
          payload.status,
          frameData.reason,
          frameData.cause,
        ),
      };
    });
  const hasResumeEvidence =
    Boolean(latestCheckpointId || latestFrameNo !== undefined) && Boolean(latestResume);
  const hasRestartEvidence =
    Boolean(latestWorker) ||
    Boolean(latestRunStarted && runStartedEvents.length > 1 && !quotaRestartDetected);
  const proofStatus =
    hasResumeEvidence && hasRestartEvidence && Boolean(restoredStateValue)
      ? "verified"
      : hasRestartEvidence || Boolean(latestResume)
        ? "partial"
        : "unavailable";
  return {
    status: proofStatus,
    latestCheckpointId,
    latestFrameNo,
    latestFrameHash,
    workerEvent: latestWorker ? text(latestWorker.event, "—") : undefined,
    workerEventSeq: latestWorker?.seq,
    restartBoundary,
    restartBoundarySeq,
    restartCause,
    resumeEvent: latestResume ? text(latestResume.event, "—") : undefined,
    resumeEventSeq: latestResume?.seq,
    resumeTimestamp,
    restoredNodeState: restoredStateValue,
    linkedEvents,
  };
}

function App() {
  const runsQuery = useGatewayRuns({ filter: { workflow: WORKFLOW_KEY, limit: 40 } });
  const runs = useMemo(() => arrayOf(runsQuery.data).filter(isRecord), [runsQuery.data]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const firstRunId = text(runs[0]?.runId ?? runs[0]?.id) || undefined;
  const activeRunId = selectedRunId ?? firstRunId;

  useEffect(() => {
    if (!selectedRunId && firstRunId) setSelectedRunId(firstRunId);
  }, [firstRunId, selectedRunId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!activeRunId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("runId", activeRunId);
    if (url.href !== window.location.href) window.history.replaceState({}, "", url);
  }, [activeRunId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => setSelectedRunId(runIdFromUrl());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const actions = useGatewayActions();
  const [cancelling, setCancelling] = useState(false);
  const runQuery = useGatewayRun(activeRunId);
  const tree = useGatewayRunTree(activeRunId);
  const events = useGatewayRunEvents(activeRunId, { maxEvents: 1024 });
  const latestSnapshotSeq = events.events
    .filter((frame) => text(frame.event) === "SnapshotCaptured")
    .at(-1)?.seq;
  const crashSnapshot = useGatewayRpc(
    "getDevToolsSnapshot",
    { runId: activeRunId ?? "" },
    { enabled: Boolean(activeRunId), deps: [activeRunId, latestSnapshotSeq] },
  );
  const resolvedTreeNodes = useMemo(
    () => materializedTreeNodes(tree.nodes, events.events),
    [events.events, tree.nodes],
  );
  const skipped = useMemo(() => skippedNodeIds(events.events), [events.events]);
  const approvals = useGatewayApprovals({
    filter: { workflow: WORKFLOW_KEY, runId: activeRunId ?? "", limit: 30 },
  });
  const approvalRows = useMemo(() => arrayOf(approvals.data).filter(isRecord), [approvals.data]);

  const materializedTargets = useMemo(() => {
    const ids = [...new Set([...OUTPUT_NODE_IDS, ...STAGE_IDS, ...CHECK_NODE_IDS])];
    return new Map(ids.map((id) => [id, materializedNodeFor(id, resolvedTreeNodes)]));
  }, [resolvedTreeNodes]);

  const outputTarget = (nodeId: string) => {
    const target = materializedTargets.get(nodeId);
    if (!target) return undefined;
    const logicalId =
      target.logicalId || nodeLogicalId(target) || text(target.id, target.requestId);
    const wasSkipped =
      text(target.status).toLowerCase() === "skipped" ||
      [...skipped].some((id) => nodeMatches(target.requestId, id) || nodeMatches(logicalId, id));
    return wasSkipped || !nodeCanRequestOutput(target) ? undefined : target;
  };
  const integrationDiffTarget = outputTarget("integrate_wave");
  const runDiff = useGatewayRunDiff({
    runId: integrationDiffTarget ? activeRunId : undefined,
  });

  const preflightOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("assert_preflight_ready")?.outputId,
    iteration: outputTarget("assert_preflight_ready")?.iteration ?? 0,
  });
  const wavePlanOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("plan_integration_waves")?.outputId,
    iteration: outputTarget("plan_integration_waves")?.iteration ?? 0,
  });
  const assignmentOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("select_and_assign_wave")?.outputId,
    iteration: outputTarget("select_and_assign_wave")?.iteration ?? 0,
  });
  const integrationOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("integrate_wave")?.outputId,
    iteration: outputTarget("integrate_wave")?.iteration ?? 0,
  });
  const cleanupOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("cleanup_obsolete_surface")?.outputId,
    iteration: outputTarget("cleanup_obsolete_surface")?.iteration ?? 0,
  });
  const verifyRetentionOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("verify_retention_cleanup")?.outputId,
    iteration: outputTarget("verify_retention_cleanup")?.iteration ?? 0,
  });
  const retentionOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("reverify_retention_cleanup")?.outputId,
    iteration: outputTarget("reverify_retention_cleanup")?.iteration ?? 0,
  });
  const baselineOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("persist_frozen_baseline")?.outputId,
    iteration: outputTarget("persist_frozen_baseline")?.iteration ?? 0,
  });
  const migrationOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("check_migration_0074")?.outputId,
    iteration: outputTarget("check_migration_0074")?.iteration ?? 0,
  });
  const aggregateOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("aggregate_verification_matrix")?.outputId,
    iteration: outputTarget("aggregate_verification_matrix")?.iteration ?? 0,
  });
  const visualOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("check_visual_breakpoints")?.outputId,
    iteration: outputTarget("check_visual_breakpoints")?.iteration ?? 0,
  });
  const retrievalOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("check_live_retrieval")?.outputId,
    iteration: outputTarget("check_live_retrieval")?.iteration ?? 0,
  });
  const stopOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("check_live_stop")?.outputId,
    iteration: outputTarget("check_live_stop")?.iteration ?? 0,
  });
  const resetOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("check_live_reset_during_run")?.outputId,
    iteration: outputTarget("check_live_reset_during_run")?.iteration ?? 0,
  });
  const reviewOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("independent_final_review")?.outputId,
    iteration: outputTarget("independent_final_review")?.iteration ?? 0,
  });
  const readinessOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("final_readiness_gate")?.outputId,
    iteration: outputTarget("final_readiness_gate")?.iteration ?? 0,
  });
  const finalOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: outputTarget("validate_final_result")?.outputId,
    iteration: outputTarget("validate_final_result")?.iteration ?? 0,
  });

  const run = rowOf(runQuery.data);
  const snapshotForRun =
    text(rowOf(crashSnapshot.data).runId) === activeRunId ? crashSnapshot.data : undefined;
  const runStatus = text(run.status, "pending");
  const preflight = rowOf(preflightOut.data, true);
  const assignment = rowOf(assignmentOut.data, true);
  const readiness = rowOf(readinessOut.data, true);
  const final = rowOf(finalOut.data, true);
  const wavePlan = rowOf(wavePlanOut.data, true);
  const cleanup = rowOf(cleanupOut.data, true);
  const verifyRetention = rowOf(verifyRetentionOut.data, true);
  const retention = rowOf(retentionOut.data, true);
  const integration = rowOf(integrationOut.data, true);
  const visual = rowOf(visualOut.data, true);
  const retrieval = rowOf(retrievalOut.data, true);
  const stop = rowOf(stopOut.data, true);
  const reset = rowOf(resetOut.data, true);
  const review = rowOf(reviewOut.data, true);
  const baseline = rowOf(baselineOut.data, true);

  const materializedStatuses = useMemo(() => {
    const keyedRows = resolvedTreeNodes.flatMap((node) => {
      const physicalId = nodeRequestId(node);
      const logicalId = nodeLogicalId(node);
      return [node, { ...node, id: physicalId }, { ...node, id: logicalId }];
    });
    return nodeStatusIndex(keyedRows);
  }, [resolvedTreeNodes]);
  const displayNodes = useMemo(
    () =>
      resolvedTreeNodes.map((node) => {
        const requestId = nodeRequestId(node);
        const logicalId = nodeLogicalId(node) || text(node.id, requestId);
        const wasSkipped = [...skipped].some(
          (id) => nodeMatches(requestId, id) || nodeMatches(logicalId, id),
        );
        return wasSkipped ? { ...node, status: "skipped" } : node;
      }),
    [resolvedTreeNodes, skipped],
  );
  const visibleAgentNodes = useMemo(() => {
    const seen = new Set<string>();
    const materializedAgents: MaterializedNode[] = [];
    for (const node of resolvedTreeNodes) {
      const logicalId = nodeLogicalId(node);
      const registryKind = TASK_REGISTRY.find(([id]) => id === logicalId)?.[1];
      // Gateway snapshots call static tasks "agent" when their task kind is
      // omitted. The workflow registry is the source of truth for that edge;
      // only actual agent tasks get fleet rows and chat streams.
      if (registryKind === "compute") continue;
      if (registryKind !== "agent" && node.agent === undefined && node.kind !== "agent") continue;
      const materialized: MaterializedNode = {
        ...node,
        requestId: nodeRequestId(node),
        outputId: nodeOutputId(node),
        logicalId: nodeLogicalId(node),
      };
      const identity = materializedAgentKey(materialized);
      if (seen.has(identity)) continue;
      seen.add(identity);
      materializedAgents.push(materialized);
    }
    return materializedAgents;
  }, [resolvedTreeNodes]);

  const checkOutputs: Record<string, unknown> = {
    check_migration_0074: migrationOut.data,
    check_live_retrieval: retrievalOut.data,
    check_live_stop: stopOut.data,
    check_live_reset_during_run: resetOut.data,
    check_visual_breakpoints: visualOut.data,
    aggregate_verification_matrix: aggregateOut.data,
  };
  const checkRows: Row[] = CHECK_RESULT_NODE_IDS.map((id) => {
    const output = checkOutputs[id];
    const row = rowOf(output, true);
    return {
      id,
      ...row,
      status: checkStatusForNode(id, resolvedTreeNodes, materializedStatuses, output, skipped),
    };
  });
  const testSuites = [
    {
      id: "verification-matrix",
      name: "Verification matrix",
      tests: checkRows.map((check) => ({
        id: text(check.id, "check"),
        name: text(check.id, "check"),
        status: testStatus(check),
        errorText: checkStatus(check) === "failed" ? text(check.summary) : undefined,
      })),
    },
  ];

  const graphSpec = TASK_REGISTRY.map(([id, kind], index) => ({
    id,
    label: id,
    kind: kind === "agent" ? ("agent" as const) : ("compute" as const),
    output: id,
    status: (() => {
      const target = materializedTargets.get(id);
      return target ? materializedStatus(target, materializedStatuses, skipped) : "pending";
    })(),
    dependsOn: index > 0 ? [TASK_REGISTRY[index - 1][0]] : [],
  }));
  const fleetItems = visibleAgentNodes.map((node) => {
    const id = node.requestId || node.outputId;
    const logicalId = node.logicalId || text(node.id, id);
    const status = materializedStatus(node, materializedStatuses, skipped);
    return {
      key: materializedAgentKey(node),
      title: `${node.name ?? logicalId}${node.iteration !== undefined ? ` · iteration ${node.iteration}` : ""}`,
      meta: [agentSubtitle(node.agent)],
      nodeIds: [logicalId, node.outputId, id],
      status,
    };
  });
  const stages = STAGE_IDS.map((nodeId) => ({
    nodeId: materializedTargets.get(nodeId)?.outputId ?? nodeId,
    label: nodeId.replaceAll("_", " "),
  }));
  const preflightStatus = checkStatusForNode(
    "assert_preflight_ready",
    resolvedTreeNodes,
    materializedStatuses,
    preflightOut.data,
    skipped,
  );
  const integrationStatus = checkStatusForNode(
    "integrate_wave",
    resolvedTreeNodes,
    materializedStatuses,
    integrationOut.data,
    skipped,
  );
  const baselineStatus = checkStatusForNode(
    "persist_frozen_baseline",
    resolvedTreeNodes,
    materializedStatuses,
    baselineOut.data,
    skipped,
  );
  const retentionOutputByNode: Record<string, unknown> = {
    integrate_wave: integrationOut.data,
    cleanup_obsolete_surface: cleanupOut.data,
    verify_retention_cleanup: verifyRetentionOut.data,
    reverify_retention_cleanup: retentionOut.data,
  };
  const retentionStatusByNode = Object.fromEntries(
    RETENTION_SOURCE_NODE_IDS.map((nodeId) => [
      nodeId,
      checkStatusForNode(
        nodeId,
        resolvedTreeNodes,
        materializedStatuses,
        retentionOutputByNode[nodeId],
        skipped,
      ),
    ]),
  ) as Record<string, GatewayDisplayStatus>;
  const retentionSourceStatuses = RETENTION_SOURCE_NODE_IDS.map(
    (nodeId) => retentionStatusByNode[nodeId],
  );
  const retentionStatus: GatewayDisplayStatus = retentionSourceStatuses.includes("failed")
    ? "failed"
    : retentionSourceStatuses.includes("running")
      ? "running"
      : retentionSourceStatuses.includes("waiting")
        ? "waiting"
        : retentionSourceStatuses.includes("cancelled")
          ? "cancelled"
          : retentionSourceStatuses.includes("skipped")
            ? "skipped"
            : retentionSourceStatuses.every((status) => status === "passed")
              ? "passed"
              : "pending";
  const integrationProduced =
    outputState(integrationOut.data) === "produced" && integrationStatus !== "failed";
  const retentionRows: Row[] = RETENTION_SOURCE_NODE_IDS.map((source) => {
    const output = retentionOutputByNode[source];
    const row = rowOf(output, true);
    const status = retentionStatusByNode[source];
    const proofRow = status === "passed" && outputState(output) === "produced" ? row : {};
    return {
      source,
      ...proofRow,
      digest: digestValue(proofRow),
      status,
      _output: output,
    };
  });
  if (outputState(baselineOut.data) !== "pending") {
    retentionRows.unshift({
      source: "persist_frozen_baseline",
      ...baseline,
      digest: digestValue(baseline),
      status: baselineStatus,
      _output: baselineOut.data,
    });
  }
  const retentionEvidence = {
    cleanup: retentionStatusByNode.cleanup_obsolete_surface === "passed" ? cleanup : {},
    verify: retentionStatusByNode.verify_retention_cleanup === "passed" ? verifyRetention : {},
    reverify: retentionStatusByNode.reverify_retention_cleanup === "passed" ? retention : {},
  };
  const retainedBytes = numberValue(
    retentionEvidence.reverify.retainedBytes,
    retentionEvidence.reverify.retained_bytes,
    retentionEvidence.reverify.retainedByteCount,
    retentionEvidence.reverify.retained_byte_count,
    retentionEvidence.reverify.byteCount,
    retentionEvidence.reverify.byte_count,
    retentionEvidence.reverify.bytes,
    retentionEvidence.reverify.totalBytes,
    retentionEvidence.reverify.total_bytes,
    retentionEvidence.cleanup.retainedBytes,
    retentionEvidence.cleanup.retained_bytes,
    retentionEvidence.cleanup.retainedByteCount,
    retentionEvidence.cleanup.retained_byte_count,
    retentionEvidence.cleanup.byteCount,
    retentionEvidence.cleanup.byte_count,
    retentionEvidence.cleanup.bytes,
    retentionEvidence.cleanup.totalBytes,
    retentionEvidence.cleanup.total_bytes,
    retentionEvidence.verify.retainedBytes,
    retentionEvidence.verify.retained_bytes,
    retentionEvidence.verify.retainedByteCount,
    retentionEvidence.verify.retained_byte_count,
    retentionEvidence.verify.byteCount,
    retentionEvidence.verify.byte_count,
    retentionEvidence.verify.bytes,
    retentionEvidence.verify.totalBytes,
    retentionEvidence.verify.total_bytes,
  );
  const retainedDigest = firstText(
    digestValue(retentionEvidence.reverify),
    retentionEvidence.reverify.uiPlaygroundRootDigest,
    retentionEvidence.reverify.ui_playground_root_digest,
    digestValue(retentionEvidence.verify),
    retentionEvidence.verify.uiPlaygroundRootDigest,
    retentionEvidence.verify.ui_playground_root_digest,
    digestValue(retentionEvidence.cleanup),
    retentionEvidence.cleanup.uiPlaygroundRootDigest,
    retentionEvidence.cleanup.ui_playground_root_digest,
  );
  const retainedByteMatch =
    retentionEvidence.reverify.byteMatch ??
    retentionEvidence.verify.byteMatch ??
    retentionEvidence.cleanup.byteMatch;
  const retentionArtifactPaths = Array.from(
    new Set(
      retentionRows
        .flatMap((row) => [...arrayOf(row.artifactPaths), ...arrayOf(row.artifacts)])
        .map((path) => text(path))
        .filter(Boolean),
    ),
  );
  const fallbackDiffText = integrationProduced
    ? text(integration.diff ?? integration.patch ?? "")
    : "";
  const diffPayload: Row = isRecord(runDiff.data) ? runDiff.data : {};
  const oversizedDiff = diffPayload.status === "oversized";
  const gatewayDiffPatches =
    integrationProduced && !oversizedDiff ? arrayOf(diffPayload.patches).filter(isRecord) : [];
  const diffFiles = gatewayDiffPatches
    .map((patch) => {
      const diff = text(patch.diff);
      return diff
        ? parseUnifiedFile(diff, {
            path: text(patch.path, "Gateway patch"),
            status: diffStatus(patch.operation),
          })
        : null;
    })
    .filter((file): file is NonNullable<typeof file> => file !== null);
  if (diffFiles.length === 0 && fallbackDiffText)
    diffFiles.push(parseUnifiedFile(fallbackDiffText));
  const widthRows = visualRows(visual.widthResults);
  const crashResume = useMemo(
    () => crashResumeProof(run, events.events, snapshotForRun),
    [events.events, run, snapshotForRun],
  );

  function selectRun(nextRunId: string | undefined) {
    setSelectedRunId(nextRunId);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (nextRunId) url.searchParams.set("runId", nextRunId);
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

  return (
    <>
      <SmithersUiStyles />
      <WorkflowUiShell
        title="UI Playground Demo Cutover"
        testId="implement-ui-playground-demo-cutover-ui"
        meta={
          <>
            <RunMeta runId={activeRunId} />
            <Badge variant="outline">{runs.length} runs</Badge>
          </>
        }
        actions={
          <Button
            variant="destructive"
            disabled={!activeRunId || cancelling}
            onClick={() => void cancelRun()}
          >
            {cancelling ? "Cancelling…" : "Cancel run"}
          </Button>
        }
      >
        <div
          style={{
            display: "grid",
            gap: 12,
            width: "100%",
            minWidth: 0,
            maxWidth: "100%",
            boxSizing: "border-box",
            overflowX: "hidden",
          }}
        >
          <style>{`
            .workflow-content {
              width: 100% !important;
              max-width: 100vw !important;
              min-width: 0 !important;
              box-sizing: border-box;
              overflow-x: hidden !important;
            }
            .workflow-content > * {
              min-width: 0;
              max-width: 100%;
            }
          `}</style>
          <Card style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box" }}>
            <CardContent>
              <label htmlFor="run-select">Run</label>{" "}
              <select
                id="run-select"
                value={activeRunId ?? ""}
                style={{ width: "100%", maxWidth: "100%", minWidth: 0, boxSizing: "border-box" }}
                onChange={(event) => selectRun(event.currentTarget.value || undefined)}
              >
                <option value="">Select a run</option>
                {activeRunId &&
                !runs.some((entry) => text(entry.runId ?? entry.id) === activeRunId) ? (
                  <option value={activeRunId}>{activeRunId.slice(0, 12)} · selected</option>
                ) : null}
                {runs.map((entry) => {
                  const id = text(entry.runId ?? entry.id);
                  return (
                    <option key={id} value={id}>
                      {id.slice(0, 12)} · {text(entry.status, "unknown")}
                    </option>
                  );
                })}
              </select>
            </CardContent>
          </Card>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,150px),1fr))",
              gap: 10,
              width: "100%",
              minWidth: 0,
              maxWidth: "100%",
              boxSizing: "border-box",
            }}
          >
            <KpiStat label="Run status" value={runStatus} hint={activeRunId ?? "No run selected"} />
            <KpiStat
              label="Live events"
              value={events.events.length}
              hint={events.streaming ? "streaming" : "idle"}
            />
            <KpiStat
              label="Tree nodes"
              value={tree.nodes.length}
              hint={
                crashResume.status === "verified"
                  ? "crash-resume evidence verified"
                  : crashResume.status === "partial"
                    ? "crash-resume evidence incomplete"
                    : "crash-resume unavailable (not exercised)"
              }
            />
            <KpiStat
              label="Retained bytes"
              value={retainedBytes === undefined ? "pending" : retainedBytes}
              hint={isTrue(retainedByteMatch) ? "byte match recorded" : "byte count pending"}
            />
            <KpiStat
              label="Retained digest"
              value={
                <span style={{ overflowWrap: "anywhere" }}>{retainedDigest ?? "pending"}</span>
              }
              hint="Gateway digest from retention output"
            />
            <KpiStat
              label="Pending approvals"
              value={approvalRows.length}
              hint="Gateway approval queue"
            />
          </div>

          <Panel title="Run overview and stage graph">
            <div style={{ width: "100%", minWidth: 0, maxWidth: "100%", overflowX: "auto" }}>
              <NodeStageStrip runId={activeRunId} stages={stages} />
            </div>
            <div
              style={{
                marginTop: 12,
                width: "100%",
                minWidth: 0,
                maxWidth: "100%",
                overflowX: "auto",
              }}
            >
              <WorkflowGraph
                spec={graphSpec}
                readOnly
                style={{ minHeight: 420, minWidth: 0, maxWidth: "100%" }}
              />
            </div>
          </Panel>

          <Panel title="Run tree and durable events">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,260px),1fr))",
                gap: 12,
                width: "100%",
                minWidth: 0,
                maxWidth: "100%",
                boxSizing: "border-box",
              }}
            >
              <RunTree
                runId={activeRunId}
                style={{ minHeight: 300, minWidth: 0, maxWidth: "100%" }}
              />
              <RunEventLog
                runId={activeRunId}
                maxEvents={180}
                style={{ maxHeight: 360, minWidth: 0, maxWidth: "100%" }}
              />
            </div>
          </Panel>

          <Panel title="Crash-resume and durable checkpoints">
            <UiStatusPill
              status={
                crashResume.status === "verified"
                  ? "passed"
                  : crashResume.status === "partial"
                    ? "waiting"
                    : "skipped"
              }
            />
            <JsonTable
              rows={[
                {
                  runId: activeRunId ?? "",
                  status: crashResume.status,
                  latestCheckpointId: crashResume.latestCheckpointId ?? "unavailable",
                  latestFrameNo: crashResume.latestFrameNo ?? "unavailable",
                  latestFrameHash: crashResume.latestFrameHash ?? "unavailable",
                  workerEvent: crashResume.workerEvent ?? "not observed",
                  workerEventSeq: crashResume.workerEventSeq ?? "unavailable",
                  restartBoundary: crashResume.restartBoundary ?? "not observed",
                  restartBoundarySeq: crashResume.restartBoundarySeq ?? "unavailable",
                  restartCause: crashResume.restartCause ?? "not observed",
                  resumeEvent: crashResume.resumeEvent ?? "not observed",
                  resumeEventSeq: crashResume.resumeEventSeq ?? "unavailable",
                  resumeTimestamp: crashResume.resumeTimestamp ?? "unavailable",
                  restoredNodeState: crashResume.restoredNodeState ?? "unavailable",
                  latestEventSeq: events.events.at(-1)?.seq ?? "unavailable",
                  latestHeartbeatSeq: events.lastHeartbeat?.seq ?? "unavailable",
                },
              ]}
              columns={[
                "runId",
                "status",
                "latestCheckpointId",
                "latestFrameNo",
                "latestFrameHash",
                "workerEvent",
                "workerEventSeq",
                "restartBoundary",
                "restartBoundarySeq",
                "restartCause",
                "resumeEvent",
                "resumeEventSeq",
                "resumeTimestamp",
                "restoredNodeState",
                "latestEventSeq",
                "latestHeartbeatSeq",
              ]}
            />
            <small>
              {crashResume.status === "verified"
                ? "Gateway recorded a checkpoint, worker loss or restart, resume, and restored state."
                : crashResume.status === "partial"
                  ? "Gateway recorded related durable events, but the full crash-resume proof is incomplete."
                  : "Gateway has no crash or resume evidence for this run; crash-resume state is unavailable or not exercised."}
            </small>
            <JsonTable
              rows={crashResume.linkedEvents}
              columns={["seq", "event", "timestamp", "nodeId", "frameNo", "hash", "cause"]}
            />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
                gap: 8,
                marginTop: 10,
                width: "100%",
                minWidth: 0,
                maxWidth: "100%",
                boxSizing: "border-box",
              }}
            >
              {[
                "checkpoint_wave",
                "checkpoint_cleanup_and_docs",
                "checkpoint_verification",
                "checkpoint_review",
                "assert_stable_review_and_verification",
              ].map((nodeId) => (
                <ResolvedNodeOutputCard
                  key={nodeId}
                  runId={activeRunId}
                  nodes={displayNodes}
                  nodeId={nodeId}
                  title={humanizeNodeId(nodeId)}
                />
              ))}
            </div>
          </Panel>

          <Panel title="Agent fleet, ownership, and live chat">
            {fleetItems.length === 0 ? (
              <EmptyState
                title="No agent nodes"
                description="The Gateway will show the assigned lanes after the planning step."
              />
            ) : (
              <div style={{ width: "100%", maxWidth: "100%", minWidth: 0, overflowX: "auto" }}>
                <FleetTable runId={activeRunId} items={fleetItems} columns={["role"]} />
              </div>
            )}
            <div
              style={{
                display: "grid",
                gap: 10,
                marginTop: 12,
                width: "100%",
                minWidth: 0,
                maxWidth: "100%",
              }}
            >
              {visibleAgentNodes.map((node) => {
                const status = materializedStatus(node, materializedStatuses, skipped);
                return (
                  <ResolvedAgentChat
                    key={materializedAgentKey(node)}
                    runId={activeRunId}
                    node={node}
                    status={status}
                    eventAliases={eventAliasesForNode(node, events.events)}
                    runEvents={events}
                  />
                );
              })}
            </div>
          </Panel>

          <Tabs
            defaultValue="contracts"
            style={{
              width: "100%",
              minWidth: 0,
              maxWidth: "100%",
              boxSizing: "border-box",
              overflowX: "hidden",
            }}
          >
            <TabsList style={{ maxWidth: "100%", overflowX: "auto", flexWrap: "wrap" }}>
              <TabsTrigger value="contracts">Contracts</TabsTrigger>
              <TabsTrigger value="waves">Waves</TabsTrigger>
              <TabsTrigger value="retention">Retention</TabsTrigger>
              <TabsTrigger value="verification">Verification</TabsTrigger>
              <TabsTrigger value="live">Live flows</TabsTrigger>
              <TabsTrigger value="review">Review and approval</TabsTrigger>
              <TabsTrigger value="outputs">Output envelopes</TabsTrigger>
            </TabsList>
            <TabsContent value="contracts">
              <Panel title="Frozen contracts and retained maps">
                <ResolvedNodeOutputCard
                  runId={activeRunId}
                  nodes={displayNodes}
                  nodeId="freeze_contracts"
                  title="Frozen contracts"
                />
                <ResolvedNodeOutputCard
                  runId={activeRunId}
                  nodes={displayNodes}
                  nodeId="persist_frozen_baseline"
                  title="Frozen baseline"
                />
                <ResolvedNodeOutputView
                  runId={activeRunId}
                  nodes={displayNodes}
                  nodeId="plan_integration_waves"
                />
              </Panel>
            </TabsContent>
            <TabsContent value="waves">
              <Panel title="Wave assignment and changes">
                <JsonTable
                  rows={[assignment, wavePlan, integration].filter(
                    (entry) => Object.keys(entry).length > 0,
                  )}
                  columns={[
                    "summary",
                    "waveId",
                    "workItemIds",
                    "laneAssignments",
                    "changedFiles",
                    "deletedFiles",
                    "conflicts",
                  ]}
                />
                <ResolvedNodeOutputView
                  runId={activeRunId}
                  nodes={displayNodes}
                  nodeId="integrate_wave"
                />
              </Panel>
            </TabsContent>
            <TabsContent value="retention">
              <Panel title="Retention, deletion, and diff proof">
                <UiStatusPill status={retentionStatus} />
                <small>
                  Retention, deletion, ownership, and diff fields come from live Gateway output
                  envelopes only.
                </small>
                <JsonTable
                  rows={retentionRows}
                  columns={[
                    "source",
                    "status",
                    "summary",
                    "retainedBytes",
                    "retainedByteCount",
                    "byteCount",
                    "totalBytes",
                    "digest",
                    "byteMatch",
                    "runtimeDependencyCount",
                    "removedFiles",
                    "removedExports",
                    "removedDependencies",
                    "removedCapabilities",
                    "retainedItems",
                    "reachabilityFindings",
                    "deletionMapFindings",
                    "ownershipArtifact",
                    "deletionMapArtifact",
                    "retainedReferenceManifest",
                    "changedFiles",
                    "integrationArtifact",
                    "artifacts",
                    "checkpointId",
                    "entryCount",
                    "retainedEntryCount",
                    "deletionProof",
                    "ownership",
                    "integratedDiff",
                  ]}
                />
                <ArtifactLedger paths={retentionArtifactPaths} />
                <div
                  style={{
                    display: "grid",
                    gap: 8,
                    marginTop: 10,
                    width: "100%",
                    minWidth: 0,
                    maxWidth: "100%",
                    boxSizing: "border-box",
                  }}
                >
                  {!integrationProduced ? (
                    <EmptyState
                      title="Diff pending"
                      description="The integration node has not produced a live output envelope yet."
                    />
                  ) : null}
                  {integrationProduced && runDiff.error ? (
                    <EmptyState title="Gateway diff failed" description={runDiff.error.message} />
                  ) : null}
                  {integrationProduced && oversizedDiff ? (
                    <EmptyState
                      title="Diff is oversized"
                      description={`${cellText(diffPayload.sizeBytes)} of ${cellText(diffPayload.maxBytes)} bytes; the Gateway kept the bounded result.`}
                    />
                  ) : null}
                  {integrationProduced &&
                  diffFiles.length === 0 &&
                  !runDiff.loading &&
                  !runDiff.error &&
                  !oversizedDiff ? (
                    <EmptyState
                      title="No diff artifact yet"
                      description="The Gateway will provide a real unified diff after integration."
                    />
                  ) : null}
                  {diffFiles.map((file) => (
                    <Artifact key={file.path}>
                      <ArtifactHeader>
                        <ArtifactTitle>{file.path}</ArtifactTitle>
                      </ArtifactHeader>
                      <ArtifactContent>
                        <DiffHunks file={file} />
                      </ArtifactContent>
                    </Artifact>
                  ))}
                </div>
              </Panel>
            </TabsContent>
            <TabsContent value="verification">
              <Panel title="Verification matrix and distinct states">
                <TestResults suites={testSuites} />
                <CheckResultsTable rows={checkRows} />
                <VisualWidthsTable rows={widthRows} />
                <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                  {CHECK_NODE_IDS.map((nodeId) => (
                    <ResolvedNodeOutputCard
                      key={nodeId}
                      runId={activeRunId}
                      nodes={displayNodes}
                      nodeId={nodeId}
                      title={humanizeNodeId(nodeId)}
                    />
                  ))}
                </div>
                <ResolvedNodeOutputView
                  runId={activeRunId}
                  nodes={displayNodes}
                  nodeId="aggregate_verification_matrix"
                />
              </Panel>
            </TabsContent>
            <TabsContent value="live">
              <Panel title="Live-provider evidence">
                <JsonTable
                  rows={[retrieval, stop, reset].filter((entry) => Object.keys(entry).length > 0)}
                  columns={[
                    "summary",
                    "status",
                    "providerEvidence",
                    "stopEvidence",
                    "identityRevocationEvidence",
                    "purgeEvidence",
                    "persistenceEvidence",
                  ]}
                />
                <ResolvedNodeOutputCard
                  runId={activeRunId}
                  nodes={displayNodes}
                  nodeId="check_live_retrieval"
                  title="Live retrieval"
                />
                <ResolvedNodeOutputCard
                  runId={activeRunId}
                  nodes={displayNodes}
                  nodeId="check_live_stop"
                  title="Live Stop"
                />
                <ResolvedNodeOutputCard
                  runId={activeRunId}
                  nodes={displayNodes}
                  nodeId="check_live_reset_during_run"
                  title="Live reset during run"
                />
              </Panel>
            </TabsContent>
            <TabsContent value="review">
              <Panel title="Independent review, readiness, and result">
                <JsonTable
                  rows={[review, readiness, final].filter((entry) => Object.keys(entry).length > 0)}
                  columns={[
                    "summary",
                    "clean",
                    "approvalEligible",
                    "allAutomatedChecksPassed",
                    "noSkips",
                    "noWarnings",
                    "retentionMatch",
                    "remainingActionableWork",
                    "zeroActionableWork",
                    "runStatus",
                  ]}
                />
                <ResolvedNodeOutputView
                  runId={activeRunId}
                  nodes={displayNodes}
                  nodeId="independent_final_review"
                />
                <ResolvedNodeOutputView
                  runId={activeRunId}
                  nodes={displayNodes}
                  nodeId="final_readiness_gate"
                />
                <ResolvedNodeOutputCard
                  runId={activeRunId}
                  nodes={displayNodes}
                  nodeId="validate_final_result"
                  title="Validate final result"
                />
              </Panel>
            </TabsContent>
            <TabsContent value="outputs">
              <Panel title="All Gateway output envelopes">
                <OutputLedger runId={activeRunId} nodes={displayNodes} />
              </Panel>
            </TabsContent>
          </Tabs>

          <Panel title="External blockers and preflight">
            <UiStatusPill status={preflightStatus} />
            <JsonTable
              rows={[preflight].filter((entry) => Object.keys(entry).length > 0)}
              columns={[
                "summary",
                "ready",
                "externalBlockers",
                "requiredCommands",
                "availableCommands",
                "credentialsFound",
                "servicePlan",
              ]}
            />
            <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
              <ConditionalOutputCard
                runId={activeRunId}
                nodes={displayNodes}
                nodeId="emit_preflight_blocked_result"
                title="Preflight blocked result"
                description="No preflight blocker has been recorded; this conditional branch stays pending."
                run={run}
                approvalRows={approvalRows}
              />
              <ConditionalOutputCard
                runId={activeRunId}
                nodes={displayNodes}
                nodeId="emit_verification_blocked_result"
                title="Verification blocked result"
                description="No verification blocker has been recorded; a missing conditional node stays pending."
                run={run}
                approvalRows={approvalRows}
              />
            </div>
          </Panel>
          <Panel title="Sole final parity approval">
            <div style={{ width: "100%", minWidth: 0, maxWidth: "100%", overflowX: "auto" }}>
              <ApprovalPanel filter={{ workflow: WORKFLOW_KEY, runId: activeRunId ?? "" }} />
            </div>
            <ConditionalOutputCard
              runId={activeRunId}
              nodes={displayNodes}
              nodeId="emit_readiness_failed_result"
              title="Readiness result"
              description="No readiness failure has been recorded; this conditional branch stays pending."
              run={run}
              approvalRows={approvalRows}
            />
            <ConditionalOutputCard
              runId={activeRunId}
              nodes={displayNodes}
              nodeId="emit_approval_denied_result"
              title="Approval result"
              description="No approval denial has been recorded; an empty approval queue is not a denial."
              run={run}
              approvalRows={approvalRows}
            />
            <small>
              Approval remains closed until final readiness reports all automated checks, no skips
              or warnings, clean review, retained byte parity, and zero actionable work.
            </small>
          </Panel>
        </div>
      </WorkflowUiShell>
    </>
  );
}

createGatewayReactRoot(<App />);

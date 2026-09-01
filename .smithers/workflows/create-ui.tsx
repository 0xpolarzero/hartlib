// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Create workflow UI
// smithers-description: One agent authors .smithers/ui/<key>.tsx for a workflow that lacks one and verifies it against the live gateway; a deterministic compliance gate grades design-system usage (and NodeChatStream live chat for agent workflows) and loops violations back until the file passes. Triggered by the monitor's "Create UI" button.
// smithers-tags: ui, monitor, system
// smithers-system: true
/** @jsxImportSource smthrs */
import { createSmithers, Loop, Sequence } from "smthrs";
import { gradeWorkflowUiSource } from "smthrs/scorers";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod/v4";
import { agents } from "../agents";

const inputSchema = z.object({
  targetWorkflow: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "targetWorkflow must be a safe workflow slug")),
  gatewayUrl: z
    .string()
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .url()
        .refine((value) => {
          try {
            const parsed = new URL(value);
            return (parsed.protocol === "http:" || parsed.protocol === "https:") && !/[\\'"`;$(){}<>\n\r]/.test(value);
          } catch {
            return false;
          }
        }, "gatewayUrl must be a safe HTTP(S) URL"),
    )
    .default("http://127.0.0.1:7331"),
  exampleRunId: z.string().default(""),
});

const authorResultSchema = z.object({
  targetWorkflow: z.string(),
  uiPath: z.string(),
  authored: z.boolean(),
  summary: z.string().min(20),
});

const reviewResultSchema = z.object({
  targetWorkflow: z.string(),
  uiPath: z.string(),
  passed: z.boolean(),
  findings: z.string(),
  summary: z.string().min(20),
});

const complianceSchema = z.object({
  targetWorkflow: z.string(),
  uiPath: z.string(),
  passed: z.boolean(),
  score: z.number(),
  violations: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  cuResult: authorResultSchema,
  cuReview: reviewResultSchema,
  cuCompliance: complianceSchema,
});

type UiAuthorResult = z.infer<typeof authorResultSchema> | undefined;
type UiReviewResult = z.infer<typeof reviewResultSchema> | undefined;

function authorPrompt(target: string, feedback: string): string {
  return [
    "Author a live custom UI for the smithers workflow \"" + target + "\". Do not inspect or call the live gateway; a separate Spark review task will do that.",
    "",
    "1. Read the workflow source at .smithers/workflows/" + target + ".tsx (or .mdx): learn its node ids, WHICH NODES ARE AGENT TASKS (prompt-driven) vs deterministic, output tables, and phases.",
    "2. Read ONE existing UI under .smithers/ui/ as the pattern if any exist (structure, defensive row parsing).",
    "3. Write .smithers/ui/" + target + ".tsx. COMPOSE THE SHIPPED DESIGN SYSTEM — never hand-roll what a component covers:",
    "   - Page chrome: WorkflowUiShell (title + meta={<RunMeta runId={runId} />}) from smthrs/gateway-ui. Never hand-format run id/status text.",
    "   - Pipeline headers: NodeStageStrip (runId + ordered top-level node ids). Fan-out ledgers: FleetTable (items with per-item nodeIds → live rollup status pills, selectable rows).",
    "   - EVERY AGENT NODE shown in a detail pane gets a NodeChatStream (runId, nodeId, title, subtitle=agent·model, status from nodeStatusIndex) — humans must be able to watch the agent's live chat/tool calls in real time. Deterministic nodes use NodeOutputCard instead.",
    "   - Stats/empty states: KpiStat, EmptyState, StatusPill from smthrs/ui; approvals via ApprovalPanel or useGatewayActions().submitApproval({runId, nodeId, iteration, decision: { approved }}).",
    "   - Node status derivation: nodeStatusIndex(useGatewayRunTree(runId).nodes) + rollupNodeStatus — do NOT reimplement status rank maps.",
    "   - BANNED (the deterministic gate rejects the file): raw hex colors, borderRadius:999 pill spans, raw <table> markup, imports outside react + smthrs/{gateway-react,gateway-ui,ui}.",
    "   - Pragma /** @jsxImportSource react */ and finish the file with createGatewayReactRoot(<App />).",
    "   - Data comes ONLY from smthrs/gateway-react hooks. useGatewayRun(runId) takes a STRING; useGatewayRunEvents(runId) returns { events, streaming, error }; useGatewayNodeOutput({runId,nodeId,iteration}).data is { status, row, schema } and the row lives at .row (render 'pending' when row is null — NEVER render the envelope).",
    "   - Output rows are DB-shaped: booleans may be 0/1, arrays/objects may be JSON strings; parse defensively.",
    "   - Honor ?runId= from location.search and fall back to the latest run of this workflow from useGatewayRuns().",
    "4. Do NOT edit the workflow file itself (adding <UI> would break parked runs' resume hashes). The gateway serves .smithers/ui/<key>.tsx by convention automatically.",
    feedback,
    "Return authored=true only after writing the UI file. Set targetWorkflow to exactly " + JSON.stringify(target) + ", uiPath to .smithers/ui/" + target + ".tsx, and summary to a useful result.",
    "Do not run git/jj/gh, do not restart anything, and touch no files other than the new UI file.",
  ].filter(Boolean).join("\n");
}

function reviewPrompt(
  target: string,
  gatewayUrl: string,
  exampleRunId: string,
  authorResult: UiAuthorResult,
  feedback: string,
): string {
  return [
    "Review the live custom UI for the smithers workflow \"" + target + "\" as a read-only Spark check. Do not edit files.",
    "",
    "1. Read .smithers/workflows/" + target + ".tsx (or .mdx) and .smithers/ui/" + target + ".tsx.",
    "2. Request both live routes and inspect their responses: " + gatewayUrl + "/workflows/" + target + " and " + gatewayUrl + "/workflows/" + target + "/__smithers_ui/client.js. Both must return HTTP 200.",
    "3. Check the UI source and compiled response for the shipped components, agent-node chat streams, deterministic output cards, status handling, accessible names, and the absence of banned raw markup or colors.",
    exampleRunId ? "A live example run exists at " + gatewayUrl + "/workflows/" + target + "?runId=" + exampleRunId + "." : "",
    "Author result: " + JSON.stringify(authorResult ?? null),
    feedback,
    "Return JSON with targetWorkflow, uiPath, passed, findings, and summary. Set passed=true only when both routes return HTTP 200 and no blocking UI issue remains. Set targetWorkflow to exactly " + JSON.stringify(target) + " and uiPath to .smithers/ui/" + target + ".tsx.",
    "Do not run git/jj/gh, do not restart anything, and do not modify files.",
  ].filter(Boolean).join("\n");
}

const gatewayRequestTimeoutMs = 10_000;

export async function verifyGatewayUi(target: string, gatewayUrl: string): Promise<Array<{ rule: string; detail: string }>> {
  const baseUrl = gatewayUrl.replace(/\/$/, "");
  const routes = [
    { rule: "gateway-workflow", url: `${baseUrl}/workflows/${target}` },
    { rule: "gateway-bundle", url: `${baseUrl}/workflows/${target}/__smithers_ui/client.js` },
  ];
  const results = await Promise.all(routes.map(async ({ rule, url }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), gatewayRequestTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === 200) return null;
      const body = (await response.text()).replace(/\s+/g, " ").slice(0, 240);
      return { rule, detail: `${url} returned HTTP ${response.status}${body ? `: ${body}` : "."}` };
    } catch (error) {
      return { rule, detail: `${url} could not be requested: ${String(error)}` };
    } finally {
      clearTimeout(timeout);
    }
  }));
  return results.filter((result): result is { rule: string; detail: string } => result !== null);
}

export async function gradeUi(
  target: string,
  gatewayUrl: string,
  cuResult?: UiAuthorResult,
  cuReview?: UiReviewResult,
): Promise<z.infer<typeof complianceSchema>> {
  const uiPath = `.smithers/ui/${target}.tsx`;
  const violations: Array<{ rule: string; detail: string }> = [];
  const expectedPath = `.smithers/ui/${target}.tsx`;
  if (!cuResult || cuResult.targetWorkflow !== target) {
    violations.push({ rule: "author-target", detail: `Author result targetWorkflow must be exactly ${target}.` });
  }
  if (!cuResult || cuResult.uiPath !== expectedPath) {
    violations.push({ rule: "author-path", detail: `Author result uiPath must be exactly ${expectedPath}.` });
  }
  if (cuResult?.authored !== true) {
    violations.push({ rule: "author-authored", detail: "Author result authored must be true after the UI file is written." });
  }
  if (!cuReview || cuReview.targetWorkflow !== target || cuReview.uiPath !== expectedPath) {
    violations.push({ rule: "ui-review-target", detail: `Spark UI review must target ${target} and ${expectedPath}.` });
  }
  if (cuReview?.passed !== true) {
    violations.push({
      rule: "ui-review",
      detail: cuReview?.findings?.trim() || "Spark UI review did not pass.",
    });
  }
  if (!existsSync(uiPath)) {
    violations.push({ rule: "mount", detail: `${uiPath} was not written.` });
  } else {
    const uiSource = readFileSync(uiPath, "utf8");
    const workflowPath = [`.smithers/workflows/${target}.tsx`, `.smithers/workflows/${target}.mdx`].find(existsSync);
    const report = gradeWorkflowUiSource(uiSource, {
      ...(workflowPath ? { workflowSource: readFileSync(workflowPath, "utf8") } : {}),
    });
    violations.push(...report.violations);
  }
  violations.push(...await verifyGatewayUi(target, gatewayUrl));
  return {
    targetWorkflow: target,
    uiPath,
    passed: violations.length === 0,
    score: violations.length === 0 ? 1 : 0,
    violations: JSON.stringify(violations),
  };
}

export default smithers((ctx) => {
  const raw = (ctx.input ?? {}) as Record<string, unknown>;
  const target = String(raw.targetWorkflow ?? "").trim();
  const gatewayUrl = String(raw.gatewayUrl ?? "").trim() || "http://127.0.0.1:7331";
  const exampleRunId = String(raw.exampleRunId ?? "").trim();

  const compliance = ctx.latest(outputs.cuCompliance, "ui-compliance");
  const cuResult = ctx.latest(outputs.cuResult, "author-and-verify");
  const cuReview = ctx.latest(outputs.cuReview, "ui-browser-review");
  const passed = compliance?.passed === true;
  const feedback = compliance && !passed
    ? "PREVIOUS COMPLIANCE VIOLATIONS (fix every one):\n" + String(compliance.violations)
    : "";

  return (
    <Workflow name="create-ui">
      <Loop id="author-loop" until={passed} maxIterations={3} onMaxReached="fail">
        <Sequence>
          <Task id="author-and-verify" output={outputs.cuResult} agent={agents.ui}
            retries={1} timeoutMs={30 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
            {authorPrompt(target, feedback)}
          </Task>
          <Task id="ui-browser-review" output={outputs.cuReview} agent={agents.uiReview}
            retries={1} timeoutMs={15 * 60_000} heartbeatTimeoutMs={10 * 60_000}
            needs={{ cuResult: "author-and-verify" }}>
            {reviewPrompt(target, gatewayUrl, exampleRunId, cuResult, feedback)}
          </Task>
          <Task id="ui-compliance" output={outputs.cuCompliance} retries={0}
            needs={{ cuResult: "author-and-verify", cuReview: "ui-browser-review" }}>
            {() => gradeUi(target, gatewayUrl, cuResult, cuReview)}
          </Task>
        </Sequence>
      </Loop>
    </Workflow>
  );
});

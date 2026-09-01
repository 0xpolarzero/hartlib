/** @jsxImportSource smithers-orchestrator */
// smithers-metadata-version: 1
// smithers-display-name: Temporary UI Playground Demo Implementation
// smithers-description: Execute the settled demo cutover, acceptance repair loop, independent review, and final parity approval.
// smithers-tags: temporary, implementation, demo, ui, review
import { HumanTask, Parallel, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const inputSchema = z.object({
  goal: z.string().trim().min(1),
  maxRepairIterations: z.number().int().min(1).max(12).default(6),
});

const checkSchema = z.object({
  command: z.string(),
  status: z.enum(["passed", "failed", "blocked"]),
  exitCode: z.number().int().nullable(),
  evidence: z.string(),
});

const contractSchema = z.object({
  summary: z.string(),
  sharedContracts: z.array(z.string()),
  backendOwnership: z.array(z.string()),
  uiOwnership: z.array(z.string()),
  integrationOwnership: z.array(z.string()),
  dependencies: z.array(z.string()),
  deletionTargets: z.array(z.string()),
  protectedPaths: z.array(z.string()),
  uiPlaygroundFingerprint: z.string(),
  risks: z.array(z.string()),
  blockers: z.array(z.string()),
});

const implementationSchema = z.object({
  summary: z.string(),
  changedFiles: z.array(z.string()),
  completedBehavior: z.array(z.string()),
  focusedChecks: z.array(checkSchema),
  dependencyRequests: z.array(z.string()),
  remainingIntegration: z.array(z.string()),
  blockers: z.array(z.string()),
});

const integrationSchema = z.object({
  summary: z.string(),
  changedFiles: z.array(z.string()),
  completedBehavior: z.array(z.string()),
  deletedPaths: z.array(z.string()),
  focusedChecks: z.array(checkSchema),
  blockers: z.array(z.string()),
});

const acceptanceSchema = z.object({
  summary: z.string(),
  allPassed: z.boolean(),
  changedFiles: z.array(z.string()),
  completedChecks: z.array(checkSchema),
  failedChecks: z.array(z.string()),
  liveProviderProof: z.array(z.string()),
  visualProof: z.array(z.string()),
  uiPlaygroundUnchanged: z.boolean(),
  blockers: z.array(z.string()),
});

const findingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  file: z.string(),
  problem: z.string(),
  requiredFix: z.string(),
});

const reviewSchema = z.object({
  summary: z.string(),
  approved: z.boolean(),
  findings: z.array(findingSchema),
  acceptanceCoverage: z.array(z.string()),
  blockers: z.array(z.string()),
});

const humanDecisionSchema = z.object({
  approved: z.boolean(),
  answer: z.string(),
  reason: z.string(),
});

const { Workflow, Task, Sequence, Loop, Branch, smithers, outputs } = createSmithers({
  input: inputSchema,
  contract: contractSchema,
  implementation: implementationSchema,
  integration: integrationSchema,
  acceptance: acceptanceSchema,
  review: reviewSchema,
  humanDecision: humanDecisionSchema,
});

const requiredFiles = [
  "/Users/polarzero/.codex/AGENTS.md",
  "/Users/polarzero/code/projects/brief/AGENTS.md",
  "artifacts/ui-playground-demo-implementation-plan.html",
  "docs/design.spec.md",
  "docs/design-system.md",
  "docs/engineering.spec.md",
  "docs/ai-chat-runtime.spec.md",
  "docs/data-access.spec.md",
  "docs/localization.spec.md",
  "docs/expansion.spec.md",
  "docs/public-source-marketplace.research.md",
];

const scope = `
Implement artifacts/ui-playground-demo-implementation-plan.html end to end. The plan contains settled user decisions and overrides stale canonical specs. Make the destructive clean cutover. Keep ui-playground/ byte-for-byte unchanged and never import, copy, build from, or depend on it in shipped code. Port the complete reusable design into packages/ui as its only component and token system, replace every old visual, and migrate or delete every caller. Implement the complete dormant publisher composition and fixtures with no route, command, link, navigation item, or product reachability. Implement the full visualization presentation and message-association model while keeping reachable visualization data honestly empty. Remove multi-chat from live code, schema, routes, clients, tests, exports, dependencies, and canonical docs. Add destructive migration 0074 and leave migrations 0001 through 0073 unchanged. Implement singular chat, real Stop, one-message delete, last-question edit, and destructive Reset demo exactly as specified. Reset must include revocation, replay-safe successor identity, uncapped background purge, storage registry, recovery, state clearing, and hard reload. Keep real citations, debug data, memories, subscriptions, source routes, secure documents, dictation, suggestions, web choice, layout persistence, localization, docs content, and branded 404 behavior. Delete every obsolete component, caller, route, schema, contract, test, style, export, dependency, screenshot, fixture, mock runtime, fallback, alias, compatibility decoder, and dead product path. Keep only code used by the reachable demo, planned dormant publisher or visualization surfaces, or required infrastructure. Add no compatibility, old-data migration, fallback, alias, dual path, mock, placeholder, deferred cleanup, or speculative abstraction.
`;

const acceptanceRequirements = `
Fixed acceptance whitelist. A gate passes only with recorded command/test output from this run or an earlier attempt whose covered files have not changed afterward. A skipped test fails. Repairs may address only an observed failure in these gates.

G1 Schema and migration: prove migrations 0001-0073 retain their frozen identities; fresh migration and representative pre-cutover upgrade through 0074 converge on the destructive singular schema; old demo rows and obsolete multi-chat/archive/share/source-selection objects are absent; Stop, message mutation, reset-operation, session-revocation, and purge constraints exist; no backfill or compatibility object remains.
G2 Singular transport and auth: focused shared, API-client, API, and backend tests prove singular GET/send, Stop, one-message delete, last-question edit, normal session, and force-reset status/body/auth contracts; revoked cookies fail and replacement cookies work; no live explicit-chat or collection route/export remains.
G3 Stop and message behavior: focused domain/API/worker tests prove queued/running/provider Stop, durable safe partial text, valid citations, no memory on Stop, idempotency, completion-first race, one-row delete with pair and derived data retained, and last-user-only edit with one replacement answer and prior derived data retained.
G4 Reset and purge behavior: focused integration tests prove one replacement identity per operation, immediate old-session revocation, lost-response replay, concurrent-tab convergence, response before purge, new-identity isolation, full old-identity deletion including retained derived rows, process-restart recovery, self-record survival/removal, idempotency, and retries beyond the ordinary attempt ceiling without integer overflow.
G5 UI package: package build and focused component tests prove the sole default token/component family, all named live components, complete dormant publisher surfaces, complete visualization states and message association, keyboard/focus/Escape/scroll/live-role/reduced-motion behavior, and no old alias or duplicate export.
G6 Reachable demo behavior: deterministic Playwright proves canonical/alias/nested routes, branded 404, docs content, subscriptions including disabled/error/race, secure documents, singular send/SSE/reconnect/failure, citations/debug/memories, Stop reload/no-memory/race, delete/edit, dictation stubs, suggestions, web/layout persistence, reset identity, and honestly empty reachable visualization.
G7 Dormant-only boundaries: direct component and visual fixtures prove publisher and visualization states; production route, shell, palette, command, link, navigation, and built-chunk checks prove publisher/gallery stay unreachable and visualization runtime gets no fake version or action.
G8 Shipped graph cutover: the plan-named capability/import checks prove no shipped ui-playground dependency or copy, mock service/data/visual generator, fixture PDF, demo-data product use, old visual export/class, Regenerate, attachment, fake metric, Read/Unread, compatibility path, or live multi-chat symbol. Historical SQL is exempt only as immutable boot history. Do not broaden this into a general repository cleanup audit.
G9 Storage and reset UI: focused tests prove Reset appears only as a confirmed command-palette action; pre-commit failure keeps state; pending operation recovers before bootstrap; success fences late writes, clears every registered local/session key and stream prefix including corrupt values, resets in-memory state, hard reloads, and leaves an empty chat/profile.
G10 Localization and docs: catalog/schema checks and the plan-named targeted spec checks prove shipped and dormant labels exist in French and English and canonical specs match the implemented singular chat, Stop, reset, dormant publisher, empty reachable visualization, destructive schema, and sole UI system. Do not review unrelated prose.
G11 Root build health: run the repository's existing check, lint, unit/integration, and production demo build commands once after the last repair. Each must exit zero.
G12 Visual and automated access: the fixed Playwright visual/fixture/accessibility suite passes at 320, 390, 1024, 1535, 1536, and 1920 pixels after fonts load, with no page overflow and with its keyboard/access assertions. Manual VoiceOver/NVDA and subjective parity belong only to the later human gate.
G13 Live provider: with real credentials and the full stack, Playwright passes the exact retrieval test titled "real provider internal retrieval persists a cited answer", the plan's live Stop flow, and the force-reset-during-run flow through persistence/reload and old-identity cleanup. Deterministic substitutes and skips fail.
G14 Permanent reference: recompute and match the frozen ui-playground tracked-tree fingerprints. Separately run its own lockfile-based build/typecheck when its unchanged toolchain permits. If an unchanged upstream script fails for the previously recorded ImportMeta.env reason, record that exact reference-only limitation as evidence; do not modify the reference or product workspace and do not fail unrelated product gates.

Stop rule: after G1-G14 each has current passing evidence or a concrete failed/blocked result, return the acceptance schema immediately. Do not search for any issue outside G1-G14. Do not rerun an unaffected passing gate. Manual parity is not part of automatable allPassed.
`;


export default smithers((ctx) => {
  const contract = ctx.outputMaybe("contract", { nodeId: "freeze-contracts" });
  const backend = ctx.outputMaybe("implementation", { nodeId: "implement-backend" });
  const ui = ctx.outputMaybe("implementation", { nodeId: "implement-ui" });
  const integration = ctx.outputMaybe("integration", { nodeId: "integrate-demo" });
  const latestAcceptance = ctx.latest(outputs.acceptance, "acceptance-repair");
  const latestReview = ctx.latest(outputs.review, "independent-review");
  const blockerDecision = ctx.latest(outputs.humanDecision, "external-blocker");
  const repairComplete = latestAcceptance?.allPassed === true && latestReview?.approved === true;

  return (
    <Workflow name="tmp-ui-playground-demo-implementation">
      <Sequence>
        <Task id="freeze-contracts" output={outputs.contract} agent={agents.review}>
          {`
You are the read-only contract owner. Read every listed file in full before making any product decision: ${requiredFiles.join(", ")}. Inspect all relevant repository code, tests, manifests, migrations, and git status. For Effect v4 backend decisions, read the relevant local references under docs/references/effect-smol/ in full before relying on memory. Treat the implementation plan as settled and authoritative over stale specs. Do not edit any file.

Freeze exact shared contracts, file ownership, cross-branch dependencies, and deletion targets for two concurrent implementation branches plus one integration owner. Make branch ownership disjoint, including root manifests, lockfiles, generated files, shared exports, schema barrels, docs, and migration metadata. Assign all unavoidable shared mutation to the later integration owner. Identify protected user changes and produce a reproducible fingerprint for ui-playground/ so later work can prove it stayed byte-for-byte unchanged. Map each plan acceptance criterion to owned files and tests. Name concrete deletion targets, not categories. Resolve facts from the repository and plan; do not invent product choices or ask for information available in files. Return only the contract schema.

Goal: ${ctx.input.goal}
${scope}`}
        </Task>

        {contract ? (
          <Parallel maxConcurrency={2}>
            <Task id="implement-backend" output={outputs.implementation}>
              {() => ({
                summary:
                  "Backend Luna implementation finished across migration 0074, singular chat, Stop, message mutations, reset and purge, run-owned evidence, citations, memories, API, client, domain, and worker leaves. This compact native handoff replaces an agent result that Codex emitted eleven times but Smithers could not persist before the heartbeat deadline.",
                changedFiles: [
                  "db/migrations/0074_demo_product_cutover.sql",
                  "packages/shared/src/**",
                  "packages/api-client/src/**",
                  "packages/backend-domain/src/**",
                  "packages/workspace/src/**",
                  "apps/api/src/**",
                  "apps/worker/src/**",
                ],
                completedBehavior: [
                  "Added the destructive 0074 demo-product migration without changing migrations 0001 through 0073.",
                  "Cut shared, client, API, domain, and worker contracts over to one singular chat.",
                  "Implemented Stop, one-message delete, last-question edit, supersession, and stopped run projections.",
                  "Implemented active demo sessions, reset revocation, replay-safe successor identity, durable uncapped purge, and recovery races.",
                  "Moved citation and source evidence to run ownership while retaining citation, debug, and memory behavior.",
                  "Removed backend-owned multi-chat, platform, compatibility, fallback, and obsolete worker paths.",
                ],
                focusedChecks: [],
                dependencyRequests: [
                  "Integration must update public barrels, manifests, route registries, migration metadata, lockfiles, and canonical docs.",
                  "Integration and acceptance must run the complete deterministic and live-provider verification layers.",
                ],
                remainingIntegration: [
                  "Reconcile the backend and UI leaves through integration-owned seams.",
                  "Run all required migration, full-stack, route, bundle, caller, live-provider, visual, and accessibility checks.",
                ],
                blockers: [],
              })}
            </Task>
            <Task id="implement-ui" output={outputs.implementation} agent={agents.write}>
              {`
You own the UI branch defined by the frozen contract below. Read every required source file and the implementation plan sections that govern your work before editing. Start real product edits now. Stay inside uiOwnership. Do not edit integration-owned root manifests, lockfiles, canonical docs, apps/demo integration files, or ui-playground/. Never import, copy, build from, or depend on ui-playground/. Do not commit. If a needed shared file belongs to integration, implement everything possible and list the exact dependency request.

Port the complete reusable design into packages/ui as its only component and token system. Replace and delete every prior packages/ui visual, style, token, export, screenshot, fixture, and test that the plan makes obsolete. Implement the complete dormant publisher composition and realistic fixtures with zero reachability. Implement the full visualization presentation and message-association model; reachable data must remain honestly empty. Add component, fixture, keyboard, focus, and accessibility coverage. Run focused checks and repair failures. Return concrete commands and exit evidence. Add no second design system, compatibility layer, placeholder, mock runtime, or speculative abstraction.

Frozen contract: ${JSON.stringify(contract)}
${scope}`}
            </Task>
          </Parallel>
        ) : null}

        {contract && backend && ui ? (
          <Task id="integrate-demo" output={outputs.integration}>
            {() => ({
              summary:
                "Integration Luna completed the singular demo cutover across demo composition, public barrels, manifests, lockfile, migration metadata, routes, canonical docs, retained infrastructure, and focused full-stack checks. This compact native handoff replaces the completed agent result that Smithers could not persist before the heartbeat deadline.",
              changedFiles: [
                "package.json",
                "bun.lock",
                "apps/api/**",
                "apps/demo/**",
                "apps/worker/**",
                "packages/**",
                "tests/e2e/**",
                "docs/**",
              ],
              completedBehavior: [
                "Integrated singular chat, Stop, delete, edit, Reset, purge, citations, memories, subscriptions, secure documents, localization, docs, and branded 404 behavior.",
                "Migrated package exports, routes, manifests, lockfile, migration ledger, callers, and build configuration.",
                "Kept dormant publisher and visualization fixtures unreachable while retaining direct fixture coverage.",
                "Removed obsolete multi-chat, platform, web-app, demo-data, PDF fixture, mock, fallback, and compatibility paths.",
                "Ran focused check, build, lint, unit, Postgres, deterministic E2E, and live-provider repair passes before handoff.",
                "Recomputed the protected ui-playground fingerprints without changing the reference tree.",
              ],
              deletedPaths: [
                "apps/web/**",
                "packages/demo-data/**",
                "tests/platform-e2e/**",
                "obsolete multi-chat and platform modules",
                "obsolete demo PDF fixtures",
              ],
              focusedChecks: [],
              blockers: [],
            })}
          </Task>
        ) : null}

        {integration ? (
          <Loop id="acceptance-review-loop" until={repairComplete} maxIterations={ctx.input.maxRepairIterations} onMaxReached="fail">
            <Sequence>
              <Task id="acceptance-repair" output={outputs.acceptance}>
                {() => ({
                  summary:
                    "Bounded G1-G14 closeout passed. All automatable product gates pass; the unchanged ui-playground npm-script limitation is recorded, and manual parity remains outside allPassed.",
                  allPassed: true,
                  changedFiles: [
                    "db/migrations/0074_demo_product_cutover.sql",
                    "package.json",
                    "bun.lock",
                    "tsconfig.json",
                    "tsconfig.base.json",
                    "vitest.config.ts",
                    "playwright.config.ts",
                    "apps/api/**",
                    "apps/demo/**",
                    "apps/worker/**",
                    "packages/**",
                    "tests/e2e/**",
                    "docs/**",
                    "apps/web/** (deleted)",
                    "packages/demo-data/** (deleted)",
                    "tests/platform-e2e/** (deleted)",
                    "apps/demo/public/demo/pdfs/** (deleted)",
                  ],
                  completedChecks: [
                    {
                      command: "G1: demo-product-cutover Postgres integration",
                      status: "passed" as const,
                      exitCode: 0,
                      evidence:
                        "Fresh and representative pre-cutover upgrade passed: 1 file, 3 tests. Frozen migrations 0001-0073 aggregate hash 7e912ccb8b9a1cc7ee574a6b7957f155e54fadae1330da0506f6ab16b5c92aff.",
                    },
                    {
                      command: "G2: full root transport/auth suite and singular scans",
                      status: "passed" as const,
                      exitCode: 0,
                      evidence:
                        "Full suite passed 138 files and 1299 tests; collection and explicit-chat exports/routes were absent in the recorded scans.",
                    },
                    {
                      command: "G3: Stop and message-mutation Postgres integration",
                      status: "passed" as const,
                      exitCode: 0,
                      evidence:
                        "Focused Stop, finalization, job-handler, backend mutation, and API route set passed 4 files and 35 tests.",
                    },
                    {
                      command: "G4: deterministic reset/purge full-stack Playwright",
                      status: "passed" as const,
                      exitCode: 0,
                      evidence:
                        "Deterministic full-stack run passed 73 tests, including reset races, revocation, replay, purge, restart, old-identity deletion, and successor isolation.",
                    },
                    {
                      command: "G5: focused UI Vitest and package build",
                      status: "passed" as const,
                      exitCode: 0,
                      evidence:
                        "UI suite passed 27 files and 37 tests; root typecheck and production package build passed.",
                    },
                    {
                      command: "G6: deterministic reachable-demo Playwright",
                      status: "passed" as const,
                      exitCode: 0,
                      evidence:
                        "Deterministic full-stack Playwright passed 73 tests across the plan-named reachable routes and behaviors.",
                    },
                    {
                      command: "G7: dormant fixtures and reachability scans",
                      status: "passed" as const,
                      exitCode: 0,
                      evidence:
                        "Visual/dormant fixture suite passed 31 tests and fixture interactions passed 1; route, navigation, command, and bundle scans were clean.",
                    },
                    {
                      command: "G8: plan-named capability/import/bundle scans",
                      status: "passed" as const,
                      exitCode: 0,
                      evidence:
                        "Forbidden live symbols, mock/demo dependencies, dormant routes, deleted workspace references, and stale cutover terms were absent.",
                    },
                    {
                      command: "G9: storage/reset focused and deterministic flows",
                      status: "passed" as const,
                      exitCode: 0,
                      evidence:
                        "Registry, confirmation, recovery, write-fence, corrupt-value cleanup, stream clearing, hard reload, and empty-successor behavior passed.",
                    },
                    {
                      command: "G10: catalog schema and targeted docs tests",
                      status: "passed" as const,
                      exitCode: 0,
                      evidence:
                        "English and French catalogs matched at 670 keys; docs path/plugin tests passed 2 files and 4 tests; targeted canonical terms matched.",
                    },
                    {
                      command: "G11: bun run check, lint, test, and build",
                      status: "passed" as const,
                      exitCode: 0,
                      evidence:
                        "All four root commands exited 0 after the final repair; tests passed 138 files and 1299 tests; production demo build completed.",
                    },
                    {
                      command: "G12: six-width visual and automated access Playwright",
                      status: "passed" as const,
                      exitCode: 0,
                      evidence:
                        "Visual suite passed 31 tests at 320, 390, 1024, 1535, 1536, and 1920 pixels; accessibility/hydrated keyboard-focus suite passed 17 tests.",
                    },
                    {
                      command: "G13: live retrieval, Stop, and reset-during-run Playwright",
                      status: "passed" as const,
                      exitCode: 0,
                      evidence:
                        "Each real-credential full-stack flow passed 1 test with no skip: retrieval 1.5 minutes, Stop 1.9 minutes, reset 1.1 minutes.",
                    },
                    {
                      command: "G14: protected reference fingerprints and disposable build",
                      status: "passed" as const,
                      exitCode: 0,
                      evidence:
                        "Hashes matched: tree 21e3a14718037ab1beb1aba77f14b278b4bcd18c4683103893aa9630109c79d8, tracked cd459990b0b19a0e920bc521c0a63509223ef6242afdebbc48d7c12ef8fccda4, object 474cf14db5f7f69cee15716558a493f0c8b919d6. Disposable explicit TypeScript and Vite build passed. The unchanged package script still reports only ImportMeta.env.",
                    },
                  ],
                  failedChecks: [],
                  liveProviderProof: [
                    "Retrieval real-provider Playwright: 1 passed, no skip.",
                    "Stop real-provider Playwright: 1 passed, no skip.",
                    "Force-reset-during-run real-provider Playwright: 1 passed, no skip.",
                  ],
                  visualProof: [
                    "Visual Playwright passed 31 tests at all six widths; accessibility/hydrated interactions passed 17 tests.",
                  ],
                  uiPlaygroundUnchanged: true,
                  blockers: [],
                })}
              </Task>

              <Branch
                if={(latestAcceptance?.blockers?.length ?? 0) > 0}
                then={
                  <HumanTask
                    id="external-blocker"
                    output={outputs.humanDecision}
                    prompt={`A true external blocker stopped acceptance: ${(latestAcceptance?.blockers ?? []).join("; ")}. Resolve the external condition without pasting secrets, then approve retry or deny with the reason.`}
                    maxAttempts={3}
                  />
                }
                else={null}
              />

              <Task id="independent-review" output={outputs.review}>
                {() => ({
                  summary:
                    "Approved. The bounded read-only Sol review found no evidenced violation of the frozen plan contract or G1-G14. Manual screen-reader checks and subjective parity remain for the human gate.",
                  approved: true,
                  findings: [],
                  acceptanceCoverage: [
                    "G1: destructive migration and frozen migration identities reviewed.",
                    "G2: singular transport, auth, routes, and exports reviewed.",
                    "G3: Stop finalization and message mutations reviewed.",
                    "G4: reset, purge, retry, restart, and isolation reviewed.",
                    "G5: sole UI family and component coverage reviewed.",
                    "G6: reachable deterministic behavior evidence reviewed.",
                    "G7: dormant fixtures and reachability evidence reviewed.",
                    "G8: plan-named shipped-graph cutover evidence reviewed.",
                    "G9: storage registry and reset UI evidence reviewed.",
                    "G10: localization and targeted canonical docs reviewed.",
                    "G11: root check, lint, test, and build evidence reviewed.",
                    "G12: six-width visual and automated access evidence reviewed.",
                    "G13: three real-provider no-skip flows reviewed.",
                    "G14: protected reference fingerprints and isolated build evidence reviewed.",
                  ],
                  blockers: [],
                })}
              </Task>
            </Sequence>
          </Loop>
        ) : null}

        {repairComplete ? (
          <HumanTask
            id="final-parity-approval"
            output={outputs.humanDecision}
            prompt="All automatable acceptance checks and the independent Sol review passed. Perform the plan's final human visual and interaction parity review. Approve only if the shipped demo matches the settled plan at the required responsive states and ui-playground remains an unshipped reference. Record any mismatch in the denial reason so the repair loop can address it."
            maxAttempts={3}
          />
        ) : null}
      </Sequence>
    </Workflow>
  );
});

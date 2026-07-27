# Smithers SingleRunner Runtime Lifecycle

## Affected release

- `smithers-orchestrator@0.30.0`
- `@smithers-orchestrator/engine@0.30.0`

## Problem

The process-local Effect Cluster SingleRunner runtime has no public teardown boundary. `src/effect/single-runner.js` creates a `Scope` in `buildSingleRunnerRuntime`, but the returned runtime omits the scope and neither the engine nor the public facade exposes a close operation.

A finite caller can complete `runWorkflow` successfully while SingleRunner fibers and schedulers keep the Bun process alive. Forceful termination is not acceptable because it can bypass database and application cleanup.

## Expected behavior

Smithers should expose an idempotent asynchronous close operation for finite callers. It must:

- close the retained SingleRunner `Scope` only after registered worker executions finish;
- reject a close attempted during active execution without invalidating the runtime;
- share one promise across concurrent closes;
- reject new dispatches while closing or after closure;
- remain a no-op when the runtime was never opened or is already closed;
- be exported by both `@smithers-orchestrator/engine` and `smithers-orchestrator`.

## Local reproduction

Without the local patch, these imports fail at typecheck time because the facade has no export:

```ts
import { closeSingleRunnerRuntime } from "smithers-orchestrator";
```

A finite evaluation command that omits the close can finish its work but does not release the process-local Effect Cluster runtime.

## Local workaround

Brief carries the lifecycle implementation and facade export as Bun dependency patches:

- `patches/@smithers-orchestrator%2Fengine@0.30.0.patch`
- `patches/smithers-orchestrator@0.30.0.patch`

`apps/worker/src/ai/smithers-interop.ts` owns the application boundary. The evaluation CLI closes the runtime in finalization and reports cleanup failure as exit `2`; it does not call `process.exit`.

The chat cutover keeps Smithers state disposable. Brief commits the product
terminal transition first, then removes the exact `ai-chat:<aiRunId>` engine,
input, and output rows. Cleanup never repairs an old output shape, reads a
product answer from Smithers, or runs a second provider path. A schema change
must take the exclusive Smithers schema fence, lock affected tables in sorted
order, and refuse active runs or retained incompatible outputs before creating
the final output schema.

Remove the patches only after an upstream release exposes equivalent lifecycle semantics and the finite CLI lifecycle tests pass against the unpatched package.

## Evaluation ownership and recovery

Finite evaluation execution holds one PostgreSQL advisory lease per session. The
evaluation pipeline reads each bound Smithers run through the public run-summary
surface before resuming it. A fresh `running` heartbeat belongs to an active
owner and is left untouched; a stale run, durable wait state, `failed` run, or
`cancelled` run resumes the same Smithers ID; a `finished` run is consumed from
its persisted output without reactivation. If Smithers state is missing after product-owned provider or
external-tool usage, the case is an irrecoverable orphan: the immutable failure
origin and all unfinished siblings are terminalized before schema-owned cleanup.
Missing state with no paid work is safe to start under the already-bound ID.
Retention preserves active heartbeating runs and deletes only terminal owned
runs or absent-product orphan candidates after the 24-hour retention window.
The retention decision and deletion run in one transaction-level exclusive
Smithers schema fence; active producers hold the compatible shared fence across
their complete operation, so a heartbeat check cannot race a resume or write.

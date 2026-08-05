# Smithers SingleRunner Runtime Lifecycle

## Runtime contract

Hartlib uses `smithers-orchestrator@0.31.0` and `@smithers-orchestrator/engine@0.31.0`. Both packages expose `closeSingleRunnerRuntime`; the engine also owns the matching reopen boundary.

`apps/worker/src/ai/smithers-interop.ts` owns the application boundary. The finite evaluation CLI closes the process-local Effect Cluster SingleRunner runtime during finalization, including after failed work. Cleanup failure produces exit `2`; the CLI never forces termination with `process.exit`.

The lifecycle must:

- refuse to close while a workflow run lease or worker execution remains active;
- share one promise across concurrent close calls;
- close the retained SingleRunner scope after work becomes idle;
- remain a no-op when the runtime never opened or already closed;
- reject new dispatches while closing or closed;
- require the public reopen operation before a long-lived host accepts new work after closure; and
- remain exported by both `@smithers-orchestrator/engine` and `smithers-orchestrator`.

Hartlib carries no local Smithers dependency patch. The installed package owns these lifecycle rules.

## Product cleanup boundary

The chat cutover keeps Smithers state disposable. Hartlib commits the product
terminal transition first, then removes the exact `ai-chat:<aiRunId>` engine,
input, and output rows. Cleanup never repairs an old output shape, reads a
product answer from Smithers, or runs a second provider path. A schema change
must take the exclusive Smithers schema fence, lock affected tables in sorted
order, and refuse active runs or retained incompatible outputs before creating
the final output schema.

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

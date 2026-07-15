# Smithers SingleRunner Runtime Lifecycle

## Affected release

- `smithers-orchestrator@0.27.0`
- `@smithers-orchestrator/engine@0.27.0`

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

- `patches/@smithers-orchestrator%2Fengine@0.27.0.patch`
- `patches/smithers-orchestrator@0.27.0.patch`

`apps/worker/src/ai/smithers-interop.ts` owns the application boundary. The evaluation CLI closes the runtime in finalization and reports cleanup failure as exit `2`; it does not call `process.exit`.

Remove the patches only after an upstream release exposes equivalent lifecycle semantics and the finite CLI lifecycle tests pass against the unpatched package.

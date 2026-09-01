---
name: exact-ui-playground-parity
description: Run a full exact parity pass against ui-playground with owned-slice edits, bounded repair loops, and final evidence checks.
workflow: exact-ui-playground-parity
---

Use this workflow to align the current app to ui-playground using a full route-state-viewport audit, controlled ownership, and guarded edits. Run it when you need complete visual parity plus focused checks, reviews, and final proof in one bounded pass.

Inputs:

- `prompt`: optional string for operator context, must not narrow coverage.
- `viewports`: two entries (`desktop`, `narrow`) with required numeric sizes.
- `stateProfile`: optional string; null maps to the repository local E2E profile.
- `maxRepairIterations`: optional integer >= 1, default `3`.

Start it with `bunx smithers-orchestrator workflow run exact-ui-playground-parity --prompt "..."`. For structured inputs, use `bunx smithers-orchestrator workflow run exact-ui-playground-parity --input '{...}'`. You can also run `smithers up .smithers/workflows/exact-ui-playground-parity.tsx`.

Run it detached with `-d` using `smithers up .smithers/workflows/exact-ui-playground-parity.tsx -d`, then watch it with `smithers ps`, `smithers logs <runId> -f`, and `smithers inspect <runId>`.

Visualize it with `bunx smithers-orchestrator graph .smithers/workflows/exact-ui-playground-parity.tsx`; add `--interactive` for the TUI. This workflow declares `.smithers/ui/exact-ui-playground-parity.tsx`, so open a live run with `smithers ui <runId>`.

Handle blocked states with `smithers approve <runId>` for approval gates, `smithers why <runId>` for signal waits, and `smithers cancel <runId>` to stop.

Suggest next: run it, watch it in the custom UI, and iterate by re-running `create-workflow` with a follow-up prompt.

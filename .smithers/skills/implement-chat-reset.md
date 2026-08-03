---
name: implement-chat-reset
description: Complete and verify the chat reset work with bounded repair and review loops; use it for the remaining reset implementation.
workflow: implement-chat-reset
---

This workflow completes the remaining chat reset work across the API, demo, web archive, copy, docs, and focused tests. Use it when you need a verified, review-clean working-tree diff without committing or publishing changes.

Inputs:

- `prompt`: optional string for context that narrows or explains the fixed brief; default `""`.
- `maxRepairIterations`: integer at least `1`, controlling each validation and review repair loop; default `3`.

Start it with `bunx smithers-orchestrator workflow run implement-chat-reset --prompt "..."`, or pass structured inputs with `--input '{"prompt":"...","maxRepairIterations":3}'`. You can also run `smithers up .smithers/workflows/implement-chat-reset.tsx`.

To run detached, add `-d` to `smithers up .smithers/workflows/implement-chat-reset.tsx -d`. Then use `smithers ps`, `smithers logs <runId> -f`, and `smithers inspect <runId>` to watch it.

Visualize the graph with `bunx smithers-orchestrator graph .smithers/workflows/implement-chat-reset.tsx`; add `--interactive` for the TUI. The custom UI is available for a run with `smithers ui <runId>`.

For a blocked run, use `smithers approve <runId>` for approval gates, `smithers why <runId>` for signal waits, or `smithers cancel <runId>` to stop it.

Suggest next: run it, watch it in the custom UI, and iterate by re-running `create-workflow` with a follow-up prompt.

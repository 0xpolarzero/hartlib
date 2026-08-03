---
name: implement-ai-retrieval-compaction
description: Execute and verify the retrieval and compaction clean cutover with bounded repairs, migration approval, and readiness evidence.
workflow: implement-ai-retrieval-compaction
---

This workflow carries out the approved retrieval and compaction clean cutover in six ordered phases, with bounded repair loops, blocking reviews, one migration approval, and typed readiness evidence. Use it when implementing or verifying this clean-cutover plan from initialization through final tests and legacy-code checks.

Inputs:

- `prompt`: optional string for extra guidance; initialization accepts it only when it stays within the binding plan; default `""`.

Start it with `bunx smithers-orchestrator workflow run implement-ai-retrieval-compaction --prompt "..."`. For structured inputs, use `bunx smithers-orchestrator workflow run implement-ai-retrieval-compaction --input '{"prompt":"..."}'`. You can also run `smithers up .smithers/workflows/implement-ai-retrieval-compaction.tsx`.

To run it detached, add `-d` to `smithers up .smithers/workflows/implement-ai-retrieval-compaction.tsx -d`. Then watch it with `smithers ps`, `smithers logs <runId> -f`, and `smithers inspect <runId>`.

Visualize it with `bunx smithers-orchestrator graph .smithers/workflows/implement-ai-retrieval-compaction.tsx`; add `--interactive` for the TUI. This workflow declares no custom `<UI>` and has no custom UI file, so `smithers ui <runId>` does not apply.

For blocked states, use `smithers approve <runId>` for the migration approval gate, `smithers why <runId>` for signal waits, or `smithers cancel <runId>` to stop the run.

Suggest next: run it, watch it in the custom UI when one exists, and iterate by re-running `create-workflow` with a follow-up prompt.

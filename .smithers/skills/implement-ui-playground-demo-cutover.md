---
name: implement-ui-playground-demo-cutover
description: Execute the fixed UI playground and demo cutover with durable checkpoints, retention proof, real live-provider tests, and final parity approval.
workflow: implement-ui-playground-demo-cutover
---

This workflow is manual and takes no inputs. It fixes the repository and plan
paths declared in the workflow, preserves `ui-playground/` byte-for-byte,
assigns disjoint implementation lanes, runs bounded review and repair loops,
and keeps final parity approval closed until the no-skip verification matrix,
retention digest, independent review, and stable repository digest all pass.

Use the local `effect-v4` and `playwright-live-e2e` skills for backend and live
browser work. Start it with
`bunx smithers-orchestrator workflow run implement-ui-playground-demo-cutover`
or `smithers up .smithers/workflows/implement-ui-playground-demo-cutover.tsx`.
Open its Gateway dashboard with `smithers ui <runId>`.

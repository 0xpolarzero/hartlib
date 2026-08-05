# Agent Instructions

- Use Conventional Commit messages for all commits.
- Treat `docs/` as the source of truth for project specifications.
- Always refer to `docs/` when making implementation decisions.
- Keep `docs/` in sync whenever code changes affect behavior, architecture, interfaces, or project expectations.
- Do not use `docs/` as a journal or changelog. It is the canonical specification, not a history log.
- For Effect v4 backend work, always use `docs/references/effect-smol/` as the local reference before relying on memory or older Effect patterns.
- Match each repository agent delegation to its work. Use Codex `gpt-5.6-luna` at max reasoning for implementation, debugging, test authoring, and behavior-changing execution.
- Use Codex `gpt-5.6-sol` at max reasoning for planning, orchestration, delegation, synthesis, and independent review. Sol agents do not implement; they delegate intensive execution to Luna and reconcile the result.
- Use Codex `gpt-5.3-codex-spark` at xhigh reasoning for exact, low-risk mechanical edits, commit-message drafting, and read-only UI or browser checks. Spark agents do not make design or behavior decisions.

## E2E flow testing

- When a user asks to test any end-to-end flow, run a relevant Playwright test with live providers and real credentials. The test must exercise the requested path through the full stack: UI submission, API, worker, provider, durable result, and reload or persistence when relevant.
- If no existing test covers the requested path, add or extend a Playwright test before claiming the flow was tested.
- For retrieval chat flows, always run `tests/e2e/chat.spec.ts` test `real provider internal retrieval persists a cited answer` as the required baseline. It is an example of retrieval coverage, not proof for unrelated flows.
- Run the baseline or a flow-specific live test with real credentials, not only the deterministic provider:
  `HARTLIB_E2E_LIVE_PROVIDER=1 HARTLIB_E2E_STACK=1 bun --env-file=.env x --bun playwright test <test-file> --project=hartlib-ai-chat-runtime -g "<test title>"`.
- Treat the live flow as verified only when Playwright reports `passed`. A skipped test, including a skip caused by missing `HARTLIB_E2E_LIVE_PROVIDER=1` or `ZAI_API_KEY`, does not verify the flow even if the command exits with status zero.
- Use a free `HARTLIB_E2E_PORT_BASE` when the default E2E ports are occupied.
- Run relevant deterministic tests as regression checks, but do not present them as proof of live-provider behavior.
- If live credentials are unavailable, state that the live E2E could not run. Do not silently substitute deterministic coverage.

## Prose style

Apply these rules to all prose: documentation, pull requests, commit messages, user-facing text, and agent-to-agent communication. They do not apply to code, identifiers, commands, quotations, API names, or established technical terms. Replace technical language with everyday words only when precision survives.

1. Never use a metaphor, simile, or other figure of speech that you are used to seeing in print.
2. Never use a long word where a short one will do.
3. If it is possible to cut a word out, always cut it out.
4. Never use the passive where you can use the active.
5. Never use a foreign phrase, scientific word, or jargon word if you can think of an everyday English equivalent.
6. Break any of these rules sooner than say anything outright barbarous.

Review every prose output against these rules before delivering it. Favor accuracy, clarity, and natural prose over rigid compliance.

<!-- smithers:prefer-workflows START -->

## Smithers workflows

Use your best judgment, weighing speed, quality, and token usage, to decide
whether a request should run as a [smithers.sh](https://smithers.sh) workflow
or with regular subagents. Prefer a smithers workflow for multi-step plans and
for work that benefits from retries, approvals, review, or replay; reach for
plain subagents when a request is a quick one-off.

The `smithers` skill is installed: run `smithers workflow list` to see the
available workflows and `smithers workflow run <id>` to launch one.

When a session ends successfully and the work could have been a smithers
workflow, offer to turn the session into a reusable smithers workflow for next
time.

<!-- smithers:prefer-workflows END -->

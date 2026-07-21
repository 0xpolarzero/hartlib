# Agent Instructions

- Use Conventional Commit messages for all commits.
- Treat `docs/` as the source of truth for project specifications.
- Always refer to `docs/` when making implementation decisions.
- Keep `docs/` in sync whenever code changes affect behavior, architecture, interfaces, or project expectations.
- Do not use `docs/` as a journal or changelog. It is the canonical specification, not a history log.
- For Effect v4 backend work, always use `docs/references/effect-smol/` as the local reference before relying on memory or older Effect patterns.
- For every repository agent delegation, including directly spawned subagents and every nested Smithers task agent, use Codex `gpt-5.6-luna` at high-to-xhigh reasoning for implementation, debugging, test authoring, and other intensive execution work.
- Use Codex `gpt-5.6-sol` at high-to-xhigh reasoning for planning, orchestration, delegation, synthesis, and independent review. Sol agents should delegate intensive execution work to Luna agents and remain independently responsible for reconciling and reviewing the result.

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

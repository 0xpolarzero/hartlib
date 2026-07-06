# Agent Instructions

- Use Conventional Commit messages for all commits.
- Treat `docs/` as the source of truth for project specifications.
- Always refer to `docs/` when making implementation decisions.
- Keep `docs/` in sync whenever code changes affect behavior, architecture, interfaces, or project expectations.
- Do not use `docs/` as a journal or changelog. It is the canonical specification, not a history log.
- For Effect v4 backend work, always use `docs/references/effect-smol/` as the local reference before relying on memory or older Effect patterns.

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

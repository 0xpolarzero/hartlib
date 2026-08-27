---
name: playwright-live-e2e
description: Run full-stack Playwright flows with real providers, exact ports, durable evidence, and no skipped checks.
workflow: implement-ui-playground-demo-cutover
---

Run live checks with `HARTLIB_E2E_LIVE_PROVIDER=1` and
`HARTLIB_E2E_STACK=1` plus the repository's real provider credentials. Exercise
the UI, API, worker, provider, durable result, and reload or persistence for
retrieval, Stop, and reset-during-run. Use an isolated `HARTLIB_E2E_PORT_BASE`,
retain screenshots and logs, and treat missing credentials, missing tests,
skips, and warning-only results as blockers or failures rather than passing
them through.

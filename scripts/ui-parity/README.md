# Exact UI parity capture

The parity runner uses the 76 entries in `tests/e2e/parity/manifest.ts`. Each
entry has a desktop and narrow viewport, a current route, a reference route,
state preparations, browser actions, and settled probes. A capture never
skips a missing pair.

Start the current stack with the repository E2E launcher:

```sh
HARTLIB_E2E_STACK=1 \
HARTLIB_E2E_PORT_BASE=45200 \
HARTLIB_E2E_DATABASE_URL=postgres://hartlib:hartlib@127.0.0.1:5433/hartlib_e2e_ui_parity \
bun scripts/ui-parity/smoke.ts --port-base 45200
```

With both base URLs reachable, capture and compare every pair. The
`--start-reference` flag launches the protected reference from current source
and keeps Vite's cache in `/tmp`:

```sh
HARTLIB_E2E_DATABASE_URL=postgres://hartlib:hartlib@127.0.0.1:5433/hartlib_e2e_ui_parity \
HARTLIB_E2E_PORT_BASE=45200 \
bun scripts/ui-parity/capture.ts \
  --start-current \
  --start-reference \
  --current-url http://127.0.0.1:45201 \
  --reference-url http://127.0.0.1:45203 \
  --capture-dir /tmp/exact-ui-playground-parity
```

The current surface receives the repository E2E visitor cookie; the reference
surface stays independent of the current database and credentials. The runner
fingerprints `ui-playground` before and after the run and fails if the tree
changes.

To compare an existing directory without recapturing it:

```sh
bun scripts/ui-parity/compare.ts --capture-dir /tmp/exact-ui-playground-parity
```

The command exits zero only when all selected entries have both PNGs and every
RGBA pixel matches. It writes one `*-diff.png` and a JSON report per run.

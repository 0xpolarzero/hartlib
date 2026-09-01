import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { parseE2ePortBase } from "../../tests/e2e/ports";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const configPath = resolve(repositoryRoot, "tests/e2e/parity/smoke.config.ts");

const help = `Usage: bun scripts/ui-parity/smoke.ts [options]

Runs the approved current-app smoke pair through the anchored parity config.
The config discovers only tests/e2e/visual.spec.ts and interactions.spec.ts,
so duplicate copies under .smithers worktrees cannot be loaded.

Options:
  --database-url URL  Explicit PostgreSQL URL for the disposable E2E database
  --port-base PORT    E2E API/demo/object-store port base
  --output DIR        Playwright output directory
`;

const valueFor = (args: readonly string[], option: string): string | undefined => {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} needs a value`);
  return value;
};

export function runSmoke(args: readonly string[] = process.argv.slice(2)): number {
  if (args.includes("--help")) {
    process.stdout.write(help);
    return 0;
  }
  const portBase = valueFor(args, "--port-base");
  if (portBase !== undefined) parseE2ePortBase(portBase);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HARTLIB_E2E_STACK: "1",
    ...(portBase === undefined ? {} : { HARTLIB_E2E_PORT_BASE: portBase }),
    ...(valueFor(args, "--database-url") === undefined
      ? {}
      : { HARTLIB_E2E_DATABASE_URL: valueFor(args, "--database-url") }),
    ...(valueFor(args, "--output") === undefined
      ? {}
      : { PLAYWRIGHT_OUTPUT_DIR: valueFor(args, "--output") }),
  };
  const outputDirectory = valueFor(args, "--output");
  const command = [
    "x",
    "--bun",
    "playwright",
    "test",
    "visual.spec.ts",
    "interactions.spec.ts",
    `--config=${configPath}`,
    "--project=hartlib-ai-chat-runtime",
    "-g",
    "client workspace at 390px|mobile visualization tab shows the empty presentation and conversation",
    ...(outputDirectory === undefined ? [] : [`--output=${outputDirectory}`]),
  ];
  const result = spawnSync(process.execPath, command, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  });
  return result.status ?? -1;
}

if (import.meta.main) {
  try {
    process.exitCode = runSmoke();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

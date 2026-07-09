import { spawnSync } from "node:child_process";

const repoRoot = new URL("../../", import.meta.url).pathname;
const databaseUrl =
  process.env.BRIEF_E2E_DATABASE_URL ?? "postgres://brief:brief@localhost:5432/brief_e2e";
const e2eSetupScript = "apps/worker/src/e2e/setup-cli.ts";

export const resetE2eChatRuntime = (): Promise<void> => {
  const result = spawnSync("bun", [e2eSetupScript, "reset"], {
    cwd: repoRoot,
    env: { ...process.env, BRIEF_E2E_DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      `e2e reset failed with status ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }

  return Promise.resolve();
};

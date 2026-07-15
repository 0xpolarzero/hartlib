import { describe, expect, it } from "vitest";

interface BoundedChildResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

const repositoryRoot = new URL("../../../../..", import.meta.url).pathname;
const fixturePath = new URL("./cli-exit-fixture.tsx", import.meta.url).pathname;
const cliPath = new URL("./cli.ts", import.meta.url).pathname;

const runBounded = async (
  script: string,
  arguments_: readonly string[],
  environment: Record<string, string> = {},
): Promise<BoundedChildResult> => {
  const child = Bun.spawn([process.execPath, script, ...arguments_], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stderr: "pipe",
    stdout: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 5_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  return { exitCode, stderr, stdout, timedOut };
};

describe("finite Smithers evaluation lifecycle", () => {
  it("naturally exits after a real minimal Smithers success", async () => {
    const result = await runBounded(fixturePath, [], {
      BRIEF_EXIT_DB_PATH: `/private/tmp/brief-eval-exit-${crypto.randomUUID()}.db`,
      BRIEF_EXIT_RUN_ID: crypto.randomUUID(),
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"status":"finished"');
  }, 10_000);

  it("naturally exits with the failed evaluation status", async () => {
    const result = await runBounded(fixturePath, [], {
      BRIEF_EXIT_DB_PATH: `/private/tmp/brief-eval-failed-exit-${crypto.randomUUID()}.db`,
      BRIEF_EXIT_FAIL: "1",
      BRIEF_EXIT_RUN_ID: crypto.randomUUID(),
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('"status":"failed"');
  }, 10_000);

  it("rejects shutdown during an active dispatch, then closes after completion", async () => {
    const result = await runBounded(fixturePath, [], {
      BRIEF_EXIT_ACTIVE: "1",
      BRIEF_EXIT_DB_PATH: `/private/tmp/brief-eval-active-exit-${crypto.randomUUID()}.db`,
      BRIEF_EXIT_RUN_ID: crypto.randomUUID(),
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"status":"finished"');
    expect(result.stdout).toContain('"activeCloseRejected":true');
  }, 10_000);

  it("naturally exits when the evaluation CLI rejects invalid input", async () => {
    const result = await runBounded(cliPath, [
      "--annotate",
      "--session",
      "not-a-uuid",
      "--annotations",
      "missing.json",
    ]);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--session must be a UUID");
  }, 10_000);

  it("prints help while still allowing the CLI shutdown finalizer to run", async () => {
    const result = await runBounded(cliPath, ["--help"]);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
  }, 10_000);
});

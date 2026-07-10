import { chromium, type FullConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

const repoRoot = new URL("../../", import.meta.url).pathname;
const demoRoot = new URL("../../apps/demo/", import.meta.url).pathname;
const databaseUrl =
  process.env.BRIEF_E2E_DATABASE_URL ?? "postgres://brief:brief@localhost:5432/brief_e2e";
const apiPort = 43110;
const demoPort = 43111;
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const demoBaseUrl = `http://127.0.0.1:${demoPort}`;
const readinessTimeoutMs = 30_000;
const e2eSetupScript = "apps/worker/src/e2e/setup-cli.ts";

type ManagedProcess = {
  readonly label: string;
  readonly process: ChildProcess;
  readonly detached: boolean;
  readonly port?: number;
  output: string;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const assertChromiumInstalled = (): void => {
  const executable = chromium.executablePath();
  if (!existsSync(executable)) {
    throw new Error(
      `Playwright Chromium is not installed at ${executable}. Run: bunx playwright install chromium`,
    );
  }
};

const runSetupScript = (command: "setup" | "teardown"): void => {
  const result = spawnSync("bun", [e2eSetupScript, command], {
    cwd: repoRoot,
    env: { ...process.env, BRIEF_E2E_DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      `e2e ${command} failed with status ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
};

const appendOutput = (managed: ManagedProcess, chunk: Buffer): void => {
  managed.output += chunk.toString();
  if (managed.output.length > 30_000) {
    managed.output = managed.output.slice(-30_000);
  }
};

const startProcess = (
  label: string,
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  options: {
    readonly cwd?: string;
    readonly detached?: boolean;
    readonly port?: number;
  } = {},
): ManagedProcess => {
  const child = spawn(command, [...args], {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: options.detached === true,
  });
  const managed: ManagedProcess = {
    label,
    process: child,
    detached: options.detached === true,
    port: options.port,
    output: "",
  };
  child.stdout?.on("data", (chunk: Buffer) => appendOutput(managed, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendOutput(managed, chunk));
  return managed;
};

const isPortFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });

const waitForPortFree = async (port: number, label: string): Promise<void> => {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if (await isPortFree(port)) return;
    await sleep(150);
  }

  throw new Error(`${label} stopped but port ${port} is still in use`);
};

const killManagedProcess = (managed: ManagedProcess, signal: NodeJS.Signals): void => {
  const pid = managed.process.pid;
  if (pid === undefined) return;

  try {
    if (managed.detached) {
      process.kill(-pid, signal);
    } else {
      managed.process.kill(signal);
    }
  } catch (error) {
    const code =
      typeof error === "object" && error !== null ? (error as { code?: string }).code : null;
    if (code !== "ESRCH") throw error;
  }
};

const stopProcess = async (managed: ManagedProcess | undefined): Promise<void> => {
  if (managed === undefined) return;

  if (managed.process.exitCode === null) {
    const exited = new Promise<void>((resolve) => {
      managed.process.once("exit", () => resolve());
    });

    killManagedProcess(managed, "SIGTERM");
    await Promise.race([exited, sleep(5_000)]);

    if (managed.process.exitCode === null) {
      killManagedProcess(managed, "SIGKILL");
      await Promise.race([exited, sleep(1_000)]);
    }
  }

  if (managed.port !== undefined) {
    await waitForPortFree(managed.port, managed.label);
  }
};

const processExitedError = (managed: ManagedProcess): Error | null => {
  if (managed.process.exitCode === null) return null;
  return new Error(
    `${managed.label} exited before readiness with code ${managed.process.exitCode}\n${managed.output}`,
  );
};

const waitForHttp = async (url: string, managed: ManagedProcess): Promise<void> => {
  const deadline = Date.now() + readinessTimeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const exited = processExitedError(managed);
    if (exited) throw exited;

    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(150);
  }

  throw new Error(`${managed.label} did not become ready: ${String(lastError)}\n${managed.output}`);
};

const waitForLog = async (needle: string, managed: ManagedProcess): Promise<void> => {
  const deadline = Date.now() + readinessTimeoutMs;

  while (Date.now() < deadline) {
    const exited = processExitedError(managed);
    if (exited) throw exited;
    if (managed.output.includes(needle)) return;
    await sleep(150);
  }

  throw new Error(`${managed.label} did not log readiness marker "${needle}"\n${managed.output}`);
};

export default async function globalSetup(_config: FullConfig) {
  assertChromiumInstalled();
  process.env.BRIEF_E2E_DATABASE_URL = databaseUrl;
  process.env.BRIEF_E2E_API_BASE_URL = apiBaseUrl;
  process.env.BRIEF_E2E_DEMO_BASE_URL = demoBaseUrl;

  runSetupScript("setup");

  const commonEnv = {
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    AI_STREAM_POLL_MS: "50",
    AI_STREAM_KEEPALIVE_MS: "1000",
    PUBLIC_SOURCE_INGESTION_ENABLED: "false",
    ZAI_API_KEY: process.env.ZAI_API_KEY ?? "",
  };
  const api = startProcess(
    "api",
    "bun",
    ["apps/api/src/index.ts"],
    {
      ...commonEnv,
      HOST: "127.0.0.1",
      PORT: String(apiPort),
    },
    { port: apiPort },
  );
  const worker = startProcess("worker", "bun", ["apps/worker/src/index.ts"], {
    ...commonEnv,
    WORKER_POLL_INTERVAL_MS: "250",
    WORKER_RUN_MIGRATIONS_ON_STARTUP: "false",
  });
  const demo = startProcess(
    "demo",
    "bun",
    ["vite", "--host", "127.0.0.1", "--port", String(demoPort), "--strictPort"],
    {
      VITE_API_BASE_URL: apiBaseUrl,
    },
    { cwd: demoRoot, detached: true, port: demoPort },
  );

  try {
    await waitForHttp(`${apiBaseUrl}/health`, api);
    await waitForLog("starting worker", worker);
    await waitForHttp(`${demoBaseUrl}/fr-FR/client`, demo);
  } catch (error) {
    await Promise.all([stopProcess(demo), stopProcess(worker), stopProcess(api)]);
    runSetupScript("teardown");
    throw error;
  }

  return async () => {
    await Promise.all([stopProcess(demo), stopProcess(worker), stopProcess(api)]);
    runSetupScript("teardown");
  };
}

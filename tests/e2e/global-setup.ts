import { chromium, type FullConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import { e2ePortsFromBase, parseE2ePortBase } from "./ports";

const repoRoot = new URL("../../", import.meta.url).pathname;
const demoRoot = new URL("../../apps/demo/", import.meta.url).pathname;
const databaseUrl =
  process.env.BRIEF_E2E_DATABASE_URL ?? "postgres://brief:brief@localhost:5432/brief_e2e";
const {
  api: apiPort,
  demo: demoPort,
  web: webPort,
  objectStore: objectStorePort,
} = e2ePortsFromBase(parseE2ePortBase());
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const demoBaseUrl = `http://127.0.0.1:${demoPort}`;
const webBaseUrl = `http://127.0.0.1:${webPort}`;
const objectStoreBaseUrl = `http://127.0.0.1:${objectStorePort}`;
const objectStoreBucket = "brief-e2e";
const readinessTimeoutMs = 30_000;
const e2eSetupScript = "apps/worker/src/e2e/setup-cli.ts";

type ManagedProcess = {
  readonly label: string;
  readonly process: ChildProcess;
  readonly detached: boolean;
  readonly port?: number | undefined;
  ready: boolean;
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
  const retainedBytes = 30_000;
  if (managed.output.length > retainedBytes) {
    managed.output = managed.output.slice(-retainedBytes);
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
    ready: false,
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

const assertStackPortsFree = async (): Promise<void> => {
  const ports = [
    [apiPort, "api"],
    [demoPort, "demo"],
    [webPort, "web"],
    [objectStorePort, "object store"],
  ] as const;
  const occupied = (
    await Promise.all(
      ports.map(async ([port, label]) =>
        (await isPortFree(port)) ? null : `${label} port ${port} is already in use`,
      ),
    )
  ).filter((value): value is string => value !== null);
  if (occupied.length > 0) {
    throw new Error(
      `E2E stack cannot start with an occupied fixed port; stop the stale process first: ${occupied.join(", ")}`,
    );
  }
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

  // A process that failed before readiness never owned its configured port.
  // Do not let an unrelated stale listener turn the original startup error
  // into a cleanup failure that skips database teardown.
  if (managed.ready && managed.port !== undefined) {
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
      if (response.ok) {
        // A stale listener can answer the probe while the newly spawned child
        // is already exiting after a bind/configuration failure. Require a
        // short stable interval and re-check the child before accepting it.
        await sleep(50);
        const exited = processExitedError(managed);
        if (exited) throw exited;
        managed.ready = true;
        return;
      }
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
    if (managed.output.includes(needle)) {
      await sleep(50);
      const exitedAfterMarker = processExitedError(managed);
      if (exitedAfterMarker) throw exitedAfterMarker;
      managed.ready = true;
      return;
    }
    await sleep(150);
  }

  throw new Error(`${managed.label} did not log readiness marker "${needle}"\n${managed.output}`);
};

export default async function globalSetup(_config: FullConfig) {
  assertChromiumInstalled();
  process.env.BRIEF_E2E_DATABASE_URL = databaseUrl;
  process.env.BRIEF_E2E_API_BASE_URL = apiBaseUrl;
  process.env.BRIEF_E2E_DEMO_BASE_URL = demoBaseUrl;
  process.env.BRIEF_E2E_OBJECT_STORE_BASE_URL = objectStoreBaseUrl;

  await assertStackPortsFree();
  runSetupScript("setup");

  const liveAiKey = (process.env.ZAI_API_KEY ?? "").trim();
  const liveWebKey = (process.env.TINYFISH_API_KEY ?? "").trim();
  const useLiveProvider = process.env.BRIEF_E2E_LIVE_PROVIDER === "1" && liveAiKey !== "";
  const useDeterministicProvider = !useLiveProvider;

  const objectStore = startProcess(
    "object store",
    "bun",
    ["tests/e2e/s3-fixture-server.ts"],
    {
      BRIEF_E2E_OBJECT_STORE_PORT: String(objectStorePort),
      BRIEF_E2E_OBJECT_STORE_BUCKET: objectStoreBucket,
    },
    { port: objectStorePort },
  );

  const commonEnv = {
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    CORS_ALLOWED_ORIGINS: `${demoBaseUrl},${webBaseUrl}`,
    AI_STREAM_POLL_MS: "50",
    AI_STREAM_KEEPALIVE_MS: "1000",
    // A live tool-loop task can make several sequential network requests. The
    // production default is twenty minutes; this opt-in smoke uses a bounded
    // two-minute override so provider latency does not turn the browser
    // contract into a timing flake.
    AI_FAST_TASK_TIMEOUT_MS: useLiveProvider ? "120000" : "30000",
    // setup-cli has already invoked the real worker discovery/fetch/normalize/
    // Postgres pipeline with its deterministic local connector. Keep recurring
    // production-catalog polling disabled so this E2E stack remains network-independent.
    PUBLIC_SOURCE_INGESTION_ENABLED: "false",
    ZAI_API_KEY: useDeterministicProvider ? "e2e-deterministic-provider" : liveAiKey,
    AI_E2E_FAKE_PROVIDER: useDeterministicProvider ? "true" : "false",
    TINYFISH_API_KEY: useDeterministicProvider ? "e2e-deterministic-web" : liveWebKey,
    RAILWAY_BUCKET_ENDPOINT: objectStoreBaseUrl,
    RAILWAY_BUCKET_NAME: objectStoreBucket,
    RAILWAY_BUCKET_ACCESS_KEY_ID: "brief-e2e-access-key",
    RAILWAY_BUCKET_SECRET_ACCESS_KEY: "brief-e2e-secret-key",
    EXPORT_BUCKET_ENDPOINT: objectStoreBaseUrl,
    EXPORT_BUCKET_NAME: `${objectStoreBucket}-exports`,
    EXPORT_BUCKET_ACCESS_KEY_ID: "brief-e2e-access-key",
    EXPORT_BUCKET_SECRET_ACCESS_KEY: "brief-e2e-secret-key",
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
  const web = startProcess(
    "web",
    "bun",
    ["vite", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
    {
      VITE_API_BASE_URL: apiBaseUrl,
      VITE_AUTH_MODE: "demo",
    },
    { cwd: new URL("../../apps/web/", import.meta.url).pathname, detached: true, port: webPort },
  );

  try {
    await waitForHttp(`${objectStoreBaseUrl}/health`, objectStore);
    await waitForHttp(`${apiBaseUrl}/health`, api);
    await waitForLog("starting worker", worker);
    await waitForHttp(`${demoBaseUrl}/fr-FR/client`, demo);
    await waitForHttp(`${webBaseUrl}/en-US/client/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`, web);
  } catch (error) {
    await Promise.allSettled([
      stopProcess(web),
      stopProcess(demo),
      stopProcess(worker),
      stopProcess(api),
      stopProcess(objectStore),
    ]);
    try {
      runSetupScript("teardown");
    } catch {
      // Preserve the startup failure; cleanup errors must not mask the
      // process that failed readiness.
    }
    throw error;
  }

  return async () => {
    const stopped = await Promise.allSettled([
      stopProcess(web),
      stopProcess(demo),
      stopProcess(worker),
      stopProcess(api),
      stopProcess(objectStore),
    ]);
    let teardownError: unknown;
    try {
      runSetupScript("teardown");
    } catch (error) {
      teardownError = error;
    }
    const stopError = stopped.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )?.reason;
    if (stopError !== undefined) throw stopError;
    if (teardownError !== undefined) throw teardownError;
  };
}

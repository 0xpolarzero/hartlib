import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { e2ePortsFromBase, parseE2ePortBase } from "./ports";

const repoRoot = new URL("../../", import.meta.url).pathname;
const databaseUrl =
  process.env.HARTLIB_E2E_DATABASE_URL ?? "postgres://hartlib:hartlib@localhost:5432/hartlib_e2e";
const setupScript = "apps/worker/src/e2e/setup-cli.ts";
const workerPidFile = `/tmp/hartlib-e2e-worker-${e2ePortsFromBase(parseE2ePortBase()).api}.pid`;

const run = (command: string, args: readonly string[] = []): string => {
  const result = spawnSync("bun", [setupScript, command, ...args], {
    cwd: repoRoot,
    env: { ...process.env, HARTLIB_E2E_DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(
      `${command} failed with status ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout.trim();
};

export const resetE2eChatRuntime = (): void => {
  run("reset");
};

export interface E2eRuntimeState {
  readonly chats: readonly {
    readonly id: string;
    readonly companyId: string;
    readonly webEnabled: boolean;
  }[];
  readonly runs: readonly {
    readonly id: string;
    readonly chatId: string;
    readonly status: string;
    readonly errorCode: string | null;
    readonly retryable: boolean | null;
    readonly stopRequestedAt: string | null;
    readonly stoppedAt: string | null;
  }[];
  readonly providerMeasurements: readonly {
    readonly runId: string;
    readonly provider: string | null;
    readonly providerEndpointIdentity: string | null;
    readonly modelId: string | null;
    readonly repairConsumed: boolean | null;
  }[];
  readonly providerUsages: readonly {
    readonly runId: string;
    readonly providerServiceId: string;
    readonly modelId: string;
  }[];
  readonly events: readonly {
    readonly runId: string;
    readonly seq: number;
    readonly type: string;
    readonly event: Record<string, unknown>;
    readonly emittedByTask: string | null;
  }[];
  readonly memories: readonly {
    readonly id: string;
    readonly content: string | null;
    readonly deleted: boolean;
    readonly headRevisionId: string | null;
  }[];
  readonly revisions: readonly {
    readonly id: string;
    readonly memoryId: string;
    readonly action: string;
  }[];
}

export const readE2eRuntimeState = (): E2eRuntimeState =>
  JSON.parse(run("state")) as E2eRuntimeState;

export const seedActiveRun = (): { readonly chatId: string; readonly runId: string } =>
  JSON.parse(run("seed-active-chat")) as { readonly chatId: string; readonly runId: string };

export const seedPublicCitation = (): Record<string, unknown> =>
  JSON.parse(run("seed-public-citation")) as Record<string, unknown>;

export const seedPurgeRetry = (
  visitorId: string,
): {
  readonly visitorId: string;
  readonly companyId: string;
  readonly chatId: string;
  readonly runId: string;
  readonly jobId: string;
} => JSON.parse(run("seed-purge-retry", [visitorId]));

export interface E2ePurgeRetryState {
  readonly visitorId: string;
  readonly job: {
    readonly id: string;
    readonly status: string;
    readonly attempts: number;
    readonly maxAttempts: number;
    readonly availableAt: string;
    readonly lastError: string | null;
  } | null;
  readonly graph: {
    readonly sessions: number;
    readonly users: number;
    readonly companies: number;
    readonly memberships: number;
    readonly chats: number;
    readonly runs: number;
  };
  readonly activeRuns: number;
}

export const readPurgeRetryState = (visitorId: string): E2ePurgeRetryState =>
  JSON.parse(run("purge-retry-state", [visitorId])) as E2ePurgeRetryState;

export const releasePurgeRetry = (
  visitorId: string,
): {
  readonly visitorId: string;
  readonly releasedRuns: number;
  readonly releasedJobs: number;
} => JSON.parse(run("release-purge-retry", [visitorId]));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const stopChild = async (child: ReturnType<typeof spawn>): Promise<void> => {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    child.kill("SIGTERM");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null ? (error as { code?: string }).code : null;
    if (code !== "ESRCH") throw error;
  }
  await Promise.race([exited, sleep(5_000)]);
  if (child.exitCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process exited between the status check and the signal.
    }
    await Promise.race([exited, sleep(1_000)]);
  }
};

const waitForWorkerReady = (child: ReturnType<typeof spawn>): Promise<void> =>
  new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const deadline = setTimeout(() => {
      void stopChild(child);
      settle(new Error(`restarted worker did not become ready\n${output}`));
    }, 30_000);
    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString();
      if (output.includes("starting worker")) settle();
    };
    const onExit = (code: number | null): void => {
      if (code !== null) settle(new Error(`restarted worker exited with ${code}\n${output}`));
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.stdout?.off("data", onData);
      if (error) reject(error);
      else resolve();
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => settle(error));
    child.once("exit", onExit);
  });

const workerEnvironment = (): Record<string, string> => {
  const liveProvider =
    process.env.HARTLIB_E2E_LIVE_PROVIDER === "1" && (process.env.ZAI_API_KEY ?? "").trim() !== "";
  const { objectStore } = e2ePortsFromBase(parseE2ePortBase());
  const objectStoreBaseUrl = `http://127.0.0.1:${objectStore}`;
  return {
    ...(process.env as Record<string, string>),
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    AI_STREAM_POLL_MS: "50",
    AI_STREAM_KEEPALIVE_MS: "1000",
    AI_FAST_TASK_TIMEOUT_MS: liveProvider ? "120000" : "30000",
    PUBLIC_SOURCE_INGESTION_ENABLED: "false",
    ZAI_API_KEY: liveProvider ? (process.env.ZAI_API_KEY ?? "") : "e2e-deterministic-provider",
    AI_E2E_FAKE_PROVIDER: liveProvider ? "false" : "true",
    TINYFISH_API_KEY: liveProvider ? (process.env.TINYFISH_API_KEY ?? "") : "e2e-deterministic-web",
    RAILWAY_BUCKET_ENDPOINT: objectStoreBaseUrl,
    RAILWAY_BUCKET_NAME: "hartlib-e2e",
    RAILWAY_BUCKET_ACCESS_KEY_ID: "hartlib-e2e-access-key",
    RAILWAY_BUCKET_SECRET_ACCESS_KEY: "hartlib-e2e-secret-key",
    WORKER_POLL_INTERVAL_MS: "250",
    WORKER_RUN_MIGRATIONS_ON_STARTUP: "false",
  };
};

export interface E2eRestartedWorker {
  readonly stop: () => Promise<void>;
}

export const restartE2eWorker = async (): Promise<E2eRestartedWorker> => {
  const pidText = readFileSync(workerPidFile, "utf8").trim();
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("E2E worker pid handoff is invalid");
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null ? (error as { code?: string }).code : null;
    if (code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null ? (error as { code?: string }).code : null;
      if (code === "ESRCH") break;
      throw error;
    }
    await sleep(100);
  }
  const replacement = spawn("bun", ["apps/worker/src/index.ts"], {
    cwd: repoRoot,
    env: workerEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForWorkerReady(replacement);
  return { stop: () => stopChild(replacement) };
};

export interface E2eStreamGate {
  readonly release: () => Promise<void>;
}

export const holdE2eStreamGate = async (gateId: string): Promise<E2eStreamGate> => {
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(gateId)) throw new Error("invalid E2E stream gate id");
  const child = spawn("bun", [setupScript, "hold-stream-gate", gateId], {
    cwd: repoRoot,
    env: { ...process.env, HARTLIB_E2E_DATABASE_URL: databaseUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  let output = "";
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      for (const line of output.split("\n")) {
        try {
          const value = JSON.parse(line) as { readonly gateId?: string; readonly ready?: boolean };
          if (value.gateId === gateId && value.ready === true) resolve();
        } catch {
          // Wait for the complete readiness line.
        }
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`stream gate exited with ${code}: ${output}`));
    });
  });
  await ready;
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      child.stdin.end("\n");
      const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
      if (code !== 0) throw new Error(`stream gate release failed with ${code}`);
    },
  };
};

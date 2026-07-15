import { spawn, spawnSync } from "node:child_process";

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

const runJsonCommand = <Result>(command: string, args: readonly string[] = []): Result => {
  const result = spawnSync("bun", [e2eSetupScript, command, ...args], {
    cwd: repoRoot,
    env: { ...process.env, BRIEF_E2E_DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `e2e ${command} failed with status ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout.trim()) as Result;
};

export interface E2eRuntimeState {
  readonly chats: ReadonlyArray<{
    readonly id: string;
    readonly companyId: string;
    readonly webEnabled: boolean;
  }>;
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly chatId: string;
    readonly status: string;
    readonly errorCode: string | null;
    readonly retryable: boolean | null;
  }>;
  readonly events: ReadonlyArray<{
    readonly runId: string;
    readonly seq: number;
    readonly type: string;
    readonly event: Record<string, unknown>;
    readonly emittedByTask: string | null;
  }>;
  readonly memories: ReadonlyArray<{
    readonly id: string;
    readonly content: string | null;
    readonly deleted: boolean;
    readonly headRevisionId: string | null;
  }>;
  readonly revisions: ReadonlyArray<{
    readonly id: string;
    readonly memoryId: string;
    readonly action: string;
  }>;
  readonly externalToolUsage: ReadonlyArray<{
    readonly runId: string;
    readonly taskId: string;
    readonly loopIteration: number;
    readonly attempt: number;
    readonly toolRequestIndex: number;
    readonly operation: string;
    readonly status: string;
  }>;
}

export const readE2eRuntimeState = (): E2eRuntimeState => runJsonCommand<E2eRuntimeState>("state");

export interface E2ePublisherPdfState {
  readonly fixture: {
    readonly publisherCompanyId: string;
    readonly subscriptionId: string;
    readonly issueId: string;
    readonly accessId: string;
    readonly issueTitle: string;
  };
  readonly publisherAccessActive: boolean;
  readonly issue: {
    readonly status: string;
    readonly indexingStatus: string;
    readonly publishedAt: string | null;
  } | null;
  readonly documents: ReadonlyArray<{
    readonly id: string;
    readonly originalFileName: string;
    readonly byteSize: number;
    readonly sha256Hex: string;
    readonly currentVersionId: string | null;
    readonly extractionCount: number;
  }>;
  readonly jobs: ReadonlyArray<{
    readonly kind: string;
    readonly status: string;
    readonly attempts: number;
    readonly lastError: string | null;
  }>;
  readonly deliveryCount: number;
}

export const readE2ePublisherPdfState = (): E2ePublisherPdfState =>
  runJsonCommand<E2ePublisherPdfState>("publisher-pdf-state");

export const makeE2ePublisherPdfClientOnly = (): void => {
  const result = runJsonCommand<{ readonly publisherAccessActive: boolean }>(
    "publisher-pdf-client-only",
  );
  if (result.publisherAccessActive) throw new Error("publisher E2E access remained active");
};

export const seedE2ePublisherDocumentCitation = (): {
  readonly chatId: string;
  readonly messageId: string;
  readonly citationUrl: string;
} => runJsonCommand("seed-publisher-citation");

export const makeLatestCitedMemoryProvenanceOnly = (): {
  readonly memoryId: string;
  readonly revisionId: string;
} => runJsonCommand("memory-provenance-only");

export const disableE2eDemoPublicSource = (sourceId: string): void => {
  const result = runJsonCommand<{ readonly sourceId: string }>("disable-demo-public-source", [
    sourceId,
  ]);
  if (result.sourceId !== sourceId) throw new Error("E2E public source revocation mismatched");
};

export const seedActiveRun = (
  scope: "chat" | "user",
): { readonly chatId: string; readonly runId: string } =>
  runJsonCommand(scope === "chat" ? "seed-active-chat" : "seed-active-user");

export const seedPrunedStreamRun = (): {
  readonly chatId: string;
  readonly runId: string;
} => runJsonCommand("seed-pruned-stream-run");

export const seedE2eFailedRun = (
  chatId: string,
  content: string,
): { readonly chatId: string; readonly runId: string; readonly messageId: string } =>
  runJsonCommand("seed-failed-run", [chatId, content]);

export const pruneSeededStreamRun = (runId: string): void => {
  const result = spawnSync("bun", [e2eSetupScript, "prune-seeded-stream-run", runId], {
    cwd: repoRoot,
    env: { ...process.env, BRIEF_E2E_DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `e2e prune-seeded-stream-run failed with status ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
};

export interface E2eStreamGate {
  readonly release: () => Promise<void>;
}

export const holdE2eStreamGate = async (gateId: string): Promise<E2eStreamGate> => {
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(gateId)) throw new Error("invalid E2E stream gate id");

  const child = spawn("bun", [e2eSetupScript, "hold-stream-gate", gateId], {
    cwd: repoRoot,
    env: { ...process.env, BRIEF_E2E_DATABASE_URL: databaseUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
  });

  await new Promise<void>((resolve, reject) => {
    let ready = false;
    const inspect = () => {
      for (const line of stdout.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const value = JSON.parse(line) as { readonly gateId?: unknown; readonly ready?: unknown };
          if (value.gateId === gateId && value.ready === true) {
            ready = true;
            resolve();
            return;
          }
        } catch {
          // Keep collecting output so a malformed readiness line is reported on exit.
        }
      }
    };
    child.stdout.on("data", inspect);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!ready) {
        reject(
          new Error(
            `E2E stream gate exited before readiness with status ${code}\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
    inspect();
  });

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      child.stdin.end("\n");
      const code = await exit;
      if (code !== 0) {
        throw new Error(`E2E stream gate release failed with status ${code}\n${stdout}\n${stderr}`);
      }
    },
  };
};

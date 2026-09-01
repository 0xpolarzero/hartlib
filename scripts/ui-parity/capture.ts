import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { e2ePortsFromBase, parseE2ePortBase } from "../../tests/e2e/ports";
import {
  runParityCapture,
  type ActionContext,
  type ActionHandlerResult,
  type CaptureReport,
  type CaptureOptions,
} from "../../tests/e2e/parity/capture";
import { resolveManifestEntries } from "../../tests/e2e/parity/capture";
import { guardProtectedPaths, completeProtectedGuard, type ProtectedGuardResult } from "./guard";

interface CliOptions {
  readonly currentUrl: string;
  readonly referenceUrl: string;
  readonly currentCommand: string | null;
  readonly referenceCommand: string | null;
  readonly currentCwd: string;
  readonly referenceCwd: string;
  readonly outputDir: string;
  readonly entryIds: readonly string[] | undefined;
  readonly launch: boolean;
  readonly timeoutMs: number;
  readonly headed: boolean;
  readonly guard: boolean;
  readonly help: boolean;
}

interface ManagedProcess {
  readonly command: string;
  readonly child: ChildProcess;
  output: string;
}

const repositoryRoot = resolve(new URL("../../", import.meta.url).pathname);
const referenceRoot = resolve(repositoryRoot, "ui-playground");
const defaultDemoPort = e2ePortsFromBase(parseE2ePortBase()).demo;
const defaultReferencePort = Number(process.env.HARTLIB_PARITY_REFERENCE_PORT ?? "45173");
const defaultVisitorId =
  process.env.HARTLIB_E2E_VISITOR_ID ?? "00000000-0000-4000-8000-000000000001";

const usage = `Usage: bun scripts/ui-parity/capture.ts [options]

Captures every entry in the exact 1440x900 and 390x844 parity matrix from
both already-running surfaces, then compares every captured PNG pixel.

Options:
  --launch                    launch both surfaces and stop them on exit
  --current-url URL           current app URL (default: E2E demo port)
  --reference-url URL         ui-playground URL (default: port 45173)
  --current-command COMMAND   command used with --launch for the current app
  --reference-command COMMAND command used with --launch for ui-playground
  --current-cwd DIR           current app working directory
  --reference-cwd DIR         ui-playground working directory
  --entry ID[,ID...]          capture selected manifest entries only
  --output DIR                artifact directory
  --timeout MS                per navigation/action timeout
  --headed                    launch Chromium with a visible window
  --guard                     fingerprint protected paths before and after
  --help                      show this help
`;

const valueAfter = (args: readonly string[], index: number, flag: string): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
};

export const parseCliOptions = (args: readonly string[] = process.argv.slice(2)): CliOptions => {
  const currentUrl =
    process.env.HARTLIB_PARITY_CURRENT_URL ??
    (args.includes("--launch") ? "http://127.0.0.1:5173" : `http://127.0.0.1:${defaultDemoPort}`);
  const referenceUrl =
    process.env.HARTLIB_PARITY_REFERENCE_URL ?? `http://127.0.0.1:${defaultReferencePort}`;
  let options: {
    currentUrl: string;
    referenceUrl: string;
    currentCommand: string | null;
    referenceCommand: string | null;
    currentCwd: string;
    referenceCwd: string;
    outputDir: string;
    entryIds: readonly string[] | undefined;
    launch: boolean;
    timeoutMs: number;
    headed: boolean;
    guard: boolean;
    help: boolean;
  } = {
    currentUrl,
    referenceUrl,
    currentCommand: process.env.HARTLIB_PARITY_CURRENT_COMMAND ?? null,
    referenceCommand: process.env.HARTLIB_PARITY_REFERENCE_COMMAND ?? null,
    currentCwd: repositoryRoot,
    referenceCwd: referenceRoot,
    outputDir: resolve(process.env.HARTLIB_PARITY_OUTPUT ?? "/tmp/hartlib-ui-parity"),
    entryIds: undefined,
    launch: false,
    timeoutMs: Number(process.env.HARTLIB_PARITY_TIMEOUT_MS ?? "30000"),
    headed: false,
    guard: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--launch":
        options.launch = true;
        break;
      case "--headed":
        options.headed = true;
        break;
      case "--guard":
        options.guard = true;
        break;
      case "--current-url":
        options.currentUrl = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--reference-url":
        options.referenceUrl = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--current-command":
        options.currentCommand = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--reference-command":
        options.referenceCommand = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--current-cwd":
        options.currentCwd = resolve(valueAfter(args, index, arg));
        index += 1;
        break;
      case "--reference-cwd":
        options.referenceCwd = resolve(valueAfter(args, index, arg));
        index += 1;
        break;
      case "--entry":
        options.entryIds = valueAfter(args, index, arg)
          .split(",")
          .map((entryId) => entryId.trim())
          .filter((entryId) => entryId !== "");
        index += 1;
        break;
      case "--output":
        options.outputDir = resolve(valueAfter(args, index, arg));
        index += 1;
        break;
      case "--timeout": {
        const value = valueAfter(args, index, arg);
        const timeoutMs = Number(value);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
          throw new Error("--timeout must be a positive integer");
        options.timeoutMs = timeoutMs;
        index += 1;
        break;
      }
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("HARTLIB_PARITY_TIMEOUT_MS must be a positive integer");
  }
  return options;
};

const splitCommand = (command: string): readonly string[] => {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of command.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (current !== "") {
        parts.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped) throw new Error("command ends with an escape character");
  if (quote !== null) throw new Error("command has an unterminated quote");
  if (current !== "") parts.push(current);
  if (parts.length === 0) throw new Error("launch command cannot be empty");
  return parts;
};

const appendOutput = (managed: ManagedProcess, chunk: Buffer): void => {
  managed.output += chunk.toString("utf8");
  if (managed.output.length > 24_000) managed.output = managed.output.slice(-24_000);
};

const startProcess = (
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): ManagedProcess => {
  const [executable, ...args] = splitCommand(command);
  if (executable === undefined) throw new Error("launch command cannot be empty");
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...environment },
    stdio: "pipe",
    detached: true,
  });
  const managed: ManagedProcess = { command, child, output: "" };
  child.stdout?.on("data", (chunk: Buffer) => appendOutput(managed, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendOutput(managed, chunk));
  child.once("error", (error) => appendOutput(managed, Buffer.from(String(error))));
  return managed;
};

const stopProcess = async (managed: ManagedProcess): Promise<void> => {
  if (managed.child.exitCode !== null) return;
  const exited = new Promise<void>((resolveExit) =>
    managed.child.once("exit", () => resolveExit()),
  );
  const pid = managed.child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ESRCH") throw error;
    }
  }
  await Promise.race([exited, new Promise<void>((resolveExit) => setTimeout(resolveExit, 5_000))]);
  if (managed.child.exitCode === null && pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ESRCH") throw error;
    }
    await Promise.race([
      exited,
      new Promise<void>((resolveExit) => setTimeout(resolveExit, 1_000)),
    ]);
  }
};

const waitForHttp = async (
  url: string,
  managed: ManagedProcess,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (managed.child.exitCode !== null) {
      throw new Error(
        `${managed.command} exited with ${String(managed.child.exitCode)}\n${managed.output}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${url} did not become ready: ${lastError}\n${managed.output}`);
};

const runCommand = async (command: string, cwd: string): Promise<void> => {
  const [executable, ...args] = splitCommand(command);
  if (executable === undefined) throw new Error("command cannot be empty");
  await new Promise<void>((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, { cwd, env: process.env, stdio: "pipe" });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand();
      } else {
        rejectCommand(
          new Error(`${command} exited with ${String(code ?? signal)}\n${output.slice(-8_000)}`),
        );
      }
    });
  });
};

const actionHandler =
  (options: CliOptions): ((context: ActionContext) => Promise<ActionHandlerResult>) =>
  async (context) => {
    const { action } = context;
    if (action.kind === "reset" || action.kind === "seed") {
      if (action.command === undefined) return { handled: false };
      await runCommand(action.command, repositoryRoot);
      return { handled: true, reload: true };
    }
    void options;
    return { handled: false };
  };

const launchIfRequested = async (options: CliOptions): Promise<readonly ManagedProcess[]> => {
  if (!options.launch) return [];
  const currentCommand = options.currentCommand ?? "bun run dev:web";
  const referenceCommand =
    options.referenceCommand ??
    `npm run preview -- --host 127.0.0.1 --port ${String(defaultReferencePort)} --strictPort`;
  const current = startProcess(currentCommand, options.currentCwd, {
    NODE_ENV: "test",
    TZ: "Europe/Paris",
  });
  const reference = startProcess(referenceCommand, options.referenceCwd, {
    NODE_ENV: "test",
    TZ: "Europe/Paris",
  });
  try {
    await Promise.all([
      waitForHttp(options.currentUrl, current, options.timeoutMs),
      waitForHttp(options.referenceUrl, reference, options.timeoutMs),
    ]);
  } catch (error) {
    await Promise.allSettled([stopProcess(current), stopProcess(reference)]);
    throw error;
  }
  return [current, reference];
};

const writeGuardReport = async (
  outputDir: string,
  before: ProtectedGuardResult,
  after: ProtectedGuardResult,
): Promise<void> => {
  await writeFile(
    resolve(outputDir, "guard-report.json"),
    `${JSON.stringify({ before: before.before, after: after.after, unchanged: after.unchanged, mismatches: after.mismatches }, null, 2)}\n`,
    "utf8",
  );
};

export interface ParityCliResult {
  readonly report: CaptureReport | null;
  readonly guard: ProtectedGuardResult | null;
  readonly launched: boolean;
}

export const runCli = async (
  args: readonly string[] = process.argv.slice(2),
): Promise<ParityCliResult> => {
  const options = parseCliOptions(args);
  if (options.help) {
    process.stdout.write(usage);
    return { report: null, guard: null, launched: false };
  }
  await mkdir(options.outputDir, { recursive: true });
  const protectedPaths = [
    "ui-playground",
    ".smithers/workflows/exact-ui-playground-parity.tsx",
  ] as const;
  const before = options.guard ? await guardProtectedPaths(repositoryRoot, protectedPaths) : null;
  let processes: readonly ManagedProcess[] = [];
  let report: CaptureReport | null = null;
  let after: ProtectedGuardResult | null = null;
  try {
    processes = await launchIfRequested(options);
    const captureOptions: CaptureOptions = {
      currentBaseUrl: options.currentUrl,
      referenceBaseUrl: options.referenceUrl,
      outputDir: options.outputDir,
      entries: resolveManifestEntries(options.entryIds),
      timeoutMs: options.timeoutMs,
      headless: !options.headed,
      currentContext: {
        serviceWorkers: "block",
        timezoneId: "Europe/Paris",
        storageState: {
          cookies: [
            {
              name: "hartlib_demo",
              value: defaultVisitorId,
              domain: new URL(options.currentUrl).hostname,
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: false,
              sameSite: "Lax",
            },
          ],
          origins: [],
        },
      },
      referenceContext: { serviceWorkers: "block", timezoneId: "Europe/Paris" },
      actionHandler: actionHandler(options),
      onProgress: (event) => {
        if (event.type === "entry-complete") {
          process.stdout.write(`${event.entry.entryId} ${event.passed ? "passed" : "failed"}\n`);
        }
      },
    };
    report = await runParityCapture(captureOptions);
  } finally {
    if (before !== null) {
      after = await completeProtectedGuard(repositoryRoot, before);
      await writeGuardReport(options.outputDir, before, after);
    }
    await Promise.allSettled(processes.map(stopProcess));
  }
  return { report, guard: after, launched: processes.length > 0 };
};

if (import.meta.main) {
  try {
    const result = await runCli();
    if (result.report !== null && !result.report.passed) process.exitCode = 1;
    if (result.guard !== null && !result.guard.unchanged) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

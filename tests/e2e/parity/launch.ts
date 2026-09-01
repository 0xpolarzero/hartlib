import { spawn } from "node:child_process";

import type { ParitySurfaceSpec } from "./types";

export const DEFAULT_APP_COMMAND = ["bun", "run", "dev:web"] as const;
export const DEFAULT_APP_URL = "http://127.0.0.1:5173";

const defaultReadinessTimeoutMs = 60_000;
const defaultPollMs = 150;
const defaultGracefulShutdownMs = 5_000;

export interface LaunchOptions {
  readonly readinessTimeoutMs?: number | undefined;
  readonly pollMs?: number | undefined;
  readonly gracefulShutdownMs?: number | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
}

export interface RunningSurface {
  readonly spec: ParitySurfaceSpec;
  readonly started: boolean;
  readonly output: string;
  stop(): Promise<void>;
}

type MutableRunningSurface = {
  readonly spec: ParitySurfaceSpec;
  child: ReturnType<typeof spawn> | undefined;
  readonly started: boolean;
  output: string;
  outputReaders: Promise<void>[];
  stopped: boolean;
  startError: Error | undefined;
};

const assertOrigin = (value: string, label: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute http or https URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`${label} must not contain credentials`);
  }
  return parsed;
};

const mergedEnvironment = (
  options: LaunchOptions,
  spec: ParitySurfaceSpec,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) result[key] = value;
  }
  for (const [key, value] of Object.entries(options.environment ?? {})) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  for (const [key, value] of Object.entries(spec.env ?? {})) result[key] = value;
  // Both surfaces use the same browser-facing locale and timezone unless a
  // caller explicitly overrides them for a documented scenario.
  result.NODE_ENV ??= "test";
  result.TZ ??= "Europe/Paris";
  return result;
};

const appendOutput = (surface: MutableRunningSurface, chunk: Uint8Array): void => {
  surface.output += new TextDecoder().decode(chunk);
  const maxBytes = 32_000;
  if (surface.output.length > maxBytes) surface.output = surface.output.slice(-maxBytes);
};

const readOutput = (
  stream: NodeJS.ReadableStream | null,
  surface: MutableRunningSurface,
): Promise<void> =>
  new Promise((resolve) => {
    if (stream === null) {
      resolve();
      return;
    }
    stream.on("data", (chunk: unknown) => {
      if (typeof chunk === "string") appendOutput(surface, new TextEncoder().encode(chunk));
      else if (chunk instanceof Uint8Array) appendOutput(surface, chunk);
      else appendOutput(surface, new TextEncoder().encode(String(chunk)));
    });
    stream.once("end", resolve);
    stream.once("close", resolve);
    stream.once("error", resolve);
  });

const isProcessAlive = (child: ReturnType<typeof spawn>): boolean => child.exitCode === null;

const signalProcessGroup = (child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void => {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    // Detached children keep their server's descendants in one group. The
    // negative PID is safe on POSIX and falls back to the direct child on
    // platforms where process groups are unavailable.
    if (process.platform === "darwin" || process.platform === "linux") process.kill(-pid, signal);
    else child.kill(signal);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
    if (code !== "ESRCH") throw error;
  }
};

const waitForHttp = async (
  spec: ParitySurfaceSpec,
  surface: MutableRunningSurface,
  options: LaunchOptions,
): Promise<void> => {
  const timeoutMs = options.readinessTimeoutMs ?? defaultReadinessTimeoutMs;
  const pollMs = options.pollMs ?? defaultPollMs;
  const readinessPath = spec.readyPath ?? "/";
  const origin = assertOrigin(spec.url, `${spec.name} URL`);
  const readinessUrl = new URL(readinessPath, origin);
  if (readinessUrl.origin !== origin.origin) {
    throw new Error(`${spec.name} readyPath must stay on the configured surface origin`);
  }
  const url = readinessUrl.toString();
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (surface.startError !== undefined) {
      throw new Error(
        `${spec.name} command could not start: ${surface.startError.message}\n${surface.output}`,
      );
    }
    if (surface.child !== undefined && !isProcessAlive(surface.child)) {
      throw new Error(
        `${spec.name} command exited with code ${String(surface.child.exitCode)} before readiness\n${surface.output}`,
      );
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(2_000, timeoutMs)),
      });
      if (response.ok || (response.status >= 300 && response.status < 400)) return;
      lastError = `${url} returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`${spec.name} did not become ready at ${url}: ${lastError}\n${surface.output}`);
};

const startSurface = async (
  spec: ParitySurfaceSpec,
  options: LaunchOptions,
): Promise<MutableRunningSurface> => {
  assertOrigin(spec.url, `${spec.name} URL`);
  const surface: MutableRunningSurface = {
    spec,
    child: undefined,
    started: spec.command !== undefined,
    output: "",
    outputReaders: [],
    stopped: false,
    startError: undefined,
  };
  if (spec.command === undefined) {
    await waitForHttp(spec, surface, options);
    return surface;
  }
  if (spec.command.length === 0 || spec.command.some((part) => part.trim() === "")) {
    throw new Error(`${spec.name} command must contain non-empty argv entries`);
  }
  const [executable, ...args] = spec.command;
  if (executable === undefined) throw new Error(`${spec.name} command is empty`);
  const child = spawn(executable, args, {
    cwd: spec.cwd,
    env: mergedEnvironment(options, spec),
    detached: process.platform === "darwin" || process.platform === "linux",
    stdio: ["ignore", "pipe", "pipe"],
  });
  surface.child = child;
  child.once("error", (error) => {
    surface.startError = error instanceof Error ? error : new Error(String(error));
  });
  surface.outputReaders.push(readOutput(child.stdout, surface));
  surface.outputReaders.push(readOutput(child.stderr, surface));
  try {
    await waitForHttp(spec, surface, options);
  } catch (error) {
    await stopSurface(surface, options);
    throw error;
  }
  return surface;
};

const stopSurface = async (
  surface: MutableRunningSurface,
  options: LaunchOptions,
): Promise<void> => {
  if (surface.stopped) return;
  surface.stopped = true;
  const child = surface.child;
  if (child === undefined) return;
  if (isProcessAlive(child)) {
    signalProcessGroup(child, "SIGTERM");
    const gracefulTimeoutMs = options.gracefulShutdownMs ?? defaultGracefulShutdownMs;
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, gracefulTimeoutMs)),
    ]);
  }
  if (isProcessAlive(child)) {
    signalProcessGroup(child, "SIGKILL");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
  await Promise.all(surface.outputReaders);
};

const validateLaunchOptions = (options: LaunchOptions): void => {
  const positive = [
    ["readinessTimeoutMs", options.readinessTimeoutMs],
    ["gracefulShutdownMs", options.gracefulShutdownMs],
  ] as const;
  for (const [name, value] of positive) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (
    options.pollMs !== undefined &&
    (!Number.isSafeInteger(options.pollMs) || options.pollMs <= 0)
  ) {
    throw new Error("pollMs must be a positive integer");
  }
};

export const launchSurfaces = async (
  specs: readonly [ParitySurfaceSpec, ParitySurfaceSpec],
  options: LaunchOptions = {},
): Promise<readonly [RunningSurface, RunningSurface]> => {
  validateLaunchOptions(options);
  if (specs[0].name !== "app" || specs[1].name !== "reference") {
    throw new Error("parity surfaces must be ordered as app then reference");
  }
  const app = await startSurface(specs[0], options);
  try {
    const reference = await startSurface(specs[1], options);
    const wrap = (surface: MutableRunningSurface): RunningSurface => ({
      spec: surface.spec,
      started: surface.started,
      get output() {
        return surface.output;
      },
      stop: () => stopSurface(surface, options),
    });
    return [wrap(app), wrap(reference)];
  } catch (error) {
    await stopSurface(app, options);
    throw error;
  }
};

export const withLaunchedSurfaces = async <T>(
  specs: readonly [ParitySurfaceSpec, ParitySurfaceSpec],
  work: (surfaces: readonly [RunningSurface, RunningSurface]) => Promise<T>,
  options: LaunchOptions = {},
): Promise<T> => {
  const surfaces = await launchSurfaces(specs, options);
  try {
    return await work(surfaces);
  } finally {
    await Promise.allSettled([surfaces[1].stop(), surfaces[0].stop()]);
  }
};

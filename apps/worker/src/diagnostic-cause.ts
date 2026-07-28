/**
 * Captures the full cause of an error before the runtime/provenance boundary
 * normalizes it into a content-free code.
 *
 * The boundary itself is unchanged: what crosses into durable storage
 * (jobs.last_error, durable AI metadata) and provider-facing surfaces stays
 * content-free. This only writes the original cause to the local structured
 * console log so a failure can be traced precisely from a log dump.
 *
 * The module is deliberately free of an Effect dependency so the low-level
 * runtime errors module can call it. The sink is registered once at worker
 * startup; until then (and in every environment where it is not registered)
 * capture is a cheap early return with zero behavior change.
 */
export interface DiagnosticCauseRecord {
  readonly context: string;
  readonly name: string;
  readonly message: string;
  readonly stack?: string | undefined;
  readonly code?: string | undefined;
}

export type DiagnosticCauseSink = (record: DiagnosticCauseRecord) => void;

const MESSAGE_MAX = 4096;
const STACK_MAX = 16384;

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}…[+${value.length - max} chars]`;

const noopSink: DiagnosticCauseSink = () => undefined;
let activeSink: DiagnosticCauseSink = noopSink;

/** Registers the sink that receives captured causes. Call once at startup. */
export const setRuntimeCauseSink = (sink: DiagnosticCauseSink): void => {
  activeSink = sink;
};

/**
 * Captures the cause of `error` for local diagnostics. Best-effort: a logging
 * failure must never alter control flow. No-op until a sink is registered.
 */
export const captureCause = (context: string, error: unknown): void => {
  if (error === null || error === undefined || typeof error !== "object") return;
  const source = error as {
    readonly name?: unknown;
    readonly message?: unknown;
    readonly stack?: unknown;
    readonly code?: unknown;
  };
  const message = typeof source.message === "string" ? source.message : "";
  const stack = typeof source.stack === "string" ? source.stack : undefined;
  // Nothing actionable without at least a message or a stack location.
  if (message === "" && stack === undefined) return;
  try {
    activeSink({
      context,
      name: typeof source.name === "string" && source.name !== "" ? source.name : "Error",
      message: truncate(message, MESSAGE_MAX),
      ...(stack === undefined ? {} : { stack: truncate(stack, STACK_MAX) }),
      ...(typeof source.code === "string" ? { code: source.code } : {}),
    });
  } catch {
    /* never throw from a logger */
  }
};

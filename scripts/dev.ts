import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultPostgresPort = "5432";
const composeService = "postgres";
const composePostgresUser = "hartlib";
const composePostgresPassword = "hartlib";
const postgresIdentifierMaximumBytes = 63;
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const routingQueryKeys = new Set([
  "database",
  "dbname",
  "host",
  "hostaddr",
  "password",
  "port",
  "user",
  "connectionstring",
]);
const credentialQueryKeys = new Set([
  "password",
  "sslpassword",
  "scram_client_key",
  "scram_server_key",
  "oauth_client_secret",
]);
const libpqMaintenanceQueryKeys = new Set([
  "application_name",
  "channel_binding",
  "client_encoding",
  "connect_timeout",
  "fallback_application_name",
  "gssdelegation",
  "gssencmode",
  "gsslib",
  "keepalives",
  "keepalives_count",
  "keepalives_idle",
  "keepalives_interval",
  "krbsrvname",
  "load_balance_hosts",
  "sslcert",
  "sslcompression",
  "sslcrl",
  "sslcrldir",
  "sslkey",
  "sslmode",
  "ssl_max_protocol_version",
  "ssl_min_protocol_version",
  "sslnegotiation",
  "sslrootcert",
  "sslsni",
  "target_session_attrs",
  "tcp_user_timeout",
]);
const supportedDevelopmentPlatforms = new Set<NodeJS.Platform>(["darwin", "linux"]);

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly input?: string;
}

export class DevelopmentSetupFailure extends Error {
  public constructor(
    public readonly stage: string,
    public readonly exitCode: number,
    detail?: string,
  ) {
    super(
      `${stage} failed with exit code ${exitCode}${detail === undefined || detail === "" ? "" : `: ${detail}`}`,
    );
    this.name = "DevelopmentSetupFailure";
  }
}

export const developmentFailureExitCode = (error: unknown): number =>
  error instanceof DevelopmentSetupFailure ? error.exitCode : 1;

type CapturedCommandRunner = (
  command: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

interface DevelopmentPlan {
  readonly databaseUrl: string;
  readonly databaseName: string;
  readonly databasePassword: string;
  readonly environment: Record<string, string>;
}

interface DevelopmentChild {
  readonly label: string;
  readonly command: readonly string[];
}

type DevelopmentSetupCommandRunner = (
  command: readonly string[],
  label: string,
  options: CommandOptions,
  owner: DevelopmentProcessOwner,
) => Promise<void>;

type DevelopmentDatabaseRunner = (
  plan: DevelopmentPlan,
  run: CapturedCommandRunner,
) => Promise<"existing" | "created">;

interface DevelopmentOrchestrationOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly children?: readonly DevelopmentChild[];
  readonly runSetupCommand?: DevelopmentSetupCommandRunner;
  readonly ensureDatabase?: DevelopmentDatabaseRunner;
  readonly runChildren?: DevelopmentChildrenRunner;
  readonly owner?: DevelopmentProcessOwner;
}

type DevelopmentChildrenRunner = (
  children: readonly DevelopmentChild[],
  environment: Record<string, string>,
  owner: DevelopmentProcessOwner,
) => Promise<number>;

export const assertSupportedDevelopmentPlatform = (
  platform: NodeJS.Platform = process.platform,
): void => {
  if (supportedDevelopmentPlatforms.has(platform)) return;
  throw new Error(
    "Local development startup supports macOS and Linux only; Windows and other platforms are not supported",
  );
};

const asEnvironment = (environment: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const parsePort = (value: string | undefined, name: string): string | undefined => {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return undefined;
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(`${name} must be a TCP port between 1 and 65535`);
  }
  const port = Number(trimmed);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535`);
  }
  return String(port);
};

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });

const rawDatabasePath = (databaseUrl: string): string | undefined => {
  const scheme = /^(postgres|postgresql):\/\//iu.exec(databaseUrl);
  if (scheme === null) return undefined;

  const pathStart = scheme[0].length;
  for (let index = pathStart; index < databaseUrl.length; index += 1) {
    const character = databaseUrl[index];
    if (character === "/") {
      const queryOrFragment = databaseUrl.slice(index).search(/[?#]/u);
      return queryOrFragment === -1
        ? databaseUrl.slice(index)
        : databaseUrl.slice(index, index + queryOrFragment);
    }
    if (character === "?" || character === "#") return "";
  }
  return "";
};

const validateRawDatabasePath = (databaseUrl: string): void => {
  const path = rawDatabasePath(databaseUrl);
  if (path === undefined) return;
  if (!/^\/[^/]+$/u.test(path)) {
    throw new Error("DATABASE_URL must contain exactly one database name in its path");
  }

  const databaseSegment = path.slice(1);
  let decodedSegment: string;
  try {
    decodedSegment = decodeURIComponent(databaseSegment);
  } catch {
    throw new Error("DATABASE_URL contains an invalid encoded database name");
  }
  if (decodedSegment === "." || decodedSegment === "..") {
    throw new Error("DATABASE_URL database path must not contain a dot segment");
  }
};

export const validateDatabaseName = (databaseName: string): string => {
  if (databaseName === "" || hasControlCharacter(databaseName)) {
    throw new Error("PostgreSQL database name must be non-empty and contain no control characters");
  }
  const byteLength = new TextEncoder().encode(databaseName).byteLength;
  if (byteLength > postgresIdentifierMaximumBytes) {
    throw new Error(
      `PostgreSQL database name must be at most ${postgresIdentifierMaximumBytes} UTF-8 bytes (received ${byteLength})`,
    );
  }
  return databaseName;
};

const decodeUrlPart = (value: string, label: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`DATABASE_URL contains an invalid encoded ${label}`);
  }
};

const decodeDatabasePart = (value: string): string => {
  let decoded: string;
  let fullyDecoded: string;
  try {
    // pg-connection-string uses decodeURI for the path. Match that behavior
    // before building the canonical URL passed to every child process.
    decoded = decodeURI(value);
    fullyDecoded = decodeURIComponent(value);
  } catch {
    throw new Error("DATABASE_URL contains an invalid encoded database name");
  }
  // pg leaves encoded URI-reserved path characters untouched while other URL
  // consumers decode them. Reject any such spelling instead of allowing two
  // meanings for one DATABASE_URL.
  if (fullyDecoded !== decoded) {
    throw new Error("DATABASE_URL database name contains an encoded path delimiter");
  }
  if (decoded.includes("/") || hasControlCharacter(decoded)) {
    throw new Error("DATABASE_URL must contain one unambiguous database name in its path");
  }
  return validateDatabaseName(decoded);
};

const rejectCredentialQueryKeys = (parsed: URL): void => {
  for (const [key] of parsed.searchParams) {
    if (credentialQueryKeys.has(key.toLowerCase())) {
      throw new Error(`DATABASE_URL query parameter ${key} cannot contain credentials`);
    }
  }
};

const canonicalDatabaseUrl = (
  parsed: URL,
  databaseName: string,
  databaseUser: string,
  databasePassword: string,
  composeHostPort: string,
): string => {
  parsed.protocol = "postgres:";
  parsed.hostname = "127.0.0.1";
  parsed.port = composeHostPort;
  parsed.username = encodeURIComponent(databaseUser);
  parsed.password = databasePassword === "" ? "" : encodeURIComponent(databasePassword);
  // pg-connection-string decodes the path with decodeURI, which leaves URI
  // reserved characters such as `:` and `@` untouched. Keep those characters
  // unescaped so the canonical URL names the same database in pg and here.
  parsed.pathname = `/${encodeURI(databaseName)}`;
  return parsed.toString();
};

export const createDevelopmentPlan = (
  environment: NodeJS.ProcessEnv = process.env,
): DevelopmentPlan => {
  const configuredHostPort = parsePort(
    environment.HARTLIB_POSTGRES_HOST_PORT,
    "HARTLIB_POSTGRES_HOST_PORT",
  );
  const suppliedDatabaseUrl = environment.DATABASE_URL;
  if (suppliedDatabaseUrl !== undefined && hasControlCharacter(suppliedDatabaseUrl)) {
    throw new Error("DATABASE_URL must not contain raw ASCII control characters");
  }
  // Keep the existing acceptance of surrounding non-control whitespace, but
  // inspect raw controls before trim can remove them.
  const rawDatabaseUrl = suppliedDatabaseUrl?.trim() ?? "";
  const initialDatabaseUrl =
    rawDatabaseUrl === ""
      ? `postgres://${composePostgresUser}:${composePostgresPassword}@127.0.0.1:${configuredHostPort ?? defaultPostgresPort}/hartlib`
      : rawDatabaseUrl;

  // WHATWG URL normalizes dot segments. Validate the original path first so
  // the maintenance command and app URL cannot name different databases.
  validateRawDatabasePath(initialDatabaseUrl);

  let parsed: URL;
  try {
    parsed = new URL(initialDatabaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }
  if (!loopbackHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error("DATABASE_URL host must be localhost, 127.0.0.1, or ::1 for local development");
  }
  if (parsed.hash !== "") {
    throw new Error("DATABASE_URL must not contain a fragment");
  }
  rejectCredentialQueryKeys(parsed);
  for (const [key] of parsed.searchParams) {
    if (routingQueryKeys.has(key.toLowerCase())) {
      throw new Error(
        `DATABASE_URL query parameter ${key} cannot override the local connection target`,
      );
    }
  }

  const databaseUrlPort = parsePort(parsed.port, "DATABASE_URL port");
  if (
    configuredHostPort !== undefined &&
    databaseUrlPort !== undefined &&
    configuredHostPort !== databaseUrlPort
  ) {
    throw new Error(
      `DATABASE_URL port ${databaseUrlPort} does not match HARTLIB_POSTGRES_HOST_PORT ${configuredHostPort}`,
    );
  }
  const composeHostPort = configuredHostPort ?? databaseUrlPort ?? defaultPostgresPort;
  if (parsed.hostname === "" || parsed.pathname === "" || parsed.pathname === "/") {
    throw new Error("DATABASE_URL must contain one database name in its path");
  }
  const databaseName = decodeDatabasePart(parsed.pathname.slice(1));

  if (parsed.username === "") {
    throw new Error("DATABASE_URL must contain an explicit database user");
  }
  const databaseUser = decodeUrlPart(parsed.username, "database user");
  if (databaseUser === "" || hasControlCharacter(databaseUser)) {
    throw new Error("DATABASE_URL must contain one unambiguous database user");
  }

  const databasePassword = decodeUrlPart(parsed.password, "database password");
  if (hasControlCharacter(databasePassword)) {
    throw new Error("DATABASE_URL must contain a database password with no control characters");
  }

  const databaseUrl = canonicalDatabaseUrl(
    parsed,
    databaseName,
    databaseUser,
    databasePassword,
    composeHostPort,
  );
  const childEnvironment = asEnvironment(environment);
  childEnvironment.DATABASE_URL = databaseUrl;
  childEnvironment.HARTLIB_POSTGRES_HOST_PORT = composeHostPort;

  return {
    databaseUrl,
    databaseName,
    databasePassword,
    environment: childEnvironment,
  };
};

const writeSubprocessInput = (child: Bun.Subprocess, input: string): void => {
  const stdin = child.stdin;
  if (stdin === undefined || typeof stdin === "number") return;
  stdin.write(input);
  stdin.end();
};

export const databaseCheckSql = (databaseName: string): string => {
  validateDatabaseName(databaseName);
  return "select 1 from pg_database where datname = :'database_name' limit 1;\n";
};

export const databaseCreateSql = (databaseName: string): string => {
  validateDatabaseName(databaseName);
  return 'create database :"database_name";\n';
};

const maintenanceDatabaseUrl = (plan: DevelopmentPlan): string => {
  let parsed: URL;
  try {
    parsed = new URL(plan.databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }
  rejectCredentialQueryKeys(parsed);
  const maintenanceQuery: string[] = [];
  for (const [key, value] of parsed.searchParams) {
    const normalizedKey = key.toLowerCase();
    if (libpqMaintenanceQueryKeys.has(normalizedKey)) {
      maintenanceQuery.push(`${encodeURIComponent(normalizedKey)}=${encodeURIComponent(value)}`);
    }
  }
  // psql runs in the Compose container and reaches PostgreSQL over the
  // container's local TCP endpoint. The password stays in PGPASSWORD rather
  // than in this argument or in command output.
  parsed.hostname = "127.0.0.1";
  parsed.port = defaultPostgresPort;
  parsed.pathname = "/postgres";
  parsed.password = "";
  parsed.search = maintenanceQuery.join("&");
  return parsed.toString();
};

const databaseCommand = (
  plan: DevelopmentPlan,
  databaseName: string,
  sqlArguments: readonly string[],
): readonly string[] => {
  validateDatabaseName(databaseName);
  return [
    "docker",
    "compose",
    "exec",
    "-T",
    "-e",
    "PGPASSWORD",
    composeService,
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "--dbname",
    maintenanceDatabaseUrl(plan),
    ...sqlArguments,
  ];
};

export const databaseCheckCommand = (
  plan: DevelopmentPlan,
  databaseName: string,
): readonly string[] => {
  return databaseCommand(plan, databaseName, [
    "-A",
    "-t",
    "-q",
    "-v",
    `database_name=${databaseName}`,
    "-f",
    "-",
  ]);
};

export const databaseCreateCommand = (
  plan: DevelopmentPlan,
  databaseName: string,
): readonly string[] => {
  return databaseCommand(plan, databaseName, ["-v", `database_name=${databaseName}`, "-f", "-"]);
};

const databaseCommandOptions = (plan: DevelopmentPlan, input: string): CommandOptions => ({
  cwd: repositoryRoot,
  env: {
    ...asEnvironment(process.env),
    ...plan.environment,
    PGPASSWORD: plan.databasePassword,
  },
  input,
});

const conciseOutput = (value: string, redactions: readonly string[] = []): string => {
  const redactedValue = [...new Set(redactions)]
    .filter((redaction) => redaction !== "")
    .sort((left, right) => right.length - left.length)
    .reduce((output, redaction) => output.split(redaction).join("<redacted>"), value);
  const lines = redactedValue
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.slice(-2).join("; ").slice(0, 400);
};

export const ensureDevelopmentDatabase = async (
  plan: DevelopmentPlan,
  run: CapturedCommandRunner,
): Promise<"existing" | "created"> => {
  validateDatabaseName(plan.databaseName);
  const passwordRedactions = [plan.databasePassword, encodeURIComponent(plan.databasePassword)];
  const checkOptions = databaseCommandOptions(plan, databaseCheckSql(plan.databaseName));
  const check = await run(databaseCheckCommand(plan, plan.databaseName), checkOptions);
  if (check.exitCode !== 0) {
    const detail = conciseOutput(check.stderr, passwordRedactions);
    throw new DevelopmentSetupFailure(
      "PostgreSQL database inspection",
      check.exitCode,
      `Could not inspect PostgreSQL databases${detail ? `: ${detail}` : ""}`,
    );
  }
  const checkOutput = check.stdout.trim();
  if (checkOutput === "1") return "existing";
  if (checkOutput !== "") {
    const detail = conciseOutput(checkOutput, passwordRedactions);
    throw new Error(`Could not inspect PostgreSQL databases: unexpected psql output ${detail}`);
  }

  const create = await run(
    databaseCreateCommand(plan, plan.databaseName),
    databaseCommandOptions(plan, databaseCreateSql(plan.databaseName)),
  );
  if (create.exitCode === 0) return "created";

  // CREATE DATABASE has no IF NOT EXISTS form. A concurrent clean startup may
  // win the race; accept that only after verifying the same name now exists.
  const afterRace = await run(databaseCheckCommand(plan, plan.databaseName), checkOptions);
  if (afterRace.exitCode === 0 && afterRace.stdout.trim() === "1") return "existing";

  const detail = conciseOutput(create.stderr, passwordRedactions);
  throw new DevelopmentSetupFailure(
    "PostgreSQL database creation",
    create.exitCode,
    `Could not create PostgreSQL database "${plan.databaseName}"${detail ? `: ${detail}` : ""}`,
  );
};

interface DevelopmentProcessOwnerOptions {
  readonly platform?: NodeJS.Platform;
  readonly gracefulTimeoutMs?: number;
  readonly forcedTimeoutMs?: number;
  readonly processKill?: ProcessGroupKiller;
}

type ProcessGroupKiller = (processId: number, signal: NodeJS.Signals | 0) => void;

type ManagedChild = {
  readonly label: string;
  readonly process: Bun.Subprocess;
};

export class DevelopmentProcessOwner {
  private readonly children = new Set<ManagedChild>();
  private readonly platform: NodeJS.Platform;
  private readonly gracefulTimeoutMs: number;
  private readonly forcedTimeoutMs: number;
  private readonly processKill: ProcessGroupKiller;
  private readonly cleanupFailures: string[] = [];
  private readonly reportedCleanupFailures = new Set<string>();
  private signal: NodeJS.Signals | undefined;
  private installed = false;
  private stopping: Promise<void> | undefined;
  private readonly signalPromise: Promise<NodeJS.Signals>;
  private resolveSignal!: (signal: NodeJS.Signals) => void;
  private readonly onSignal = (signal: NodeJS.Signals): void => {
    if (this.signal !== undefined) return;
    this.signal = signal;
    this.resolveSignal(signal);
    void this.stopAll();
  };

  public constructor(options: DevelopmentProcessOwnerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5_000;
    this.forcedTimeoutMs = options.forcedTimeoutMs ?? 1_000;
    this.processKill =
      options.processKill ?? ((processId, signal) => process.kill(processId, signal));
    this.signalPromise = new Promise<NodeJS.Signals>((resolve) => {
      this.resolveSignal = resolve;
    });
  }

  public get operatingSystem(): NodeJS.Platform {
    return this.platform;
  }

  public install(): void {
    assertSupportedDevelopmentPlatform(this.platform);
    if (this.installed) return;
    this.installed = true;
    process.on("SIGINT", this.onSignal);
    process.on("SIGTERM", this.onSignal);
    process.on("SIGHUP", this.onSignal);
  }

  public dispose(): void {
    if (!this.installed) return;
    this.installed = false;
    process.off("SIGINT", this.onSignal);
    process.off("SIGTERM", this.onSignal);
    process.off("SIGHUP", this.onSignal);
  }

  public get interruptionSignal(): NodeJS.Signals | undefined {
    return this.signal;
  }

  public get interruption(): Promise<NodeJS.Signals> {
    return this.signalPromise;
  }

  public get cleanupErrors(): readonly string[] {
    return [...this.cleanupFailures];
  }

  public spawn(
    command: readonly string[],
    label: string,
    options: CommandOptions & {
      readonly stdio?: [
        "inherit" | "ignore" | "pipe",
        "inherit" | "ignore" | "pipe",
        "inherit" | "ignore" | "pipe",
      ];
    } = {},
  ): Bun.Subprocess {
    assertSupportedDevelopmentPlatform(this.platform);
    if (this.signal !== undefined) {
      throw new DevelopmentInterrupted(this.signal);
    }
    const child = Bun.spawn([...command], {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? asEnvironment(process.env),
      stdio: options.stdio ?? ["inherit", "inherit", "inherit"],
      detached: true,
    });
    this.children.add({ label, process: child });
    return child;
  }

  public async runCaptured(
    command: readonly string[],
    options: CommandOptions = {},
    label = "setup command",
  ): Promise<CommandResult> {
    const child = this.spawn(command, label, {
      ...options,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    try {
      if (options.input !== undefined) {
        writeSubprocessInput(child, options.input);
      }
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout as ReadableStream<Uint8Array>).text(),
        new Response(child.stderr as ReadableStream<Uint8Array>).text(),
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      await this.unregisterCompleted(child);
    }
  }

  public async runInherited(
    command: readonly string[],
    options: CommandOptions = {},
    label = "setup command",
  ): Promise<number> {
    const child = this.spawn(command, label, {
      ...options,
      stdio: ["inherit", "inherit", "inherit"],
    });
    try {
      return await child.exited;
    } finally {
      await this.unregisterCompleted(child);
    }
  }

  public async withInterruption<T>(work: () => Promise<T>): Promise<T> {
    if (this.signal !== undefined) throw new DevelopmentInterrupted(this.signal);
    return Promise.race([
      work(),
      this.interruption.then((signal) => {
        throw new DevelopmentInterrupted(signal);
      }),
    ]);
  }

  public async stopAll(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    const attempt = this.stopAllNow().catch((error) => {
      this.reportCleanupFailure("owner", error instanceof Error ? error.message : String(error));
    });
    let settled: Promise<void>;
    settled = attempt.finally(() => {
      if (this.stopping === settled) this.stopping = undefined;
    });
    this.stopping = settled;
    return settled;
  }

  private async stopAllNow(): Promise<void> {
    const groups = [...this.children];
    await this.terminateGroups(groups);
    await Promise.all(
      groups
        .filter((group) => !this.safeIsGroupRunning(group))
        .map(async (group) => group.process.exited),
    );
    for (const group of groups) {
      if (!this.safeIsGroupRunning(group)) this.children.delete(group);
    }
  }

  private async unregisterCompleted(child: Bun.Subprocess): Promise<void> {
    const managed = [...this.children].find((candidate) => candidate.process === child);
    if (managed === undefined) return;
    await this.terminateGroups([managed]);
    if (!this.safeIsGroupRunning(managed)) this.children.delete(managed);
  }

  private async terminateGroups(groups: readonly ManagedChild[]): Promise<void> {
    const provisionalKillFailures = new Map<ManagedChild, string[]>();
    const attemptTermination = (group: ManagedChild, signal: NodeJS.Signals): void => {
      try {
        this.killProcessGroup(group, signal);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const failures = provisionalKillFailures.get(group) ?? [];
        failures.push(`${signal}: ${detail}`);
        provisionalKillFailures.set(group, failures);
      }
    };
    const running = groups.filter((group) => this.safeIsGroupRunning(group));
    for (const group of running) {
      attemptTermination(group, "SIGTERM");
    }
    await this.waitForGroups(running, this.gracefulTimeoutMs);
    const stillActive = running.filter((group) => this.safeIsGroupRunning(group));
    for (const group of stillActive) {
      attemptTermination(group, "SIGKILL");
    }
    await this.waitForGroups(stillActive, this.forcedTimeoutMs);
    for (const group of groups) {
      if (!this.safeIsGroupRunning(group)) continue;
      for (const failure of provisionalKillFailures.get(group) ?? []) {
        this.reportCleanupFailure(group.label, failure);
      }
      this.reportCleanupFailure(
        group.label,
        "process group is still running after forced termination",
      );
    }
  }

  private safeIsGroupRunning(group: ManagedChild): boolean {
    try {
      return this.isGroupRunning(group);
    } catch (error) {
      this.reportCleanupFailure(
        group.label,
        error instanceof Error ? error.message : String(error),
      );
      return true;
    }
  }

  private isGroupRunning(group: ManagedChild): boolean {
    try {
      this.processKill(-group.process.pid, 0);
      return true;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      throw error;
    }
  }
  private killProcessGroup(group: ManagedChild, signal: NodeJS.Signals): void {
    try {
      this.processKill(-group.process.pid, signal);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
      if (code === "ESRCH") return;
      throw error;
    }
  }

  private async waitForGroups(groups: readonly ManagedChild[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (groups.some((group) => this.safeIsGroupRunning(group)) && Date.now() < deadline) {
      await Bun.sleep(25);
    }
  }

  private reportCleanupFailure(label: string, detail: string): void {
    const key = `${label}: ${detail}`;
    if (this.reportedCleanupFailures.has(key)) return;
    this.reportedCleanupFailures.add(key);
    const message = `[dev] cleanup failed for ${label}: ${detail}`;
    this.cleanupFailures.push(message);
    console.error(message);
  }
}

class DevelopmentInterrupted extends Error {
  public constructor(public readonly signal: NodeJS.Signals) {
    super(`development startup interrupted by ${signal}`);
    this.name = "DevelopmentInterrupted";
  }
}

export const signalExitCode = (signal: NodeJS.Signals): number => {
  if (signal === "SIGHUP") return 129;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
};

const runChecked: DevelopmentSetupCommandRunner = async (
  command: readonly string[],
  label: string,
  options: CommandOptions,
  owner: DevelopmentProcessOwner,
): Promise<void> => {
  let exitCode: number;
  try {
    exitCode = await owner.runInherited(command, options, label);
  } catch (error) {
    if (error instanceof DevelopmentInterrupted || error instanceof DevelopmentSetupFailure) {
      throw error;
    }
    throw new Error(`${label} could not start. Check that Docker and Bun are installed.`);
  }
  if (exitCode !== 0) {
    throw new DevelopmentSetupFailure(label, exitCode, "Fix the reported failure and retry.");
  }
};

export const developmentChildren = (): readonly DevelopmentChild[] => [
  { label: "API", command: [process.execPath, "run", "dev:api"] },
  { label: "worker", command: [process.execPath, "run", "dev:worker"] },
  { label: "demo", command: [process.execPath, "--filter", "@hartlib/demo", "dev"] },
];

export const runDevelopmentChildren = async (
  children: readonly DevelopmentChild[],
  environment: Record<string, string>,
  suppliedOwner?: DevelopmentProcessOwner,
): Promise<number> => {
  const owner = suppliedOwner ?? new DevelopmentProcessOwner();
  assertSupportedDevelopmentPlatform(owner.operatingSystem);
  const ownsOwner = suppliedOwner === undefined;
  owner.install();
  let resolveFirstChildExit!: (outcome: { readonly label: string; readonly code: number }) => void;
  let hasChildExit = false;
  const firstChildExit = new Promise<{ readonly label: string; readonly code: number }>(
    (resolve) => {
      resolveFirstChildExit = resolve;
    },
  );
  try {
    if (children.length === 0) return 0;
    for (const childSpec of children) {
      try {
        const child = owner.spawn(childSpec.command, childSpec.label, {
          cwd: repositoryRoot,
          env: environment,
          stdio: ["inherit", "inherit", "inherit"],
        });
        // Register the completion observer before starting the next child. A
        // first-outcome promise retains the actual completion order even when
        // more than one child settles before the coordinator starts waiting.
        void child.exited.then((code) => {
          if (hasChildExit) return;
          hasChildExit = true;
          resolveFirstChildExit({ label: childSpec.label, code });
        });
      } catch (error) {
        if (error instanceof DevelopmentInterrupted) throw error;
        throw new Error(`${childSpec.label} could not start. Check that Bun is installed.`);
      }
    }

    const outcome = await Promise.race([
      owner.interruption.then((signal: NodeJS.Signals) => ({ kind: "signal" as const, signal })),
      firstChildExit.then((exit) => ({ kind: "exit" as const, ...exit })),
    ]);
    if (outcome.kind === "signal") return signalExitCode(outcome.signal);
    if (outcome.code !== 0) {
      console.error(`[dev] ${outcome.label} stopped with exit code ${outcome.code}`);
    }
    return outcome.code;
  } finally {
    await owner.stopAll();
    if (ownsOwner) owner.dispose();
  }
};

const runSetupStep = async (
  owner: DevelopmentProcessOwner,
  runner: DevelopmentSetupCommandRunner,
  command: readonly string[],
  label: string,
  options: CommandOptions,
): Promise<void> => {
  try {
    await runner(command, label, options, owner);
  } catch (error) {
    if (error instanceof DevelopmentInterrupted || error instanceof DevelopmentSetupFailure) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(detail.startsWith(label) ? detail : `${label} failed: ${detail}`);
  }
};

export const runDevelopment = async (
  options: DevelopmentOrchestrationOptions = {},
): Promise<number> => {
  assertSupportedDevelopmentPlatform(options.owner?.operatingSystem ?? process.platform);
  const owner = options.owner ?? new DevelopmentProcessOwner();
  const ownsOwner = options.owner === undefined;
  owner.install();
  try {
    const plan = createDevelopmentPlan(options.environment ?? process.env);
    const serviceEnvironment = {
      ...plan.environment,
      // The orchestrator owns the single migration step before any app starts.
      WORKER_RUN_MIGRATIONS_ON_STARTUP: "false",
    };
    const runSetupCommand = options.runSetupCommand ?? runChecked;
    const ensureDatabase = options.ensureDatabase ?? ensureDevelopmentDatabase;
    const runChildren = options.runChildren ?? runDevelopmentChildren;

    await owner.withInterruption(() =>
      runSetupStep(
        owner,
        runSetupCommand,
        ["docker", "compose", "up", "--detach", "--wait", composeService],
        "PostgreSQL startup",
        { cwd: repositoryRoot, env: plan.environment },
      ),
    );
    if (owner.interruptionSignal !== undefined) {
      return signalExitCode(owner.interruptionSignal);
    }
    const databaseState = await owner.withInterruption(() =>
      ensureDatabase(plan, owner.runCaptured.bind(owner)),
    );
    if (owner.interruptionSignal !== undefined) {
      return signalExitCode(owner.interruptionSignal);
    }
    console.log(
      `[dev] PostgreSQL database "${plan.databaseName}" ${databaseState === "created" ? "created" : "ready"}`,
    );
    await owner.withInterruption(() =>
      runSetupStep(
        owner,
        runSetupCommand,
        [process.execPath, "run", "db:migrate"],
        "Database migrations",
        { cwd: repositoryRoot, env: plan.environment },
      ),
    );
    if (owner.interruptionSignal !== undefined) {
      return signalExitCode(owner.interruptionSignal);
    }
    console.log("[dev] Database migrations complete; starting API, worker, and demo");
    const childExitCode = await owner.withInterruption(() =>
      runChildren(options.children ?? developmentChildren(), serviceEnvironment, owner),
    );
    return owner.interruptionSignal === undefined
      ? childExitCode
      : signalExitCode(owner.interruptionSignal);
  } catch (error) {
    if (error instanceof DevelopmentInterrupted) return signalExitCode(error.signal);
    if (owner.interruptionSignal !== undefined) return signalExitCode(owner.interruptionSignal);
    throw error;
  } finally {
    await owner.stopAll();
    if (ownsOwner) owner.dispose();
  }
};

if (import.meta.main) {
  try {
    process.exitCode = await runDevelopment();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dev] ${message}`);
    console.error("[dev] Fix the reported setup problem, then run bun run dev:demo again.");
    process.exitCode = developmentFailureExitCode(error);
  }
}

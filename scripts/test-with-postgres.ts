import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const postgresUser = "hartlib";
const postgresPassword = "hartlib";
const postgresPort = "5432";
const composeProject = `hartlib-test-${process.pid}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

const run = async (
  command: readonly string[],
  options: { readonly output?: boolean; readonly env?: Record<string, string> } = {},
): Promise<number> => {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    env: { ...process.env, ...options.env },
    stderr: options.output === false ? "ignore" : "inherit",
    stdout: options.output === false ? "ignore" : "inherit",
  });
  return child.exited;
};

const capture = async (command: readonly string[]): Promise<string> => {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`command failed with exit code ${exitCode}: ${command.join(" ")}\n${stderr}`);
  }
  return stdout.trim();
};

const runOrThrow = async (
  command: readonly string[],
  options: { readonly env?: Record<string, string> } = {},
): Promise<void> => {
  const exitCode = await run(command, options);
  if (exitCode !== 0) {
    throw new Error(`command failed with exit code ${exitCode}: ${command.join(" ")}`);
  }
};

const compose = (...arguments_: readonly string[]): readonly string[] => [
  "docker",
  "compose",
  "-p",
  composeProject,
  ...arguments_,
];

const waitForPostgres = async (): Promise<void> => {
  const readinessCommand = compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    postgresUser,
    "-d",
    "postgres",
    "-c",
    "select 1",
  );

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await run(readinessCommand, { output: false })) === 0) return;
    await Bun.sleep(1_000);
  }

  throw new Error("Postgres did not become ready within 60 seconds");
};

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const createTestDatabase = async (): Promise<string> => {
  const name = `hartlib_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  await runOrThrow(
    compose(
      "exec",
      "-T",
      "postgres",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      postgresUser,
      "-d",
      "postgres",
      "-c",
      `create database ${quoteIdentifier(name)}`,
    ),
  );
  return name;
};

const dropTestDatabase = async (name: string): Promise<void> => {
  await runOrThrow(
    compose(
      "exec",
      "-T",
      "postgres",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      postgresUser,
      "-d",
      "postgres",
      "-c",
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}' and pid <> pg_backend_pid()`,
    ),
  );
  await runOrThrow(
    compose(
      "exec",
      "-T",
      "postgres",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      postgresUser,
      "-d",
      "postgres",
      "-c",
      `drop database if exists ${quoteIdentifier(name)}`,
    ),
  );
};

const publishedPort = async (): Promise<string> => {
  const binding = await capture(compose("port", "postgres", postgresPort));
  const port = binding.match(/:(\d+)\s*$/)?.[1];
  if (port === undefined) {
    throw new Error(`could not determine the temporary Postgres port from ${binding}`);
  }
  return port;
};

const databaseUrl = (name: string, port: string): string =>
  `postgres://${postgresUser}:${postgresPassword}@127.0.0.1:${port}/${name}`;

let testDatabaseName: string | undefined;
let exitCode = 1;
try {
  await runOrThrow(compose("up", "-d", "--wait", "postgres"), {
    env: { HARTLIB_POSTGRES_HOST_PORT: "0" },
  });
  await waitForPostgres();
  const port = await publishedPort();
  testDatabaseName = await createTestDatabase();
  const testDatabaseUrl = databaseUrl(testDatabaseName, port);
  const testEnvironment = {
    DATABASE_URL: testDatabaseUrl,
    WORKER_POSTGRES_TEST_DATABASE_URL: testDatabaseUrl,
  };

  await runOrThrow(["bun", "run", "db:migrate"], { env: testEnvironment });
  exitCode = await run(["bunx", "--bun", "vitest", "run", "--root", ".", ...Bun.argv.slice(2)], {
    env: testEnvironment,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  if (testDatabaseName !== undefined) {
    try {
      await dropTestDatabase(testDatabaseName);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      exitCode = 1;
    }
  }
  try {
    await runOrThrow(compose("down", "-v", "--remove-orphans"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    exitCode = 1;
  }
}

process.exitCode = exitCode;

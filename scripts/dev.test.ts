import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  createDevelopmentPlan,
  assertSupportedDevelopmentPlatform,
  databaseCheckCommand,
  databaseCheckSql,
  databaseCreateCommand,
  databaseCreateSql,
  developmentFailureExitCode,
  ensureDevelopmentDatabase,
  DevelopmentProcessOwner,
  DevelopmentSetupFailure,
  runDevelopment,
  runDevelopmentChildren,
  signalExitCode,
  validateDatabaseName,
  developmentChildren,
  type CommandOptions,
  type CommandResult,
} from "./dev";

const result = (overrides: Partial<CommandResult> = {}): CommandResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  ...overrides,
});

const handledSignals = [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const;

const readPidFile = async (marker: string): Promise<number | undefined> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return Number((await readFile(marker, "utf8")).trim());
    } catch {
      await Bun.sleep(10);
    }
  }
  return undefined;
};

describe("local development startup contract", () => {
  it("publishes PostgreSQL only on loopback without a host-gateway mapping", async () => {
    const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");

    expect(compose).toContain('"127.0.0.1:${HARTLIB_POSTGRES_HOST_PORT:-5432}:5432"');
    expect(compose).toContain(
      'test: ["CMD-SHELL", "pg_isready -U hartlib -d postgres -h 127.0.0.1 -p 5432"]',
    );
    expect(compose).not.toContain("host.docker.internal");
    expect(compose).not.toContain("host-gateway");
  });

  it("uses the configured host port for the default database URL", () => {
    const plan = createDevelopmentPlan({ HARTLIB_POSTGRES_HOST_PORT: "5433" });

    expect(plan.environment.HARTLIB_POSTGRES_HOST_PORT).toBe("5433");
    expect(plan.databaseName).toBe("hartlib");
    expect(plan.databaseUrl).toBe("postgres://hartlib:hartlib@127.0.0.1:5433/hartlib");
    expect(plan.environment.DATABASE_URL).toBe(plan.databaseUrl);
  });

  it("preserves an explicit database URL and rejects a port mismatch", () => {
    const plan = createDevelopmentPlan({
      DATABASE_URL: "postgres://hartlib:secret@127.0.0.1:5433/hartlib_dev?sslmode=disable",
      HARTLIB_POSTGRES_HOST_PORT: "5433",
    });
    expect(plan.databaseUrl).toBe(
      "postgres://hartlib:secret@127.0.0.1:5433/hartlib_dev?sslmode=disable",
    );
    expect(plan.databaseName).toBe("hartlib_dev");
    expect(plan.databasePassword).toBe("secret");
    expect(() =>
      createDevelopmentPlan({
        DATABASE_URL: "postgres://hartlib:secret@127.0.0.1:5432/hartlib",
        HARTLIB_POSTGRES_HOST_PORT: "5433",
      }),
    ).toThrow("does not match HARTLIB_POSTGRES_HOST_PORT");
  });

  it("canonicalizes loopback URLs and preserves only non-routing query options", () => {
    const plan = createDevelopmentPlan({
      DATABASE_URL: "postgresql://hartlib:secret@localhost/hartlib_dev?sslmode=disable",
      HARTLIB_POSTGRES_HOST_PORT: "5433",
    });

    expect(plan.databaseUrl).toBe(
      "postgres://hartlib:secret@127.0.0.1:5433/hartlib_dev?sslmode=disable",
    );
    expect(plan.environment.DATABASE_URL).toBe(plan.databaseUrl);
  });

  it.each(["connectionString", "ConnectionString", "CONNECTIONSTRING"])(
    "rejects %s before it can override the canonical runtime target",
    (queryKey) => {
      const connectionString = encodeURIComponent(
        "postgres://attacker:secret@127.0.0.1:6543/unrelated",
      );

      expect(() =>
        createDevelopmentPlan({
          DATABASE_URL: `postgres://hartlib:secret@127.0.0.1:5433/hartlib?sslmode=disable&${queryKey}=${connectionString}`,
          HARTLIB_POSTGRES_HOST_PORT: "5433",
        }),
      ).toThrow(
        `DATABASE_URL query parameter ${queryKey} cannot override the local connection target`,
      );
    },
  );

  it.each([
    ["password", "database-password"],
    ["SSLPassword", "ssl-password"],
    ["scram_client_key", "scram-client-key"],
    ["SCRAM_SERVER_KEY", "scram-server-key"],
    ["Oauth_Client_Secret", "oauth-client-secret"],
  ] as const)("rejects credential-bearing PostgreSQL query key %s", (queryKey, secret) => {
    const encodedSecret = encodeURIComponent(secret);
    const error = (() => {
      try {
        createDevelopmentPlan({
          DATABASE_URL: `postgres://hartlib:hartlib@127.0.0.1/hartlib?${queryKey}=${encodedSecret}`,
        });
        return undefined;
      } catch (failure: unknown) {
        return failure instanceof Error ? failure : new Error(String(failure));
      }
    })();

    expect(error?.message).toContain(queryKey);
    expect(error?.message).toContain("credentials");
    expect(error?.message).not.toContain(secret);
    expect(error?.message).not.toContain(encodedSecret);
  });

  it("rejects credential query keys before a maintenance command can be built", () => {
    const secret = "forged-ssl-password";
    const plan = {
      ...createDevelopmentPlan({}),
      databaseUrl: `postgres://hartlib:hartlib@127.0.0.1/hartlib?sslpassword=${encodeURIComponent(secret)}`,
    };

    const failure = (() => {
      try {
        databaseCheckCommand(plan, "hartlib");
        return undefined;
      } catch (error: unknown) {
        return error instanceof Error ? error : new Error(String(error));
      }
    })();

    expect(failure?.message).toContain("sslpassword");
    expect(failure?.message).not.toContain(secret);
  });

  it("does not echo malformed maintenance URLs in command-builder errors", () => {
    const secret = "malformed-ssl-password";
    const plan = {
      ...createDevelopmentPlan({}),
      databaseUrl: `not-a-url?sslpassword=${secret}`,
    };

    const failure = (() => {
      try {
        databaseCheckCommand(plan, "hartlib");
        return undefined;
      } catch (error: unknown) {
        return error instanceof Error ? error : new Error(String(error));
      }
    })();

    expect(failure?.message).toContain("valid PostgreSQL connection URL");
    expect(failure?.message).not.toContain(secret);
  });

  it("keeps pg's URI-reserved database-name characters stable", () => {
    const plan = createDevelopmentPlan({
      DATABASE_URL: "postgres://hartlib:secret@127.0.0.1:5433/source:mail@example",
      HARTLIB_POSTGRES_HOST_PORT: "5433",
    });

    expect(plan.databaseName).toBe("source:mail@example");
    expect(plan.databaseUrl).toBe("postgres://hartlib:secret@127.0.0.1:5433/source:mail@example");
  });

  it.each([
    ["TAB", "postgres://hartlib:secret@127.0.0.1/hart\tlib"],
    ["CR", "postgres://hartlib:secret@127.0.0.1/hart\rlib"],
    ["LF", "postgres://hartlib:secret@127.0.0.1/hart\nlib"],
  ])("rejects a raw %s before WHATWG URL parsing", (_name, databaseUrl) => {
    expect(() => createDevelopmentPlan({ DATABASE_URL: databaseUrl })).toThrow(
      "raw ASCII control characters",
    );
  });

  it.each([
    ["a literal current-directory segment", "postgres://hartlib:secret@127.0.0.1/."],
    ["a literal parent-directory segment", "postgres://hartlib:secret@127.0.0.1/.."],
    ["an encoded current-directory segment", "postgres://hartlib:secret@127.0.0.1/%2E"],
    ["an encoded parent-directory segment", "postgres://hartlib:secret@127.0.0.1/%2e%2E"],
    ["a mixed encoded parent-directory segment", "postgres://hartlib:secret@127.0.0.1/.%2e"],
  ])("rejects %s before URL path normalization", (_name, databaseUrl) => {
    expect(() => createDevelopmentPlan({ DATABASE_URL: databaseUrl })).toThrow("dot segment");
  });

  it("requires exactly one raw database path segment", () => {
    expect(() =>
      createDevelopmentPlan({
        DATABASE_URL: "postgres://hartlib:secret@127.0.0.1/hartlib/other?sslmode=disable",
      }),
    ).toThrow("exactly one database name");
  });

  it.each([
    ["a remote host", "postgres://hartlib:secret@db.example/hartlib", "host"],
    ["a hostless URL", "postgres:///hartlib", "host"],
    [
      "a query host override",
      "postgres://hartlib:secret@127.0.0.1/hartlib?host=db.example",
      "query parameter host",
    ],
    [
      "a query port override",
      "postgres://hartlib:secret@127.0.0.1/hartlib?port=5434",
      "query parameter port",
    ],
    [
      "a query user override",
      "postgres://hartlib:secret@127.0.0.1/hartlib?user=other",
      "query parameter user",
    ],
    [
      "an encoded path delimiter",
      "postgres://hartlib:secret@127.0.0.1/hartlib%2Fother",
      "encoded path delimiter",
    ],
    [
      "an encoded URI-reserved name character",
      "postgres://hartlib:secret@127.0.0.1/hartlib%3Aother",
      "encoded path delimiter",
    ],
  ])("rejects %s", (_label, url, message) => {
    expect(() => createDevelopmentPlan({ DATABASE_URL: url })).toThrow(message);
  });

  it("rejects URL fragments and missing users instead of falling back to pg defaults", () => {
    expect(() =>
      createDevelopmentPlan({
        DATABASE_URL: "postgres://hartlib:secret@127.0.0.1/hartlib#fragment",
      }),
    ).toThrow("fragment");
    expect(() => createDevelopmentPlan({ DATABASE_URL: "postgres://127.0.0.1/hartlib" })).toThrow(
      "explicit database user",
    );
  });

  it("enforces PostgreSQL's 63-byte identifier limit, including UTF-8 bytes", () => {
    expect(validateDatabaseName("a".repeat(63))).toBe("a".repeat(63));
    expect(() => validateDatabaseName("a".repeat(64))).toThrow("at most 63 UTF-8 bytes");
    expect(validateDatabaseName("é".repeat(31) + "a")).toHaveLength(32);
    expect(() => validateDatabaseName("é".repeat(32))).toThrow("at most 63 UTF-8 bytes");
    expect(() =>
      createDevelopmentPlan({
        DATABASE_URL: `postgres://hartlib:secret@127.0.0.1/${"a".repeat(64)}`,
      }),
    ).toThrow("at most 63 UTF-8 bytes");
  });

  it("passes punctuation-heavy names through psql literal and identifier variables", () => {
    const name = `O'Reilly\\archive"quoted`;
    const plan = createDevelopmentPlan({});
    expect(databaseCheckSql(name)).toBe(
      "select 1 from pg_database where datname = :'database_name' limit 1;\n",
    );
    expect(databaseCheckSql(name)).not.toContain(name);
    expect(databaseCreateSql(name)).not.toContain(name);
    expect(databaseCheckCommand(plan, name)).toContain(`database_name=${name}`);
    expect(databaseCreateSql(name)).toBe('create database :"database_name";\n');
    expect(databaseCreateCommand(plan, name)).toContain(`database_name=${name}`);
  });

  it("uses the container-local TCP endpoint and decoded DATABASE_URL credentials for psql", async () => {
    const plan = createDevelopmentPlan({
      DATABASE_URL: "postgresql://hartlib:p%40ss@localhost/hartlib_dev?sslmode=disable",
      HARTLIB_POSTGRES_HOST_PORT: "5433",
    });
    const calls: { readonly command: readonly string[]; readonly options: CommandOptions }[] = [];
    const state = await ensureDevelopmentDatabase(plan, async (command, options) => {
      calls.push({ command, options: options as CommandOptions });
      return result({ stdout: "1\n" });
    });

    expect(state).toBe("existing");
    expect(calls).toHaveLength(1);
    const command = calls[0]?.command ?? [];
    expect(command.join(" ")).toContain("127.0.0.1:5432/postgres");
    expect(command.join(" ")).not.toContain("host.docker.internal");
    expect(command.join(" ")).not.toContain(":5433/postgres");
    expect(command.join(" ")).toContain("sslmode=disable");
    expect(command.join(" ")).not.toContain("p%40ss");
    expect(command.join(" ")).not.toContain("p@ss");
    expect(calls[0]?.options.env?.PGPASSWORD).toBe("p@ss");
    expect(calls[0]?.options.env?.DATABASE_URL).toBe(
      "postgres://hartlib:p%40ss@127.0.0.1:5433/hartlib_dev?sslmode=disable",
    );
  });

  it("keeps statement_timeout for apps but omits it from the libpq maintenance URL", () => {
    const plan = createDevelopmentPlan({
      DATABASE_URL:
        "postgres://hartlib:secret@127.0.0.1:5433/hartlib_dev?statement_timeout=5000&sslmode=disable",
      HARTLIB_POSTGRES_HOST_PORT: "5433",
    });

    expect(plan.databaseUrl).toContain("statement_timeout=5000");
    const command = databaseCheckCommand(plan, plan.databaseName);
    expect(command.join(" ")).toContain("sslmode=disable");
    expect(command.join(" ")).not.toContain("statement_timeout");
  });

  it("rejects a wrong password before it can create or migrate the database", async () => {
    const plan = createDevelopmentPlan({
      DATABASE_URL: "postgres://hartlib:wrong-password@127.0.0.1:5433/hartlib_wrong_password",
      HARTLIB_POSTGRES_HOST_PORT: "5433",
    });
    const calls: (readonly string[])[] = [];
    const failure = await ensureDevelopmentDatabase(plan, async (command) => {
      calls.push(command);
      return result({
        exitCode: 2,
        stderr:
          'FATAL: password authentication failed for user "hartlib" (postgres://hartlib:wrong-password@127.0.0.1:5433/hartlib_wrong_password)',
      });
    }).then(
      () => new Error("expected database inspection to fail"),
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    expect(failure.message).toContain("password authentication failed");
    expect(failure.message).not.toContain("wrong-password");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.join(" ")).not.toContain("wrong-password");
  });

  it("redacts raw and encoded passwords before concise inspection output is truncated", async () => {
    const password = `/inspect-secret+${"x".repeat(480)}`;
    const encodedPassword = encodeURIComponent(password);
    const plan = createDevelopmentPlan({
      DATABASE_URL: `postgres://hartlib:${encodedPassword}@127.0.0.1:5433/hartlib-inspection-secret`,
      HARTLIB_POSTGRES_HOST_PORT: "5433",
    });

    const inspect = (stderr: string) =>
      ensureDevelopmentDatabase(plan, async () => result({ exitCode: 1, stderr })).then(
        () => new Error("expected database inspection to fail"),
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      );
    const rawFailure = await inspect(`FATAL: ${"x".repeat(380)}${password}`);
    const encodedFailure = await inspect(`FATAL: ${"y".repeat(380)}${encodedPassword}`);

    expect(rawFailure.message).not.toContain(password.slice(0, 13));
    expect(encodedFailure.message).not.toContain(encodedPassword.slice(0, 13));
  });

  it("redacts raw and encoded passwords before concise creation output is truncated", async () => {
    const password = `+create-secret/${"y".repeat(480)}`;
    const encodedPassword = encodeURIComponent(password);
    const plan = createDevelopmentPlan({
      DATABASE_URL: `postgres://hartlib:${encodedPassword}@127.0.0.1:5433/hartlib-creation-secret`,
      HARTLIB_POSTGRES_HOST_PORT: "5433",
    });

    const create = (stderr: string) => {
      let calls = 0;
      return ensureDevelopmentDatabase(plan, async () => {
        calls += 1;
        if (calls === 1) return result();
        if (calls === 2) return result({ exitCode: 1, stderr });
        return result();
      }).then(
        () => new Error("expected database creation to fail"),
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      );
    };
    const rawFailure = await create(`ERROR: ${"x".repeat(380)}${password}`);
    const encodedFailure = await create(`ERROR: ${"y".repeat(380)}${encodedPassword}`);

    expect(rawFailure.message).not.toContain(password.slice(0, 13));
    expect(encodedFailure.message).not.toContain(encodedPassword.slice(0, 13));
  });

  it("does not issue CREATE DATABASE when the configured database exists", async () => {
    const plan = createDevelopmentPlan({
      DATABASE_URL: "postgres://hartlib:hartlib@127.0.0.1:5433/hartlib",
      HARTLIB_POSTGRES_HOST_PORT: "5433",
    });
    const calls: (readonly string[])[] = [];
    const state = await ensureDevelopmentDatabase(plan, async (command, options) => {
      calls.push(command);
      expect(options?.input).toBe(databaseCheckSql("hartlib"));
      return result({ stdout: "1\n" });
    });

    expect(state).toBe("existing");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.join(" ")).not.toContain("create database");
  });

  it("creates only a missing database and accepts a concurrent creator", async () => {
    const plan = createDevelopmentPlan({
      DATABASE_URL: "postgres://hartlib:hartlib@127.0.0.1:5433/hartlib-dev",
      HARTLIB_POSTGRES_HOST_PORT: "5433",
    });
    const calls: (readonly string[])[] = [];
    let checkCount = 0;
    const state = await ensureDevelopmentDatabase(plan, async (command, options) => {
      calls.push(command);
      if (options?.input === databaseCreateSql("hartlib-dev")) {
        return result({ exitCode: 1, stderr: "already exists" });
      }
      checkCount += 1;
      return result({ stdout: checkCount === 1 ? "" : "1\n" });
    });

    expect(state).toBe("existing");
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual(databaseCreateCommand(plan, "hartlib-dev"));
  });

  it("creates a missing database on the normal path", async () => {
    const plan = createDevelopmentPlan({
      DATABASE_URL: "postgres://hartlib:hartlib@127.0.0.1:5433/hartlib-new",
      HARTLIB_POSTGRES_HOST_PORT: "5433",
    });
    const calls: { readonly command: readonly string[]; readonly input: string | undefined }[] = [];
    const state = await ensureDevelopmentDatabase(plan, async (command, options) => {
      calls.push({ command, input: options?.input });
      return calls.length === 1 ? result() : result({ stdout: "" });
    });

    expect(state).toBe("created");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toBe(databaseCheckSql("hartlib-new"));
    expect(calls[1]?.input).toBe(databaseCreateSql("hartlib-new"));
  });

  it("reports an actionable inspection failure", async () => {
    const plan = createDevelopmentPlan({
      DATABASE_URL: "postgres://hartlib:hartlib@127.0.0.1:5433/hartlib",
      HARTLIB_POSTGRES_HOST_PORT: "5433",
    });
    await expect(
      ensureDevelopmentDatabase(plan, async () =>
        result({ exitCode: 1, stderr: "connection refused" }),
      ),
    ).rejects.toThrow("Could not inspect PostgreSQL databases: connection refused");
  });

  it("keeps Docker, psql, and migration setup exit statuses typed through the CLI boundary", async () => {
    const databasePlan = createDevelopmentPlan({
      DATABASE_URL: "postgres://hartlib:hartlib@127.0.0.1:5433/hartlib",
      HARTLIB_POSTGRES_HOST_PORT: "5433",
    });
    const psqlFailure = await ensureDevelopmentDatabase(databasePlan, async () =>
      result({ exitCode: 37, stderr: "psql could not connect" }),
    ).then(
      () => new Error("expected psql setup failure"),
      (error: unknown) => error,
    );

    expect(psqlFailure).toBeInstanceOf(DevelopmentSetupFailure);
    expect(psqlFailure).toMatchObject({
      stage: "PostgreSQL database inspection",
      exitCode: 37,
    });
    expect(developmentFailureExitCode(psqlFailure)).toBe(37);

    const runSetupFailure = async (
      exitCodes: readonly number[],
    ): Promise<DevelopmentSetupFailure> => {
      const owner = new DevelopmentProcessOwner();
      const remainingCodes = [...exitCodes];
      owner.runInherited = async (): Promise<number> => remainingCodes.shift() ?? 0;
      try {
        return await runDevelopment({
          owner,
          environment: {
            DATABASE_URL: "postgres://hartlib:hartlib@127.0.0.1:5433/hartlib",
            HARTLIB_POSTGRES_HOST_PORT: "5433",
          },
          ensureDatabase: async () => "existing",
          runChildren: async () => 0,
        }).then(
          () => new DevelopmentSetupFailure("test", 0),
          (error: unknown) => {
            if (error instanceof DevelopmentSetupFailure) return error;
            throw error;
          },
        );
      } finally {
        owner.dispose();
      }
    };

    const dockerFailure = await runSetupFailure([41]);
    expect(dockerFailure).toMatchObject({ stage: "PostgreSQL startup", exitCode: 41 });
    expect(developmentFailureExitCode(dockerFailure)).toBe(41);

    const migrationFailure = await runSetupFailure([0, 43]);
    expect(migrationFailure).toMatchObject({ stage: "Database migrations", exitCode: 43 });
    expect(developmentFailureExitCode(migrationFailure)).toBe(43);
  });

  it("labels an injected setup failure with the stage and retry action", async () => {
    await expect(
      runDevelopment({
        environment: {
          DATABASE_URL: "postgres://hartlib:hartlib@127.0.0.1:5433/hartlib",
          HARTLIB_POSTGRES_HOST_PORT: "5433",
        },
        runSetupCommand: async () => {
          throw new Error("Docker daemon unavailable");
        },
        ensureDatabase: async () => "existing",
        runChildren: async () => 0,
      }),
    ).rejects.toThrow("PostgreSQL startup failed: Docker daemon unavailable");
  });

  it("uses one API, worker, and demo child set after migrations", () => {
    const children = developmentChildren();
    expect(children.map((child) => child.label)).toEqual(["API", "worker", "demo"]);
    expect(children.map((child) => child.command.slice(-1)[0])).toEqual([
      "dev:api",
      "dev:worker",
      "dev",
    ]);
  });

  it("runs setup, creation, migration, and children in order with one environment", async () => {
    const events: string[] = [];
    const commands: string[][] = [];
    const setupEnvironments: Record<string, Record<string, string | undefined>> = {};
    let serviceEnvironment: Record<string, string> | undefined;
    const code = await runDevelopment({
      environment: {
        DATABASE_URL: "postgres://hartlib:hartlib@localhost:5433/hartlib-dev",
        HARTLIB_POSTGRES_HOST_PORT: "5433",
      },
      children: [{ label: "fake", command: [process.execPath, "-e", "process.exit(0)"] }],
      runSetupCommand: async (_command, label, options) => {
        events.push(label);
        setupEnvironments[label] = options.env ?? {};
        commands.push([..._command]);
      },
      ensureDatabase: async (plan) => {
        events.push("database");
        expect(plan.databaseUrl).toBe(plan.environment.DATABASE_URL);
        return "created";
      },
      runChildren: async (_children, environment) => {
        events.push("children");
        serviceEnvironment = environment;
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(events).toEqual(["PostgreSQL startup", "database", "Database migrations", "children"]);
    expect(commands).toEqual([
      ["docker", "compose", "up", "--detach", "--wait", "postgres"],
      [process.execPath, "run", "db:migrate"],
    ]);
    expect(setupEnvironments["PostgreSQL startup"]).toMatchObject({
      DATABASE_URL: "postgres://hartlib:hartlib@127.0.0.1:5433/hartlib-dev",
      HARTLIB_POSTGRES_HOST_PORT: "5433",
    });
    expect(setupEnvironments["Database migrations"]).toMatchObject({
      DATABASE_URL: "postgres://hartlib:hartlib@127.0.0.1:5433/hartlib-dev",
      HARTLIB_POSTGRES_HOST_PORT: "5433",
    });
    expect(serviceEnvironment).toMatchObject({
      DATABASE_URL: "postgres://hartlib:hartlib@127.0.0.1:5433/hartlib-dev",
      HARTLIB_POSTGRES_HOST_PORT: "5433",
      WORKER_RUN_MIGRATIONS_ON_STARTUP: "false",
    });
  });

  it("returns the child's exit status and cleans up the managed group", async () => {
    await expect(
      runDevelopmentChildren(
        [{ label: "short-lived", command: [process.execPath, "-e", "process.exit(17)"] }],
        {},
      ),
    ).resolves.toBe(17);
  });

  it.skipIf(process.platform === "win32")(
    "returns a later child's nonzero status when it settles first",
    async () => {
      await expect(
        runDevelopmentChildren(
          [
            {
              label: "earlier zero",
              command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 250)"],
            },
            {
              label: "later nonzero",
              command: [process.execPath, "-e", "setTimeout(() => process.exit(29), 25)"],
            },
          ],
          {},
        ),
      ).resolves.toBe(29);
    },
  );

  it("rejects Windows before spawning any setup or application process", async () => {
    expect(() => assertSupportedDevelopmentPlatform("win32")).toThrow("macOS and Linux only");
    const owner = new DevelopmentProcessOwner({ platform: "win32" });
    try {
      await expect(
        runDevelopmentChildren(
          [{ label: "never spawned", command: [process.execPath, "-e", "process.exit(0)"] }],
          {},
          owner,
        ),
      ).rejects.toThrow("macOS and Linux only");
      await expect(
        runDevelopment({
          owner,
          runSetupCommand: async () => undefined,
          ensureDatabase: async () => "existing",
          runChildren: async () => 0,
        }),
      ).rejects.toThrow("macOS and Linux only");
    } finally {
      owner.dispose();
    }
  });

  it.skipIf(process.platform === "win32")(
    "reaps completed setup groups before later cleanup can revisit them",
    async () => {
      const marker = `/tmp/hartlib-dev-completed-setup-${randomUUID()}`;
      const signalMarker = `${marker}-signal`;
      const owner = new DevelopmentProcessOwner();
      try {
        await owner.runInherited(
          [
            "sh",
            "-c",
            `(trap 'printf term >> ${signalMarker}' TERM; sleep 60) >/dev/null 2>&1 & echo $! > ${marker}; exit 0`,
          ],
          {},
          "completed setup",
        );
        const pid = await readPidFile(marker);
        expect(pid).toBeGreaterThan(0);
        const setupSignal = await readFile(signalMarker, "utf8");
        expect(setupSignal).toContain("term");
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (pid === undefined) break;
          try {
            process.kill(pid, 0);
            await Bun.sleep(10);
          } catch {
            break;
          }
        }
        if (pid !== undefined) expect(() => process.kill(pid as number, 0)).toThrow();
        await owner.stopAll();
        expect(await readFile(signalMarker, "utf8")).toBe(setupSignal);
      } finally {
        await owner.stopAll();
        await rm(marker, { force: true });
        await rm(signalMarker, { force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not report a provisional EPERM once final liveness is ESRCH",
    async () => {
      let livenessChecks = 0;
      const signals: (NodeJS.Signals | 0)[] = [];
      const missingProcess = (): Error =>
        Object.assign(new Error("no such process"), { code: "ESRCH" });
      const permissionDenied = (): Error =>
        Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      const owner = new DevelopmentProcessOwner({
        gracefulTimeoutMs: 1,
        forcedTimeoutMs: 1,
        processKill: (_processId, signal) => {
          signals.push(signal);
          if (signal === 0) {
            livenessChecks += 1;
            if (livenessChecks === 1) return;
            throw missingProcess();
          }
          throw permissionDenied();
        },
      });
      const child = owner.spawn(
        [process.execPath, "-e", "setTimeout(() => process.exit(0), 20)"],
        "permission race",
      );
      try {
        await owner.stopAll();
        expect(signals).toContain("SIGTERM");
        expect(signals).toContain(0);
        expect(owner.cleanupErrors).toEqual([]);
      } finally {
        await child.exited;
        owner.dispose();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "stops sibling processes when one child fails",
    async () => {
      const marker = `/tmp/hartlib-dev-child-failure-${randomUUID()}`;
      const running = runDevelopmentChildren(
        [
          {
            label: "failing",
            command: [process.execPath, "-e", "setTimeout(() => process.exit(17), 100)"],
          },
          {
            label: "sibling",
            command: ["sh", "-c", `sleep 60 & echo $! > ${marker}; wait`],
          },
        ],
        {},
      );
      try {
        const pid = await readPidFile(marker);
        expect(pid).toBeGreaterThan(0);
        await expect(running).resolves.toBe(17);
        if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        await rm(marker, { force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32").each(handledSignals)(
    "handles %s during application runtime",
    async (signal, expected) => {
      const running = runDevelopmentChildren(
        [{ label: "long-lived", command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"] }],
        {},
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      process.kill(process.pid, signal);
      await expect(running).resolves.toBe(expected);
      expect(signalExitCode(signal)).toBe(expected);
    },
  );

  it.skipIf(process.platform === "win32").each(handledSignals)(
    "owns setup descendants before the first setup command on %s",
    async (signal, expected) => {
      const running = runDevelopment({
        environment: {
          DATABASE_URL: "postgres://hartlib:hartlib@127.0.0.1:5433/hartlib",
          HARTLIB_POSTGRES_HOST_PORT: "5433",
        },
        runSetupCommand: async (_command, _label, _options, owner) => {
          const child = owner.spawn(
            [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
            "setup descendant",
          );
          await child.exited;
        },
        ensureDatabase: async () => "existing",
        runChildren: async () => 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      process.kill(process.pid, signal);
      await expect(running).resolves.toBe(expected);
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills descendants, not only the shell leader",
    async () => {
      const marker = `/tmp/hartlib-dev-descendant-${randomUUID()}`;
      const running = runDevelopmentChildren(
        [{ label: "shell", command: ["sh", "-c", `sleep 60 & echo $! > ${marker}; wait`] }],
        {},
      );
      const pid = await readPidFile(marker);
      expect(pid).toBeGreaterThan(0);
      process.kill(process.pid, "SIGINT");
      await expect(running).resolves.toBe(130);
      if (pid !== undefined) {
        expect(() => process.kill(pid as number, 0)).toThrow();
      }
      await rm(marker, { force: true });
    },
  );
});

import { Effect } from "effect";
import { z } from "zod";

import { loadWorkerConfig } from "../../config";
import { closeSmithersWorkflowRuntime } from "../smithers-interop";
import { CanonicalGoldenEvaluationSet } from "./fixtures/golden-set.v4";
import {
  bindEvaluationAnnotations,
  captureEvaluationSession,
  createEvaluationSession,
  EvaluationAnnotationFileSchema,
  prepareAndExecuteEvaluationSession,
  revalidateCapturedArtifacts,
  seedEvaluationSession,
} from "./pipeline";
import { EvaluationInputError, evaluateSuite } from "./runner";
import { GeneralPlannerEvaluationResultSchema, SpecializedEvaluationResultSchema } from "./schema";

type Command = "prepare" | "execute" | "annotate" | "capture" | "gate";

interface CliOptions {
  readonly command: Command;
  readonly sessionId: string | undefined;
  readonly annotationsPath: string | undefined;
  readonly specializedPath: string | undefined;
  readonly baselinePath: string | undefined;
  readonly specializedOutPath: string | undefined;
  readonly baselineOutPath: string | undefined;
  readonly reportPath: string | undefined;
}

class EvaluationHelpRequested extends Error {
  constructor() {
    super("evaluation help requested");
    this.name = "EvaluationHelpRequested";
  }
}

const usage = [
  "Usage:",
  "  bun run eval:ai -- --execute [--session <uuid>]",
  "  bun run eval:ai -- --prepare [--session <uuid>]",
  "  bun run eval:ai -- --annotate --session <uuid> --annotations <annotations.json>",
  "  bun run eval:ai -- --capture --session <uuid> --specialized-out <json> --baseline-out <json>",
  "  bun run eval:ai -- --session <uuid> [--report <report.json>]",
  "  bun run eval:ai -- --session <uuid> --specialized <json> --baseline <json> [--report <report.json>]",
  "  bun run eval:ai -- --schema",
  "",
  "--execute explicitly launches paid real Z.AI turns for every canonical case through both topologies.",
  "It creates/seeds a session when needed and resumes durable Smithers runs for an existing session.",
  "Claims and expected-gap judgments are supplied later with --annotate and are digest-bound to exact outputs.",
  "The gate never trusts standalone JSON: it reconstructs or exactly revalidates artifacts against PostgreSQL.",
  "Database credentials come only from the shared worker configuration; they are never command-line arguments.",
].join("\n");

const pathOptions = new Set([
  "--session",
  "--annotations",
  "--specialized",
  "--baseline",
  "--specialized-out",
  "--baseline-out",
  "--report",
]);

const parseArguments = (arguments_: readonly string[]): CliOptions => {
  let command: Command = "gate";
  let explicitCommand = false;
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      throw new EvaluationHelpRequested();
    }
    const commandFor = {
      "--prepare": "prepare",
      "--execute": "execute",
      "--annotate": "annotate",
      "--capture": "capture",
    }[argument ?? ""] as Command | undefined;
    if (commandFor !== undefined) {
      if (explicitCommand) throw new EvaluationInputError("choose exactly one evaluation command");
      command = commandFor;
      explicitCommand = true;
      continue;
    }
    if (argument === undefined || !pathOptions.has(argument)) {
      throw new EvaluationInputError(`unknown argument ${argument ?? "<missing>"}\n${usage}`);
    }
    if (values.has(argument)) throw new EvaluationInputError(`duplicate ${argument}`);
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new EvaluationInputError(`${argument} requires a value\n${usage}`);
    }
    values.set(argument, value);
    index += 1;
  }

  const sessionId = values.get("--session");
  if (sessionId !== undefined && !z.uuid().safeParse(sessionId).success) {
    throw new EvaluationInputError("--session must be a UUID");
  }
  if (command !== "prepare" && command !== "execute" && sessionId === undefined) {
    throw new EvaluationInputError(`--session is required for --${command}`);
  }
  if (command === "annotate" && values.get("--annotations") === undefined) {
    throw new EvaluationInputError("--annotate requires --annotations");
  }
  if (
    command === "capture" &&
    (values.get("--specialized-out") === undefined || values.get("--baseline-out") === undefined)
  ) {
    throw new EvaluationInputError("--capture requires --specialized-out and --baseline-out");
  }
  const specializedPath = values.get("--specialized");
  const baselinePath = values.get("--baseline");
  if ((specializedPath === undefined) !== (baselinePath === undefined)) {
    throw new EvaluationInputError("--specialized and --baseline must be supplied together");
  }
  return {
    command,
    sessionId,
    annotationsPath: values.get("--annotations"),
    specializedPath,
    baselinePath,
    specializedOutPath: values.get("--specialized-out"),
    baselineOutPath: values.get("--baseline-out"),
    reportPath: values.get("--report"),
  };
};

const readJson = async (path: string): Promise<unknown> => {
  const artifact = Bun.file(path);
  if (!(await artifact.exists()))
    throw new EvaluationInputError(`artifact does not exist: ${path}`);
  try {
    return await artifact.json();
  } catch (error) {
    throw new EvaluationInputError(
      `artifact is not valid JSON: ${path}: ${error instanceof Error ? error.message : "unknown parse error"}`,
    );
  }
};

const writeJson = (path: string, value: unknown): Promise<number> =>
  Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);

const writeStdout = (value: string): Promise<void> =>
  new Promise((resolve, reject) => {
    process.stdout.write(value, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const requireSession = (options: CliOptions): string => {
  if (options.sessionId === undefined)
    throw new EvaluationInputError("evaluation session is required");
  return options.sessionId;
};

const main = async (): Promise<void> => {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 1 && arguments_[0] === "--schema") {
    await writeStdout(
      `${JSON.stringify(
        {
          artifactVersion: 4,
          goldenSetVersion: 4,
          canonicalCaseIds: CanonicalGoldenEvaluationSet.cases.map((fixture) => fixture.id),
          specializedResult: z.toJSONSchema(SpecializedEvaluationResultSchema),
          generalPlannerResult: z.toJSONSchema(GeneralPlannerEvaluationResultSchema),
          humanAnnotations: z.toJSONSchema(EvaluationAnnotationFileSchema),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const options = parseArguments(arguments_);
  const config = await Effect.runPromise(loadWorkerConfig);
  const databaseUrl = config.databaseUrl;
  if (options.command === "prepare") {
    const sessionId = await createEvaluationSession(databaseUrl, options.sessionId);
    await seedEvaluationSession(databaseUrl, sessionId);
    console.log(JSON.stringify({ sessionId, status: "prepared" }));
    return;
  }
  if (options.command === "execute") {
    const sessionId = await prepareAndExecuteEvaluationSession(
      databaseUrl,
      options.sessionId,
      config,
    );
    console.log(JSON.stringify({ sessionId, status: "awaiting_annotations" }));
    return;
  }
  const sessionId = requireSession(options);
  if (options.command === "annotate") {
    await bindEvaluationAnnotations(
      databaseUrl,
      sessionId,
      await readJson(options.annotationsPath!),
    );
    console.log(JSON.stringify({ sessionId, status: "annotations_bound" }));
    return;
  }
  if (options.command === "capture") {
    const suite = await captureEvaluationSession(databaseUrl, sessionId);
    await Promise.all([
      writeJson(options.specializedOutPath!, suite.specialized),
      writeJson(options.baselineOutPath!, suite.baseline),
    ]);
    console.log(
      JSON.stringify({
        sessionId,
        status: "captured",
        specialized: options.specializedOutPath,
        baseline: options.baselineOutPath,
      }),
    );
    return;
  }

  const suite =
    options.specializedPath === undefined
      ? await captureEvaluationSession(databaseUrl, sessionId)
      : await revalidateCapturedArtifacts(
          databaseUrl,
          sessionId,
          await readJson(options.specializedPath),
          await readJson(options.baselinePath!),
        );
  const report = evaluateSuite(CanonicalGoldenEvaluationSet, suite.specialized, suite.baseline);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.reportPath !== undefined) await Bun.write(options.reportPath, serialized);
  console.log(serialized.trimEnd());
  if (!report.passed) process.exitCode = 1;
};

await main()
  .catch((error: unknown) => {
    if (error instanceof EvaluationHelpRequested) {
      console.log(usage);
      process.exitCode = 0;
      return;
    }
    console.error(error instanceof Error ? error.message : "unknown evaluation failure");
    process.exitCode = 2;
  })
  .finally(async () => {
    try {
      await closeSmithersWorkflowRuntime();
    } catch (error) {
      console.error(
        error instanceof Error
          ? `Smithers shutdown failed: ${error.message}`
          : "Smithers shutdown failed",
      );
      process.exitCode = 2;
    }
  });

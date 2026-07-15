import { Effect } from "effect3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runWorkflowMock = vi.hoisted(() => vi.fn());
const closeSingleRunnerRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("smithers-orchestrator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("smithers-orchestrator")>()),
  closeSingleRunnerRuntime: closeSingleRunnerRuntimeMock,
  runWorkflow: runWorkflowMock,
}));

import {
  closeSmithersWorkflowRuntime,
  registerSmithersWorkflowMaxConcurrency,
  runSmithersWorkflow,
  serializeSmithersPostgresClient,
} from "./smithers-interop";

describe("Smithers workflow concurrency registration", () => {
  beforeEach(() => {
    runWorkflowMock.mockReset();
    closeSingleRunnerRuntimeMock.mockReset();
    closeSingleRunnerRuntimeMock.mockResolvedValue(undefined);
    runWorkflowMock.mockImplementation((_workflow: unknown, options: { readonly runId?: string }) =>
      Effect.succeed({ runId: options.runId ?? "generated-run", status: "finished" as const }),
    );
  });

  it("exposes finite Smithers shutdown through the Brief interop boundary", async () => {
    await expect(closeSmithersWorkflowRuntime()).resolves.toBeUndefined();
    expect(closeSingleRunnerRuntimeMock).toHaveBeenCalledOnce();
  });

  it("keeps an existing workflow registration immutable", () => {
    const workflow = registerSmithersWorkflowMaxConcurrency({}, 7);

    expect(registerSmithersWorkflowMaxConcurrency(workflow, 7)).toBe(workflow);
    expect(() => registerSmithersWorkflowMaxConcurrency(workflow, 6)).toThrow(
      "Smithers workflow maxConcurrency registration mismatch: registered 7, received 6",
    );
  });

  it("applies the registered cap to both initial execution and resume", async () => {
    const workflow = registerSmithersWorkflowMaxConcurrency({}, 7);

    await expect(
      runSmithersWorkflow(workflow, {
        runId: "initial-run",
        input: {},
        resume: false,
      }),
    ).resolves.toMatchObject({ runId: "initial-run", status: "finished" });
    await expect(
      runSmithersWorkflow(workflow, {
        runId: "resumed-run",
        input: {},
        resume: true,
      }),
    ).resolves.toMatchObject({ runId: "resumed-run", status: "finished" });

    expect(runWorkflowMock).toHaveBeenNthCalledWith(
      1,
      workflow,
      expect.objectContaining({ maxConcurrency: 7, resume: false }),
    );
    expect(runWorkflowMock).toHaveBeenNthCalledWith(
      2,
      workflow,
      expect.objectContaining({ maxConcurrency: 7, resume: true }),
    );
  });

  it("accepts an explicit cap only when it exactly matches the registered value", async () => {
    const workflow = registerSmithersWorkflowMaxConcurrency({}, 7);

    await expect(
      runSmithersWorkflow(workflow, {
        runId: "matching-run",
        input: {},
        maxConcurrency: 7,
      }),
    ).resolves.toMatchObject({ runId: "matching-run", status: "finished" });
    expect(runWorkflowMock).toHaveBeenCalledWith(
      workflow,
      expect.objectContaining({ maxConcurrency: 7 }),
    );
  });

  it.each([6, 8])("rejects conflicting explicit cap %i for registered cap 7", async (explicit) => {
    const workflow = registerSmithersWorkflowMaxConcurrency({}, 7);

    await expect(
      runSmithersWorkflow(workflow, {
        input: {},
        maxConcurrency: explicit,
      }),
    ).rejects.toThrow(
      `Smithers workflow maxConcurrency mismatch: registered 7, received explicit ${explicit}`,
    );
    expect(runWorkflowMock).not.toHaveBeenCalled();
  });
});

describe("Smithers PostgreSQL query serialization", () => {
  it("runs one query at a time in submission order and recovers after rejection", async () => {
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const client = {
      query: (label: unknown, callback?: (error: unknown, result?: unknown) => void): unknown => {
        const execute = async () => {
          const name = String(label);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          order.push(`start:${name}`);
          await new Promise((resolve) => setTimeout(resolve, 2));
          order.push(`end:${name}`);
          active -= 1;
          if (name === "fail") throw new Error("expected query rejection");
          return name;
        };
        if (callback !== undefined) {
          void execute().then(
            (result) => callback(null, result),
            (error: unknown) => callback(error),
          );
          return undefined;
        }
        return execute();
      },
    };
    serializeSmithersPostgresClient({ connection: client });

    const first = client.query("first") as Promise<unknown>;
    const rejected = client.query("fail") as Promise<unknown>;
    const callbackResult = new Promise<unknown>((resolve, reject) => {
      client.query("callback", (error, result) =>
        error === null ? resolve(result) : reject(error),
      );
    });
    const last = client.query("last") as Promise<unknown>;

    await expect(first).resolves.toBe("first");
    await expect(rejected).rejects.toThrow("expected query rejection");
    await expect(callbackResult).resolves.toBe("callback");
    await expect(last).resolves.toBe("last");
    expect(maximumActive).toBe(1);
    expect(order).toEqual([
      "start:first",
      "end:first",
      "start:fail",
      "end:fail",
      "start:callback",
      "end:callback",
      "start:last",
      "end:last",
    ]);
  });

  it("fails closed when Smithers does not expose the expected PostgreSQL descriptor", () => {
    expect(() => serializeSmithersPostgresClient({})).toThrow(
      "Smithers PostgreSQL storage descriptor lacks a queryable connection",
    );
  });
});

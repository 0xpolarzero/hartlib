/** @jsxImportSource smithers-orchestrator */
import { z } from "zod";
import type { CreateSmithersApi } from "../smithers-interop";

export const spikeSchemas = {
  spikeStepOne: z.object({
    message: z.string(),
    count: z.number().int(),
  }),
  spikeStepTwo: z.object({
    echoed: z.string(),
    doubled: z.number().int(),
  }),
};

export type SpikeSchemas = typeof spikeSchemas;

export type SpikeWorkflow = ReturnType<CreateSmithersApi<SpikeSchemas>["smithers"]>;

export function buildSpikeWorkflow(api: CreateSmithersApi<SpikeSchemas>): SpikeWorkflow {
  const { Workflow, Task, Sequence, smithers, outputs } = api;

  return smithers(() => (
    <Workflow name="ai-spike">
      <Sequence>
        <Task id="spikeStepOne" output={outputs.spikeStepOne} retries={0}>
          {() => ({ message: "hello from step one", count: 21 })}
        </Task>
        <Task
          id="spikeStepTwo"
          output={outputs.spikeStepTwo}
          retries={0}
          deps={{ spikeStepOne: outputs.spikeStepOne }}
        >
          {({ spikeStepOne }: { spikeStepOne: z.infer<SpikeSchemas["spikeStepOne"]> }) => ({
            echoed: spikeStepOne.message,
            doubled: spikeStepOne.count * 2,
          })}
        </Task>
      </Sequence>
    </Workflow>
  ));
}

export interface HandoffSpikeHooks {
  stepOne: () =>
    | z.infer<SpikeSchemas["spikeStepOne"]>
    | Promise<z.infer<SpikeSchemas["spikeStepOne"]>>;
  stepTwo: (
    stepOne: z.infer<SpikeSchemas["spikeStepOne"]>,
  ) => z.infer<SpikeSchemas["spikeStepTwo"]> | Promise<z.infer<SpikeSchemas["spikeStepTwo"]>>;
}

export function buildHandoffSpikeWorkflow(
  api: CreateSmithersApi<SpikeSchemas>,
  hooks: HandoffSpikeHooks,
): SpikeWorkflow {
  const { Workflow, Task, Sequence, smithers, outputs } = api;

  return smithers(() => (
    <Workflow name="ai-spike-handoff">
      <Sequence>
        <Task id="spikeStepOne" output={outputs.spikeStepOne} retries={0}>
          {() => hooks.stepOne()}
        </Task>
        <Task
          id="spikeStepTwo"
          output={outputs.spikeStepTwo}
          retries={0}
          deps={{ spikeStepOne: outputs.spikeStepOne }}
        >
          {({ spikeStepOne }: { spikeStepOne: z.infer<SpikeSchemas["spikeStepOne"]> }) =>
            hooks.stepTwo(spikeStepOne) as z.infer<SpikeSchemas["spikeStepTwo"]>
          }
        </Task>
      </Sequence>
    </Workflow>
  ));
}

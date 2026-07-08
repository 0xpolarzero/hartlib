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

// TODO(spike): the spec requires validating the Smithers Postgres backend inside a container
// without a git or jj repository; this machine has a git repo, so that spike cannot run here.
// Validate in CI/container before production rollout (docs/ai-chat-runtime.spec.md, Stack).
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

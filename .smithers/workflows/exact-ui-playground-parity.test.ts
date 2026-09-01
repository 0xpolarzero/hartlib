import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("exact-ui-playground-parity workflow", () => {
  it("renders the seeded workflow graph", () => {
    const repositoryRoot = process.cwd();
    const smithersRoot = join(repositoryRoot, ".smithers");
    const workflowPath = join(smithersRoot, "workflows", "exact-ui-playground-parity.tsx");
    const script = `
      import { mdxPlugin } from "smithers-orchestrator";
      import { renderWorkflow } from "@smithers-orchestrator/testing";
      mdxPlugin();
      const { default: workflow } = await import("./workflows/exact-ui-playground-parity.tsx");
      const rendered = await renderWorkflow(workflow, {
        input: { viewports: [
          { name: "desktop", width: 1440, height: 900 },
          { name: "narrow", width: 390, height: 844 },
        ] },
        baseRootDir: ${JSON.stringify(repositoryRoot)},
        workflowPath: ${JSON.stringify(workflowPath)},
      });
      const renderedGraph = rendered.toXml();
      for (const marker of ["exact-ui-playground-parity", "audit_and_plan"]) {
        if (!renderedGraph.includes(marker)) throw new Error("missing rendered graph marker: " + marker);
      }
      console.log("rendered");
    `;
    const output = execFileSync("bun", ["-e", script], {
      cwd: smithersRoot,
      encoding: "utf8",
    });
    expect(output).toContain("rendered");
  });
});

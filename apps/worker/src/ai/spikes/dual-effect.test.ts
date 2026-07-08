import { Effect as Effect4 } from "effect";
import { Effect as Effect3 } from "effect3";
import { describe, expect, it } from "vitest";

describe("dual effect", () => {
  it("runs an effect 3 program through the effect3 alias", async () => {
    const result = await Effect3.runPromise(Effect3.map(Effect3.succeed(20), (n) => n + 1));

    expect(result).toBe(21);
  });

  it("runs an effect 4 program with the workspace effect", async () => {
    const result = await Effect4.runPromise(
      Effect4.gen(function* () {
        return yield* Effect4.succeed(41 + 1);
      }),
    );

    expect(result).toBe(42);
  });

  it("keeps the two effect module instances distinct", () => {
    expect(Effect3).not.toBe(Effect4 as unknown);
  });
});

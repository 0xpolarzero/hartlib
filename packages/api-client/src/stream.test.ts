import { describe, expect, it } from "vitest";

import { decodeAiRunSse } from "./stream";

const collect = async <T>(values: AsyncIterable<T>): Promise<T[]> => {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
};

describe("AI run SSE", () => {
  it("decodes the stopped terminal event", async () => {
    const response = new Response(
      'id: 7\nevent: stopped\ndata: {"type":"stopped","assistantMessageId":null}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
    const result = await collect(decodeAiRunSse(response));
    expect(result).toEqual([
      {
        seq: 7,
        event: { type: "stopped", assistantMessageId: null },
      },
    ]);
  });

  it("rejects an event with an unknown field", async () => {
    const response = new Response(
      'id: 1\nevent: done\ndata: {"type":"done","assistantMessageId":null,"old":true}\n\n',
    );
    await expect(collect(decodeAiRunSse(response))).rejects.toThrow();
  });
});

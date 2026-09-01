import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import { DEFAULT_APP_COMMAND, withLaunchedSurfaces } from "./launch";

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a TCP port"));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });

const serverCommand = (port: number): readonly string[] => [
  process.execPath,
  "-e",
  `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("ready") });`,
];

describe("parity surface launcher", () => {
  it("keeps the repository app command explicit and manages both server groups", async () => {
    expect(DEFAULT_APP_COMMAND).toEqual(["bun", "run", "dev:web"]);
    const appPort = await freePort();
    const referencePort = await freePort();
    await withLaunchedSurfaces(
      [
        {
          name: "app",
          url: `http://127.0.0.1:${appPort}`,
          command: serverCommand(appPort),
        },
        {
          name: "reference",
          url: `http://127.0.0.1:${referencePort}`,
          command: serverCommand(referencePort),
        },
      ],
      async ([app, reference]) => {
        expect(app.started).toBe(true);
        expect(reference.started).toBe(true);
        expect(app.output).toBe("");
        expect(reference.output).toBe("");
        expect(await fetch(app.spec.url).then((response) => response.text())).toBe("ready");
        expect(await fetch(reference.spec.url).then((response) => response.text())).toBe("ready");
      },
      { readinessTimeoutMs: 10_000, pollMs: 25, gracefulShutdownMs: 1_000 },
    );
    expect(await fetch(`http://127.0.0.1:${appPort}`).catch(() => null)).toBeNull();
    expect(await fetch(`http://127.0.0.1:${referencePort}`).catch(() => null)).toBeNull();
  }, 20_000);
});

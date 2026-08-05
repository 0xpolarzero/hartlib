import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { routeRequest } from "../http";
import { routes } from "../routes";
import {
  administrativeMutationAuditMatrix,
  authenticatedMutationAuditExemptions,
  mutationRouteKey,
} from "./administrative-audit-matrix";

const boundedCode = /^[a-z][a-z0-9_.]{1,127}$/u;

describe("canonical API architecture", () => {
  it("registers every production endpoint once with an Effect path template", () => {
    const keys = routes.map((route) => mutationRouteKey(route.method, route.path));
    expect(new Set(keys).size).toBe(keys.length);
    expect(routes.every((route) => route.path.startsWith("/") && !("pattern" in route))).toBe(true);
  });

  it("builds the complete Effect router and serves its schema-validated health response", async () => {
    const response = await Effect.runPromise(
      routeRequest(routes, new Request("http://hartlib.test/health")),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "api" });
  });

  it("classifies every mutation exactly once as audited or explicitly non-administrative", () => {
    const mutationRoutes = routes.filter((route) => route.method !== "GET");
    const actual = mutationRoutes.map((route) => mutationRouteKey(route.method, route.path)).sort();
    const audited = administrativeMutationAuditMatrix.map((entry) =>
      mutationRouteKey(entry.method, entry.path),
    );
    const exempt = authenticatedMutationAuditExemptions.map((entry) =>
      mutationRouteKey(entry.method, entry.path),
    );
    const classified = [...audited, ...exempt].sort();

    expect(new Set(actual).size).toBe(actual.length);
    expect(new Set(classified).size).toBe(classified.length);
    expect(classified).toEqual(actual);
  });

  it("keeps chat reset in the personal chat lifecycle exemption only", () => {
    const resetKey = mutationRouteKey("POST", "/v1/chats/:chatId/reset");
    const exemptions = authenticatedMutationAuditExemptions.filter(
      (entry) => mutationRouteKey(entry.method, entry.path) === resetKey,
    );
    const administrative = administrativeMutationAuditMatrix.filter(
      (entry) => mutationRouteKey(entry.method, entry.path) === resetKey,
    );

    expect(exemptions).toEqual([
      {
        method: "POST",
        path: "/v1/chats/:chatId/reset",
        reason: "personal_chat_lifecycle",
      },
    ]);
    expect(administrative).toEqual([]);
  });

  it("requires succeeded and bounded denied outcomes for every administrative mutation", () => {
    for (const entry of administrativeMutationAuditMatrix) {
      const route = routes.find(
        (candidate) => candidate.method === entry.method && candidate.path === entry.path,
      );
      expect(route?.administrativeAudit, mutationRouteKey(entry.method, entry.path)).toBeTypeOf(
        "function",
      );
      expect(entry.succeededOutcome, mutationRouteKey(entry.method, entry.path)).toBe("required");
      expect(entry.actions.length).toBeGreaterThan(0);
      expect(entry.actions).toContain(entry.fallbackAction);
      expect(entry.actions.every((action) => boundedCode.test(action))).toBe(true);
      expect(boundedCode.test(entry.scopeKind)).toBe(true);
      expect(entry.deniedReasonCodes.length).toBeGreaterThan(0);
      expect(entry.deniedReasonCodes.every((reason) => boundedCode.test(reason))).toBe(true);
      expect(entry.deniedReasonCodes).toContain("forbidden");
      expect(entry.deniedReasonCodes).toContain("mfa_required");
      expect(entry.deniedReasonCodes).toContain("idempotency_conflict");
    }
  });

  it("keeps SQL out of the Effect HTTP route wiring", async () => {
    const routeDirectory = new URL("../routes/", import.meta.url);
    const productionRouteFiles: string[] = [];
    for await (const file of new Bun.Glob("*.ts").scan({
      cwd: routeDirectory.pathname,
      absolute: true,
    })) {
      if (!file.endsWith(".test.ts")) productionRouteFiles.push(file);
    }
    const contents = await Promise.all(
      productionRouteFiles.map(async (file) => ({ file, text: await Bun.file(file).text() })),
    );
    for (const { file, text } of contents) {
      expect(text, file).not.toMatch(/@effect\/sql-pg|SqlClient|PgClient|sql\s*`/u);
    }
  });
});

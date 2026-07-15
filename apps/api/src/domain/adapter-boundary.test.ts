import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const sourceRoot = new URL("../", import.meta.url);

const productionFiles = async (directory: URL, prefix = ""): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await productionFiles(new URL(`${entry.name}/`, directory), relative)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(relative);
    }
  }
  return files.sort();
};

describe("API adapter package boundary", () => {
  it("keeps database clients, transactions, and SQL templates out of API production modules", async () => {
    const files = await productionFiles(sourceRoot);
    for (const file of files) {
      const source = await readFile(new URL(file, sourceRoot), "utf8");
      // database.ts is the sole documented infrastructure exception: it
      // constructs the package-provided PgClient layer for HTTP adapters.
      if (file === "database.ts") continue;
      expect(source, file).not.toContain("@effect/sql-pg");
      expect(source, file).not.toMatch(/\bPgClient\b|\bSqlClient\b/u);
      expect(source, file).not.toMatch(/\bsql(?:<|`|\.(?:unsafe|raw|withTransaction))/u);
      expect(source, file).not.toContain("withTransaction");
      expect(source, file).not.toMatch(/from ["']\.\/(?:authorization|platform-audit)["']/u);
      expect(source, file).not.toMatch(/from ["']\.\.\/authorization["']/u);
    }
  });

  it("allows the HTTP boundary alone to decode request bodies and query strings", async () => {
    const domainRoot = new URL("domain/", sourceRoot);
    const files = await productionFiles(domainRoot);
    for (const file of files) {
      const source = await readFile(new URL(file, domainRoot), "utf8");
      expect(source, file).not.toMatch(/request\.(?:arrayBuffer|json|text|formData)\s*\(/u);
      expect(source, file).not.toContain("url.searchParams");
      expect(source, file).not.toContain("JSON.parse(");
    }
  });
});

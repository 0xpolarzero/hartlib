import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationsDirectory = new URL("../../../../db/migrations/", import.meta.url);
const preCutoverMigrationCount = 72;
const preCutoverAggregateSha256 =
  "7e912ccb8b9a1cc7ee574a6b7957f155e54fadae1330da0506f6ab16b5c92aff";

async function migrationFiles(): Promise<readonly string[]> {
  return (await readdir(migrationsDirectory, "utf8"))
    .filter((file) => /^\d{4}_.+\.sql$/u.test(file))
    .sort();
}

async function aggregateHash(files: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    const fileHash = createHash("sha256")
      .update(await readFile(new URL(file, migrationsDirectory)))
      .digest("hex");
    hash.update(`${fileHash}  db/migrations/${file}\n`, "utf8");
  }
  return hash.digest("hex");
}

describe("migration ledger", () => {
  it("keeps immutable boot history and records only the destructive 0074 cutover", async () => {
    const files = await migrationFiles();
    const preCutover = files.filter((file) => file < "0074_");
    expect(preCutover).toHaveLength(preCutoverMigrationCount);
    expect(await aggregateHash(preCutover)).toBe(preCutoverAggregateSha256);
    expect(files).toContain("0074_demo_product_cutover.sql");
  });

  it("declares the final singular session, chat, stop, evidence, and purge schema", async () => {
    const sql = await readFile(
      new URL("0074_demo_product_cutover.sql", migrationsDirectory),
      "utf8",
    );
    for (const fragment of [
      "demo_sessions",
      "demo_reset_operations",
      "demo_identity_purge",
      "stop_requested_at",
      "stopped_at",
      "superseded_at",
      "assistant_message_sources",
      "run_id",
      "ON DELETE SET NULL",
      "unique_key",
    ]) {
      expect(sql).toContain(fragment);
    }
    expect(sql).not.toMatch(/create\s+(?:or\s+replace\s+)?view\s+.*chat/i);
  });
});

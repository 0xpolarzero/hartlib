import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { comparePngFiles, type PngComparison } from "./png";
import {
  assertParityManifest,
  getParityEntry,
  PARITY_MANIFEST,
  type ParityEntry,
} from "../../tests/e2e/parity/manifest";

export type PairComparison = {
  readonly entryId: string;
  readonly current: string;
  readonly reference: string;
  readonly diff: string;
  readonly comparison?: PngComparison;
  readonly error?: string;
};

export type ComparisonReport = {
  readonly generatedAt: string;
  readonly captureDirectory: string;
  readonly totalEntries: number;
  readonly comparedEntries: number;
  readonly failedEntries: number;
  readonly passed: boolean;
  readonly pairs: readonly PairComparison[];
};

const argumentValue = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
};

const selectedEntries = (raw: string | undefined): readonly ParityEntry[] => {
  if (raw === undefined || raw.trim() === "") return PARITY_MANIFEST;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(getParityEntry);
};

const referencePathFor = (captureDirectory: string, entryId: string): string => {
  return resolve(captureDirectory, `${entryId}-reference.png`);
};

export function compareCaptureDirectory(
  captureDirectory: string,
  entries: readonly ParityEntry[] = PARITY_MANIFEST,
): ComparisonReport {
  if (entries.length === PARITY_MANIFEST.length) assertParityManifest(entries);
  else {
    const ids = new Set<string>();
    for (const entry of entries) {
      getParityEntry(entry.entryId);
      if (ids.has(entry.entryId)) throw new Error(`Duplicate comparison entry ${entry.entryId}`);
      ids.add(entry.entryId);
    }
  }
  const directory = resolve(captureDirectory);
  const pairs: PairComparison[] = [];
  let comparedEntries = 0;
  let failedEntries = 0;
  for (const entry of entries) {
    const current = resolve(directory, `${entry.entryId}-current.png`);
    const reference = referencePathFor(directory, entry.entryId);
    const diff = resolve(directory, `${entry.entryId}-diff.png`);
    if (!existsSync(current) || !existsSync(reference)) {
      failedEntries += 1;
      pairs.push({
        entryId: entry.entryId,
        current,
        reference,
        diff,
        error: `missing ${!existsSync(current) ? "current" : "reference"} screenshot`,
      });
      continue;
    }
    try {
      const comparison = comparePngFiles(current, reference, diff);
      comparedEntries += 1;
      if (!comparison.same) failedEntries += 1;
      pairs.push({ entryId: entry.entryId, current, reference, diff, comparison });
    } catch (error) {
      failedEntries += 1;
      pairs.push({
        entryId: entry.entryId,
        current,
        reference,
        diff,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    captureDirectory: directory,
    totalEntries: entries.length,
    comparedEntries,
    failedEntries,
    passed: entries.length > 0 && failedEntries === 0 && comparedEntries === entries.length,
    pairs,
  };
}

function main(args: readonly string[]): number {
  const captureDirectory =
    argumentValue(args, "--capture-dir") ?? "/tmp/exact-ui-playground-parity";
  const reportPath = argumentValue(args, "--report");
  const entries = selectedEntries(argumentValue(args, "--entry"));
  mkdirSync(resolve(captureDirectory), { recursive: true });
  const report = compareCaptureDirectory(captureDirectory, entries);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath !== undefined) writeFileSync(resolve(reportPath), serialized);
  process.stdout.write(serialized);
  return report.passed ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

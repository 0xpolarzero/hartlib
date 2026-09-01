import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface TreeFingerprint {
  readonly path: string;
  readonly present: boolean;
  readonly sha256: string | null;
  readonly files: number;
}

export interface ProtectedGuardResult {
  readonly before: readonly TreeFingerprint[];
  readonly after: readonly TreeFingerprint[];
  readonly unchanged: boolean;
  readonly mismatches: readonly string[];
}

const hashBytes = (parts: readonly Uint8Array[]): string => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
};

const sortEntries = (entries: readonly string[]): readonly string[] =>
  [...entries].sort((left, right) => left.localeCompare(right, "en", { numeric: false }));

const collectFiles = async (root: string): Promise<readonly string[]> => {
  const info = await lstat(root).catch(() => null);
  if (info === null) return [];
  if (info.isSymbolicLink()) throw new Error(`protected path cannot be a symbolic link: ${root}`);
  if (info.isFile()) return [root];
  if (!info.isDirectory()) throw new Error(`protected path is not a file or directory: ${root}`);
  const names = sortEntries(await readdir(root));
  const children: string[] = [];
  for (const name of names) children.push(...(await collectFiles(join(root, name))));
  return children;
};

export const fingerprintTree = async (rootPath: string): Promise<TreeFingerprint> => {
  const root = resolve(rootPath);
  const files = await collectFiles(root);
  if (files.length === 0) {
    const info = await lstat(root).catch(() => null);
    if (info === null) return { path: root, present: false, sha256: null, files: 0 };
  }
  const parts: Uint8Array[] = [];
  for (const file of files) {
    const name = relative(root, file).split("\\").join("/");
    const bytes = await readFile(file);
    parts.push(Buffer.from(`${name}\0${bytes.byteLength}\0`, "utf8"), bytes);
  }
  return {
    path: root,
    present: true,
    sha256: hashBytes(parts),
    files: files.length,
  };
};

export const guardProtectedPaths = async (
  rootPath: string,
  protectedPaths: readonly string[],
  expected?: Readonly<Record<string, string>>,
): Promise<ProtectedGuardResult> => {
  const before = await Promise.all(
    protectedPaths.map(async (path) => fingerprintTree(join(rootPath, path))),
  );
  const mismatches: string[] = [];
  for (const fingerprint of before) {
    const relativePath = relative(resolve(rootPath), fingerprint.path).split("\\").join("/");
    const expectedHash = expected?.[relativePath];
    if (expectedHash !== undefined && fingerprint.sha256 !== expectedHash) {
      mismatches.push(
        `${relativePath}: expected ${expectedHash}, found ${fingerprint.sha256 ?? "missing"}`,
      );
    }
  }
  return { before, after: before, unchanged: mismatches.length === 0, mismatches };
};

export const completeProtectedGuard = async (
  rootPath: string,
  result: ProtectedGuardResult,
): Promise<ProtectedGuardResult> => {
  const after = await Promise.all(
    result.before.map(async (fingerprint) =>
      fingerprintTree(join(rootPath, relative(resolve(rootPath), fingerprint.path))),
    ),
  );
  const mismatches = [...result.mismatches];
  for (let index = 0; index < result.before.length; index += 1) {
    const before = result.before[index];
    const current = after[index];
    if (before === undefined || current === undefined) continue;
    if (before.present !== current.present || before.sha256 !== current.sha256) {
      const relativePath = relative(resolve(rootPath), before.path).split("\\").join("/");
      mismatches.push(`${relativePath}: changed during capture`);
    }
  }
  return {
    before: result.before,
    after,
    unchanged: mismatches.length === 0,
    mismatches: [...new Set(mismatches)],
  };
};

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type TreeFingerprint = {
  readonly root: string;
  readonly sha256: string;
  readonly files: number;
};

const hashPath = (hash: ReturnType<typeof createHash>, root: string, path: string): void => {
  const relativePath = relative(root, path).split("\\").join("/");
  const stats = statSync(path);
  if (stats.isDirectory()) {
    hash.update(`d:${relativePath}\0`);
    for (const child of readdirSync(path).sort()) hashPath(hash, root, join(path, child));
    return;
  }
  if (!stats.isFile()) throw new Error(`Cannot fingerprint non-file path ${path}`);
  hash.update(`f:${relativePath}:${stats.size}\0`);
  hash.update(readFileSync(path));
};

export function fingerprintTree(root: string): TreeFingerprint {
  const absoluteRoot = resolve(root);
  const hash = createHash("sha256");
  hashPath(hash, absoluteRoot, absoluteRoot);
  let files = 0;
  const countFiles = (path: string): void => {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      for (const child of readdirSync(path)) countFiles(join(path, child));
    } else if (stats.isFile()) files += 1;
  };
  countFiles(absoluteRoot);
  return { root: absoluteRoot, sha256: hash.digest("hex"), files };
}

export function assertFingerprintUnchanged(before: TreeFingerprint, after: TreeFingerprint): void {
  if (before.root !== after.root)
    throw new Error(`Protected tree root changed from ${before.root} to ${after.root}`);
  if (before.sha256 !== after.sha256 || before.files !== after.files) {
    throw new Error(
      `Protected tree changed: before=${before.sha256}/${before.files} after=${after.sha256}/${after.files}`,
    );
  }
}

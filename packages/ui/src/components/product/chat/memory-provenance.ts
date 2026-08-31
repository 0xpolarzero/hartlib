export interface MemoryRevisionFragment {
  readonly memoryId: string;
  readonly revisionId: string;
}
const prefix = "#memory-revision?";
export const memoryRevisionFragment = (memoryId: string, revisionId: string): string =>
  `${prefix}${new URLSearchParams({ memoryId, revisionId }).toString()}`;
export const parseMemoryRevisionFragment = (fragment: string): MemoryRevisionFragment | null => {
  if (!fragment.startsWith(prefix)) return null;
  const params = new URLSearchParams(fragment.slice(prefix.length));
  const keys = [...params.keys()];
  if (
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    !keys.includes("memoryId") ||
    !keys.includes("revisionId")
  )
    return null;
  const memoryId = params.get("memoryId");
  const revisionId = params.get("revisionId");
  return memoryId && revisionId ? { memoryId, revisionId } : null;
};

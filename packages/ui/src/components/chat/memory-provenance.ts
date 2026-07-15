export interface MemoryRevisionFragment {
  readonly memoryId: string;
  readonly revisionId: string;
}

const prefix = "#memory-revision?";

export const memoryRevisionFragment = (memoryId: string, revisionId: string): string => {
  const parameters = new URLSearchParams({ memoryId, revisionId });
  return `${prefix}${parameters.toString()}`;
};

export const parseMemoryRevisionFragment = (fragment: string): MemoryRevisionFragment | null => {
  if (!fragment.startsWith(prefix)) return null;
  const parameters = new URLSearchParams(fragment.slice(prefix.length));
  const keys = [...parameters.keys()];
  if (
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    !keys.includes("memoryId") ||
    !keys.includes("revisionId")
  )
    return null;
  const memoryId = parameters.get("memoryId");
  const revisionId = parameters.get("revisionId");
  return memoryId === null || memoryId === "" || revisionId === null || revisionId === ""
    ? null
    : { memoryId, revisionId };
};

export type BlockKind = "document" | "memory";
export type MemoryKind = "profile" | "preference" | "instruction" | "fact" | "episode";

export interface ManifestEntry {
  readonly documentId: string;
  readonly charStart?: number | undefined;
  readonly charEnd?: number | undefined;
}

export interface DocumentMeta {
  readonly documentId: string;
  readonly sourceId: string;
  readonly sourceDisplayName: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly publishedAt: Date | null;
  readonly textCharCount: number;
}

export interface MemoryItem {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
}

export interface DocumentBlockProvenance {
  readonly documentId: string;
  readonly sourceId: string;
  readonly sourceDisplayName: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly publishedAt: string | null;
  readonly charStart: number | null;
  readonly charEnd: number | null;
}

export interface MemoryBlockProvenance {
  readonly memoryIds: readonly string[];
}

export type BlockProvenance = DocumentBlockProvenance | MemoryBlockProvenance;

export interface RenderableBlock {
  readonly blockId: string;
  readonly kind: BlockKind;
  readonly content: string;
  readonly provenance: BlockProvenance;
}

export const formatBlockId = (n: number): string => `b${n}`;

export const parseBlockNumber = (blockId: string): number | null => {
  const match = /^b(0|[1-9]\d*)$/.exec(blockId);

  if (match === null) {
    return null;
  }

  const value = match[1];

  if (value === undefined) {
    return null;
  }

  return Number.parseInt(value, 10);
};

export const formatPublishedDate = (publishedAt: Date | string | null): string => {
  if (publishedAt === null) {
    return "unknown";
  }

  if (publishedAt instanceof Date) {
    return publishedAt.toISOString().slice(0, 10);
  }

  const date = new Date(publishedAt);

  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toISOString().slice(0, 10);
};

export const renderMemoryBody = (memories: readonly MemoryItem[]): string =>
  memories.map((memory) => `- (${memory.kind}) ${memory.content}`).join("\n");

const isDocumentProvenance = (provenance: BlockProvenance): provenance is DocumentBlockProvenance =>
  "documentId" in provenance;

const isMemoryProvenance = (provenance: BlockProvenance): provenance is MemoryBlockProvenance =>
  "memoryIds" in provenance;

export const renderBlock = (block: RenderableBlock): string => {
  if (block.kind === "document") {
    if (!isDocumentProvenance(block.provenance)) {
      throw new Error("document block must carry document provenance");
    }

    return [
      `[${block.blockId}] document — ${block.provenance.sourceDisplayName} — ${formatPublishedDate(block.provenance.publishedAt)} — ${block.provenance.title}`,
      block.content,
    ].join("\n");
  }

  if (block.kind === "memory") {
    if (!isMemoryProvenance(block.provenance)) {
      throw new Error("memory block must carry memory provenance");
    }

    return [`[${block.blockId}] memory — saved user memories`, block.content].join("\n");
  }

  throw new Error("unknown block kind");
};

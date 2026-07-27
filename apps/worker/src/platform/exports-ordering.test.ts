import { describe, expect, it } from "vitest";

import { sourceKeyForOrdinal } from "../ai/runtime/canonicalization";
import {
  buildTarArchive,
  mapExportChatSources,
  orderExportChatSourceUses,
  orderExportChatSources,
  type ExportChatSourceUseRow,
} from "./exports";

const nonce = new Uint8Array(16).fill(7);
const messageId = "00000000-0000-4000-8000-000000000001";

describe("canonical export source ordering", () => {
  it("orders eleven source-map rows by numeric ordinal, not lexical key text", () => {
    const rows = Array.from({ length: 11 }, (_, index) => {
      const ordinal = 11 - index;
      return {
        messageId,
        sourceKey: sourceKeyForOrdinal(nonce, ordinal),
        kind: "web" as const,
        locator: { kind: "web", ordinal },
        displayLabel: `source ${ordinal}`,
        publicProvenance: { citationUrl: `https://example.test/${ordinal}` },
      };
    });

    expect(orderExportChatSources(rows).map((row) => row.sourceKey)).toEqual(
      Array.from({ length: 11 }, (_, index) => sourceKeyForOrdinal(nonce, index + 1)),
    );
  });

  it("keeps source uses attached while applying numeric source and context order", () => {
    const uses: ExportChatSourceUseRow[] = Array.from({ length: 11 }, (_, index) => {
      const ordinal = 11 - index;
      return {
        messageId,
        sourceKey: sourceKeyForOrdinal(nonce, ordinal),
        consumerTaskId: `consumer-${ordinal}`,
        topicId: null,
        contextOrder: ordinal,
        ranges: [],
      };
    });

    const ordered = orderExportChatSourceUses(uses);
    expect(ordered.map((use) => use.contextOrder)).toEqual(
      Array.from({ length: 11 }, (_, index) => index + 1),
    );
    expect(ordered.map((use) => use.sourceKey)).toEqual(
      Array.from({ length: 11 }, (_, index) => sourceKeyForOrdinal(nonce, index + 1)),
    );
    expect(ordered.map((use) => use.consumerTaskId)).toEqual(
      Array.from({ length: 11 }, (_, index) => `consumer-${index + 1}`),
    );

    const sources = Array.from({ length: 11 }, (_, index) => {
      const ordinal = index + 1;
      return {
        messageId,
        sourceKey: sourceKeyForOrdinal(nonce, ordinal),
        kind: "web" as const,
        locator: { kind: "web", ordinal },
        displayLabel: `source ${ordinal}`,
        publicProvenance: { citationUrl: `https://example.test/${ordinal}` },
      };
    }).reverse();
    const mapped = mapExportChatSources(sources, uses);
    const body = new TextEncoder().encode(JSON.stringify(mapped));
    const archive = buildTarArchive([{ name: "metadata/chats.json", body }]);
    const archiveText = new TextDecoder().decode(archive);
    expect(archiveText.indexOf(`"sourceKey":"${sourceKeyForOrdinal(nonce, 1)}"`)).toBeLessThan(
      archiveText.indexOf(`"sourceKey":"${sourceKeyForOrdinal(nonce, 10)}"`),
    );
    expect(mapped.flatMap((entry) => entry.source.uses)).toHaveLength(11);
  });
});

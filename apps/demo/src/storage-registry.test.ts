import { describe, expect, it } from "vitest";
import {
  clearDemoClientStorage,
  DEMO_STORAGE_KEYS,
  isRegisteredDemoStorageKey,
  readDemoStorage,
  writeDemoStorage,
} from "./storage-registry";
import { initialChatStreamState, serializeChatStreamState } from "./chat-stream";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
describe("demo storage registry", () => {
  it("rejects unregistered keys and corrupt values", () => {
    const local = new MemoryStorage();
    expect(isRegisteredDemoStorageKey("local", "hartlib:demo:unknown")).toBe(false);
    expect(writeDemoStorage("local", DEMO_STORAGE_KEYS.locale, "not-a-locale", local)).toBe(false);
    local.setItem(DEMO_STORAGE_KEYS.locale, "broken");
    expect(readDemoStorage("local", DEMO_STORAGE_KEYS.locale, local)).toBeNull();
  });
  it("clears exact keys and stream prefixes", () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    writeDemoStorage("local", DEMO_STORAGE_KEYS.locale, "en-US", local);
    expect(
      writeDemoStorage(
        "session",
        `${DEMO_STORAGE_KEYS.streamPrefix}run-1`,
        serializeChatStreamState(initialChatStreamState),
        session,
      ),
    ).toBe(true);
    session.setItem("other", "keep");
    clearDemoClientStorage({ local, session });
    expect(local.length).toBe(0);
    expect(session.getItem(`${DEMO_STORAGE_KEYS.streamPrefix}run-1`)).toBeNull();
    expect(session.getItem("other")).toBe("keep");
  });
  it("removes a corrupt stream envelope when it is read", () => {
    const session = new MemoryStorage();
    const key = `${DEMO_STORAGE_KEYS.streamPrefix}run-1`;
    session.setItem(key, JSON.stringify({ schemaVersion: 4, state: {} }));
    expect(readDemoStorage("session", key, session)).toBeNull();
    expect(session.getItem(key)).toBeNull();
  });
  it("rejects layout extras, legacy web aliases, and malformed stream state", () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    local.setItem(
      DEMO_STORAGE_KEYS.layout,
      JSON.stringify({
        leftOpen: true,
        rightOpen: true,
        leftWidth: 280,
        rightWidth: 360,
        mobileTab: "chat",
        extra: true,
      }),
    );
    local.setItem(DEMO_STORAGE_KEYS.webChoice, "on");
    session.setItem(
      `${DEMO_STORAGE_KEYS.streamPrefix}run-2`,
      JSON.stringify({ schemaVersion: 5, state: { phase: "idle" } }),
    );
    expect(readDemoStorage("local", DEMO_STORAGE_KEYS.layout, local)).toBeNull();
    expect(readDemoStorage("local", DEMO_STORAGE_KEYS.webChoice, local)).toBeNull();
    expect(
      readDemoStorage("session", `${DEMO_STORAGE_KEYS.streamPrefix}run-2`, session),
    ).toBeNull();
    expect(local.length).toBe(0);
    expect(session.length).toBe(0);
  });
  it("removes stream state with ranges on non-document source locators", () => {
    const session = new MemoryStorage();
    const sourceByKind = {
      chat_message: {
        sourceKey: "chat-source",
        label: "Chat source",
        tokenCount: 1,
        topicIds: [],
        kind: "chat_message",
        messageId: "message-1",
        ranges: [{ charStart: 0, charEnd: 1 }],
      },
      memory: {
        sourceKey: "memory-source",
        label: "Memory source",
        tokenCount: 1,
        topicIds: [],
        kind: "memory",
        memoryId: "memory-1",
        memoryRevisionId: "revision-1",
        ranges: [{ charStart: 0, charEnd: 1 }],
      },
      web: {
        sourceKey: "web-source",
        label: "Web source",
        tokenCount: 1,
        topicIds: [],
        kind: "web",
        title: "Web source",
        domain: "example.com",
        url: "https://example.com/source",
        capturedAt: "2026-01-01T00:00:00Z",
        quote: "A quote",
        ranges: [{ charStart: 0, charEnd: 1 }],
      },
    } as const;
    for (const [kind, source] of Object.entries(sourceByKind)) {
      const key = `${DEMO_STORAGE_KEYS.streamPrefix}${kind}`;
      session.setItem(
        key,
        JSON.stringify({
          schemaVersion: 5,
          state: {
            activityHistory: [],
            activities: [],
            assistantText: "",
            attempt: 0,
            context: null,
            error: null,
            memoryUpdated: null,
            mode: null,
            phase: "idle",
            seq: 0,
            sourcesRead: [source],
            stoppedAt: null,
          },
        }),
      );
      expect(readDemoStorage("session", key, session)).toBeNull();
      expect(session.getItem(key)).toBeNull();
    }
  });
});

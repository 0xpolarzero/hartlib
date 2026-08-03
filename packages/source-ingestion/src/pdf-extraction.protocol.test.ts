import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

const { extractPdfPagesIsolated } = await import("./pdf-extraction");

type FakeChild = EventEmitter & {
  readonly stdout: PassThrough;
  readonly stdin: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  readonly kill: ReturnType<typeof vi.fn>;
};

const fakeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdout: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn((signal: NodeJS.Signals) => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
      child.emit("close", null, signal);
      return true;
    }),
  });
  return child;
};

const input = new TextEncoder().encode("%PDF-test");

describe("PDF extraction child protocol", () => {
  it("maps malformed child output to a content-free failure", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    queueMicrotask(() => {
      child.stdout.end(Buffer.from("not-json"));
      child.exitCode = 0;
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });

    await expect(extractPdfPagesIsolated(input)).rejects.toMatchObject({
      code: "pdf_extraction_failed",
    });
  });

  it("maps child spawn failure to a stable failure", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));

    await expect(extractPdfPagesIsolated(input)).rejects.toMatchObject({
      code: "pdf_extraction_failed",
    });
  });

  it("maps a non-zero child exit to a stable failure", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    queueMicrotask(() => {
      child.exitCode = 7;
      child.emit("exit", 7, null);
    });

    await expect(extractPdfPagesIsolated(input)).rejects.toMatchObject({
      code: "pdf_extraction_failed",
    });
  });

  it("kills a child that exceeds the bounded output protocol", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    queueMicrotask(() => child.stdout.end(Buffer.alloc(140_000, 0x78)));

    await expect(extractPdfPagesIsolated(input, { maxCharacters: 1 })).rejects.toMatchObject({
      code: "pdf_extraction_failed",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("kills a child when the parent deadline expires", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);

    await expect(extractPdfPagesIsolated(input, { timeoutMs: 1 })).rejects.toMatchObject({
      code: "pdf_extraction_timeout",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

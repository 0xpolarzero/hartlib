import { DEMO_STORAGE_KEYS, readDemoStorage, writeDemoStorage } from "./storage-registry";

export interface DemoLayoutState {
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  mobileTab: "chat" | "visualization";
}
export const defaultLayout: DemoLayoutState = {
  leftOpen: false,
  rightOpen: false,
  leftWidth: 432,
  rightWidth: 432,
  mobileTab: "chat",
};

export function normalizeLayout(value: unknown): DemoLayoutState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return defaultLayout;
  const candidate = value as Partial<DemoLayoutState>;
  return {
    leftOpen: candidate.leftOpen === true,
    rightOpen: candidate.rightOpen === true,
    leftWidth: Math.min(960, Math.max(432, Number(candidate.leftWidth) || defaultLayout.leftWidth)),
    rightWidth: Math.min(
      960,
      Math.max(432, Number(candidate.rightWidth) || defaultLayout.rightWidth),
    ),
    mobileTab: candidate.mobileTab === "visualization" ? "visualization" : "chat",
  };
}

export function readDemoLayout(): DemoLayoutState {
  const raw = readDemoStorage("local", DEMO_STORAGE_KEYS.layout);
  if (raw === null) return defaultLayout;
  try {
    return normalizeLayout(JSON.parse(raw));
  } catch {
    return defaultLayout;
  }
}

export function persistDemoLayout(layout: DemoLayoutState): boolean {
  return writeDemoStorage(
    "local",
    DEMO_STORAGE_KEYS.layout,
    JSON.stringify(normalizeLayout(layout)),
  );
}

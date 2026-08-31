import { DEMO_STORAGE_KEYS, readDemoStorage, writeDemoStorage } from "./storage-registry";

export interface DemoLayoutState {
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  mobileTab: "chat" | "visualization";
}
export const defaultLayout: DemoLayoutState = {
  leftOpen: true,
  rightOpen: true,
  leftWidth: 280,
  rightWidth: 360,
  mobileTab: "chat",
};

export function normalizeLayout(value: unknown): DemoLayoutState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return defaultLayout;
  const candidate = value as Partial<DemoLayoutState>;
  return {
    leftOpen: candidate.leftOpen !== false,
    rightOpen: candidate.rightOpen !== false,
    leftWidth: Math.min(420, Math.max(220, Number(candidate.leftWidth) || defaultLayout.leftWidth)),
    rightWidth: Math.min(
      480,
      Math.max(280, Number(candidate.rightWidth) || defaultLayout.rightWidth),
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

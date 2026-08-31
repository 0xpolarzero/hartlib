import type {
  PublicCitationRecord as SharedPublicCitationRecord,
  PublicSourceRecord as SharedPublicSourceRecord,
} from "@hartlib/shared";
export type PublicCitationRecord = SharedPublicCitationRecord;
export type PublicSourceRecord = SharedPublicSourceRecord;
export type CitationKind = PublicCitationRecord["kind"];
export type RunStageId = "understanding" | "evidence" | "preparing" | "writing" | "finishing";
export type StageStatus = "waiting" | "running" | "complete" | "retrying" | "failed" | "skipped";
export type RunStages = Record<RunStageId, StageStatus>;
export interface RunFailure {
  code: string;
  retryable: boolean;
  stage?: RunStageId;
  attempt?: number;
  message?: string;
  stoppedAt?: string;
}
export interface RunDiagnostics {
  sequence?: number;
  attempt?: number;
  activityHistory?: readonly unknown[];
  context?: unknown;
  memoryUpdated?: unknown;
  terminalFailure?: RunFailure | null;
}
export interface ChatTranscriptMessage {
  id: string;
  author: "user" | "assistant";
  content: string;
  createdAt?: string;
  runId?: string;
  citations?: readonly PublicCitationRecord[];
  sourcesRead?: readonly PublicSourceRecord[];
  streaming?: boolean;
  stopped?: boolean;
  stoppedAt?: string;
  failure?: RunFailure | null;
  diagnostics?: RunDiagnostics;
  activities?: readonly {
    stage: RunStageId;
    status: StageStatus;
    code?: string;
    attempt?: number;
  }[];
  referencesVisualization?: boolean;
}
export interface ChatRunProjection {
  id: string;
  status: "queued" | "running" | "stopped" | "failed" | "succeeded";
  streamedText?: string;
  stages?: RunStages;
  attempt?: number;
  error?: RunFailure | null;
  sourcesRead?: readonly PublicSourceRecord[];
  activities?: readonly {
    stage: RunStageId;
    status: StageStatus;
    code?: string;
    attempt?: number;
  }[];
}
export interface VisualizationVersion {
  id: string;
  specId: string;
  label: string;
  html: string;
  createdAt: string;
}
export type VisualizationState = "idle" | "loading" | "regenerating";
export interface VisualizationAssociation {
  messageId: string;
  versionId?: string;
}
export interface VisualizationPresentationState {
  versions: readonly VisualizationVersion[];
  activeVersionId: string | null;
  state?: VisualizationState;
  highlightKey?: string | number | null;
  association?: VisualizationAssociation | null;
  onSelectVersion?: (versionId: string) => void;
  onRestoreVersion?: (versionId: string) => void;
  onRefresh?: () => void | Promise<void>;
  onDownload?: (version: VisualizationVersion) => void;
  onFullscreen?: () => void;
  onShow?: (association: VisualizationAssociation) => void;
}

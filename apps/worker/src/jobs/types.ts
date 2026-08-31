export type JobKind =
  | "public_source_ingestion"
  | "ai_chat_run"
  | "purge_ai_runtime"
  | "purge_user_memory_tombstones"
  | "demo_identity_purge";

export interface JobRecord {
  readonly id: string;
  readonly kind: JobKind;
  readonly payload: unknown;
  readonly attempts: number;
  readonly maxAttempts?: number;
  readonly lockedBy?: string;
}

export interface EnqueueJobInput {
  readonly kind: JobKind;
  readonly payload: unknown;
  readonly uniqueKey?: string;
  readonly availableAt?: Date;
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly reviveTerminal?: boolean;
}

export interface JobResult {
  readonly status: "completed" | "failed" | "retry";
  readonly message?: string;
}

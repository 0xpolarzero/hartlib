export type JobKind =
  | "public_source_ingestion"
  | "publish_scheduled_issue"
  | "extract_pdf_text"
  | "chunk_issue_text"
  | "generate_embeddings"
  | "update_ai_indexing_status"
  | "import_historical_issues"
  | "send_platform_notification"
  | "send_email_notification"
  | "process_stripe_webhook"
  | "sync_billing_credit_state"
  | "reset_monthly_credit_counters"
  | "generate_export"
  | "purge_deleted_chats"
  | "purge_deleted_files"
  | "check_artifact"
  | "ai_chat_run"
  | "purge_ai_runtime";

export interface JobRecord {
  readonly id: string;
  readonly kind: JobKind;
  readonly payload: unknown;
  readonly attempts: number;
  readonly lockedBy?: string;
}

export interface EnqueueJobInput {
  readonly kind: JobKind;
  readonly payload: unknown;
  readonly uniqueKey?: string;
  readonly availableAt?: Date;
  readonly priority?: number;
  readonly maxAttempts?: number;
}

export interface JobResult {
  readonly status: "completed" | "failed" | "retry";
  readonly message?: string;
}

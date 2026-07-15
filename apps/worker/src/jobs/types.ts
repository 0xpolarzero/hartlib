export type JobKind =
  | "public_source_ingestion"
  | "publish_scheduled_issue"
  | "extract_pdf_text"
  | "normalize_searchable_text"
  | "update_ai_indexing_status"
  | "import_historical_issues"
  | "send_platform_notification"
  | "send_email_notification"
  | "process_stripe_webhook"
  | "sync_billing_credit_state"
  | "reset_monthly_credit_counters"
  | "generate_export"
  | "purge_expired_exports"
  | "purge_deleted_chats"
  | "purge_deleted_files"
  | "reconcile_publisher_uploads"
  | "purge_operational_audit_retention"
  | "purge_deleted_accounts"
  | "finalize_subscription_pause"
  | "ai_chat_run"
  | "purge_ai_runtime"
  | "purge_user_memory_tombstones";

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

import { Schema } from "effect";

export const ArtifactId = Schema.String.pipe(Schema.brand("ArtifactId"));
export type ArtifactId = Schema.Schema.Type<typeof ArtifactId>;

export const ChatId = Schema.String.pipe(Schema.brand("ChatId"));
export type ChatId = Schema.Schema.Type<typeof ChatId>;

export const ArtifactPath = Schema.String.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.check(Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/)),
);

export type ArtifactPath = Schema.Schema.Type<typeof ArtifactPath>;

export const ArtifactFile = Schema.Struct({
  path: ArtifactPath,
  content: Schema.String,
  contentType: Schema.String,
});

export type ArtifactFile = Schema.Schema.Type<typeof ArtifactFile>;

export const Artifact = Schema.Struct({
  id: ArtifactId,
  chatId: ChatId,
  title: Schema.optional(Schema.String),
  files: Schema.Array(ArtifactFile),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
});

export type Artifact = Schema.Schema.Type<typeof Artifact>;

export const ArtifactCheckSeverity = Schema.Literals(["info", "warning", "error"]);
export type ArtifactCheckSeverity = Schema.Schema.Type<typeof ArtifactCheckSeverity>;

export const ArtifactCheckIssue = Schema.Struct({
  severity: ArtifactCheckSeverity,
  message: Schema.String,
  path: Schema.optional(ArtifactPath),
  line: Schema.optional(Schema.Number),
  column: Schema.optional(Schema.Number),
});

export type ArtifactCheckIssue = Schema.Schema.Type<typeof ArtifactCheckIssue>;

export const ArtifactCheckResult = Schema.Struct({
  ok: Schema.Boolean,
  checkedAt: Schema.Date,
  issues: Schema.Array(ArtifactCheckIssue),
});

export type ArtifactCheckResult = Schema.Schema.Type<typeof ArtifactCheckResult>;

export const ArtifactDirective = Schema.Struct({
  id: ArtifactId,
  title: Schema.optional(Schema.String),
});

export type ArtifactDirective = Schema.Schema.Type<typeof ArtifactDirective>;

export const ArtifactListFilesRequest = Schema.Struct({
  artifactId: ArtifactId,
});

export type ArtifactListFilesRequest = Schema.Schema.Type<typeof ArtifactListFilesRequest>;

export const ArtifactReadFileRequest = Schema.Struct({
  artifactId: ArtifactId,
  path: ArtifactPath,
});

export type ArtifactReadFileRequest = Schema.Schema.Type<typeof ArtifactReadFileRequest>;

export const ArtifactApplyPatchRequest = Schema.Struct({
  artifactId: ArtifactId,
  patch: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
});

export type ArtifactApplyPatchRequest = Schema.Schema.Type<typeof ArtifactApplyPatchRequest>;

export const ArtifactCheckRequest = Schema.Struct({
  artifactId: ArtifactId,
});

export type ArtifactCheckRequest = Schema.Schema.Type<typeof ArtifactCheckRequest>;

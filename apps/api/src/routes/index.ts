import {
  artifactApplyPatchRoute,
  artifactCheckRoute,
  artifactListFilesRoute,
  artifactReadFileRoute,
} from "./artifacts";
import { listIssuesToolRoute, readIssueToolRoute, searchIssuesToolRoute } from "./ai-tools";
import { chatStreamRoute } from "./chat";
import { healthRoute } from "./health";
import { publicSourceDocumentContentRoute, publicSourcesRoute } from "./public-sources";

export const routes = [
  healthRoute,
  publicSourcesRoute,
  publicSourceDocumentContentRoute,
  chatStreamRoute,
  listIssuesToolRoute,
  searchIssuesToolRoute,
  readIssueToolRoute,
  artifactListFilesRoute,
  artifactReadFileRoute,
  artifactApplyPatchRoute,
  artifactCheckRoute,
] as const;

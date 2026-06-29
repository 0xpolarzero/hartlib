import {
  artifactApplyPatchRoute,
  artifactCheckRoute,
  artifactListFilesRoute,
  artifactReadFileRoute,
} from "./artifacts";
import { listIssuesToolRoute, readIssueToolRoute, searchIssuesToolRoute } from "./ai-tools";
import { chatStreamRoute } from "./chat";
import { healthRoute } from "./health";

export const routes = [
  healthRoute,
  chatStreamRoute,
  listIssuesToolRoute,
  searchIssuesToolRoute,
  readIssueToolRoute,
  artifactListFilesRoute,
  artifactReadFileRoute,
  artifactApplyPatchRoute,
  artifactCheckRoute,
] as const;

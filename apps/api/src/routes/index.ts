import {
  artifactApplyPatchRoute,
  artifactCheckRoute,
  artifactListFilesRoute,
  artifactReadFileRoute,
} from "./artifacts";
import { chatRoutes } from "./chat";
import { healthRoute } from "./health";
import { memoryRoutes } from "./memories";
import { publicSourceDocumentContentRoute, publicSourcesRoute } from "./public-sources";

export const routes = [
  healthRoute,
  publicSourcesRoute,
  publicSourceDocumentContentRoute,
  ...chatRoutes,
  ...memoryRoutes,
  artifactListFilesRoute,
  artifactReadFileRoute,
  artifactApplyPatchRoute,
  artifactCheckRoute,
] as const;

import { chatRoutes } from "../domain/chat";
import { healthRoute } from "./health";
import { memoryRoutes } from "../domain/memories";
import { publisherDocumentContentRoute } from "../domain/publisher-documents";
import { publicSourceDocumentContentRoute, publicSourceRoutes } from "../domain/public-sources";

import { demoSessionRoutes } from "../domain/demo-session";
export const routes = [
  healthRoute,
  ...demoSessionRoutes,
  ...publicSourceRoutes,
  publicSourceDocumentContentRoute,
  ...chatRoutes,
  ...memoryRoutes,
  publisherDocumentContentRoute,
] as const;

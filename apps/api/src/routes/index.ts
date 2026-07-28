import { billingRoutes } from "../domain/billing";
import { chatRoutes } from "../domain/chat";
import { clerkWebhookRoute } from "../domain/clerk-webhook";
import { clientWorkspaceRoutes } from "../domain/client-workspace";
import { exportRoutes } from "../domain/exports";
import { healthRoute } from "./health";
import { memoryRoutes } from "../domain/memories";
import { productChatRoutes } from "../domain/product-chats";
import { platformSupportRoutes } from "../domain/platform-support";
import { publisherDocumentContentRoute } from "../domain/publisher-documents";
import { publisherOnboardingRoute } from "../domain/publisher-onboarding";
import { publisherWorkspaceRoutes } from "../domain/publisher-workspace";
import { publicSourceDocumentContentRoute, publicSourceRoutes } from "../domain/public-sources";
import { stripeWebhookRoute } from "../domain/stripe-webhook";
import { workspaceMembershipRoutes } from "../domain/workspace-memberships";

import { demoSessionRoutes } from "../domain/demo-session";
export const routes = [
  healthRoute,
  ...demoSessionRoutes,
  ...publicSourceRoutes,
  publicSourceDocumentContentRoute,
  clerkWebhookRoute,
  stripeWebhookRoute,
  ...billingRoutes,
  ...chatRoutes,
  ...clientWorkspaceRoutes,
  ...exportRoutes,
  ...memoryRoutes,
  ...productChatRoutes,
  ...platformSupportRoutes,
  ...publisherWorkspaceRoutes,
  publisherOnboardingRoute,
  ...workspaceMembershipRoutes,
  publisherDocumentContentRoute,
] as const;

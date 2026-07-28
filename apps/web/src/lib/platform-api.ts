import {
  ApiResponseError,
  createPlatformApiClient,
  validateProductExportDownloadPath,
  type ActiveSupportGrants,
  type ArchivePage,
  type ArchiveSourceFilter,
  type ClientAiUsage,
  type ClientAiUsageRequest,
  type ClientCompanyDeletionRequest,
  type ClientCompanyPublicSource,
  type ClientCompanyWebPolicy,
  type ClientMonthlyPlanChange,
  type ClientTeam,
  type CurrentUserWorkspaces,
  type IssueDetail,
  type NotificationPage,
  type PlatformCompanyDeletionRequest,
  type PlatformOperations,
  type ProductExportRequest,
  type PublisherSubscriptionAiPullMetric,
  type PublisherSubscriptionClientAccess,
  type PublisherTeam,
  type RestrictedAccessList,
} from "@brief/api-client";

import { authenticatedFetch } from "./api-auth";

const client = createPlatformApiClient({ fetch: authenticatedFetch });

export type {
  ActiveSupportGrants,
  ArchivePage,
  ArchiveSourceFilter,
  ClientAiUsage,
  ClientAiUsageRequest,
  ClientCompanyDeletionRequest,
  ClientCompanyPublicSource,
  ClientCompanyWebPolicy,
  ClientMonthlyPlanChange,
  ClientTeam,
  CurrentUserWorkspaces,
  IssueDetail,
  NotificationPage,
  PlatformCompanyDeletionRequest,
  PlatformOperations,
  ProductExportRequest,
  PublisherSubscriptionAiPullMetric,
  PublisherSubscriptionClientAccess,
  PublisherTeam,
  RestrictedAccessList,
};

export const {
  changeClientMonthlyPlan,
  createAiUsageRequest,
  createBillingCheckout,
  createBillingPortal,
  createClientCompanyExport,
  createPublisherCompanyExport,
  createPublisherCompanyOnboarding,
  createPublisherIssue,
  createPublisherSubscription,
  createRestrictedSupportGrant,
  createUserChatsExport,
  deleteClientMember,
  deletePublisherDocument,
  deletePublisherIssue,
  deletePublisherMember,
  getClientAiUsage,
  getClientWebPolicy,
  getCurrentUserWorkspaces,
  getIssueDetail,
  getPublisherIssue,
  getNotificationPreferences,
  getPlatformOperations,
  getProductExport,
  getPublisherAiPullMetrics,
  inviteClientMember,
  invitePublisherClientAccess,
  invitePublisherMember,
  listActiveRestrictedSupportGrants,
  listClientArchive,
  listClientMembers,
  listClientPublicSources,
  listClientSubscriptionAccesses,
  listCompanyDeletionRequests,
  listNotifications,
  listPlatformCompanyDeletionRequests,
  listPublisherClientAccesses,
  listPublisherIssues,
  listPublisherMembers,
  listPublisherSubscriptions,
  listRestrictedSupportAccess,
  markNotificationRead,
  pausePublisherClientAccess,
  publishPublisherIssue,
  removePlatformIssueRestriction,
  requestCompanyDeletion,
  resolveAiUsageRequest,
  resolvePlatformCompanyDeletionRequest,
  restrictPlatformIssue,
  reviewRestrictedSupportAccess,
  schedulePublisherIssue,
  setClientMemberSubscriptionGrant,
  updateClientMember,
  updateClientPublicSource,
  updateClientWebPolicy,
  updateCompanyAiLimit,
  updateEmployeeAiLimit,
  updateNotificationPreferences,
  updatePublisherIssue,
  updatePublisherMember,
  uploadPublisherDocument,
} = client;

/** Browser-only presentation adapter; retrieval and decoding stay in the package. */
export const openRestrictedSupportGrantContent = async (grantId: string): Promise<void> => {
  const target = window.open("about:blank", "_blank");
  if (target === null) throw new ApiResponseError(0, "support_content_popup_blocked");
  target.opener = null;
  try {
    const content = await client.getRestrictedSupportGrantContent(grantId);
    const blob =
      content.kind === "binary"
        ? await content.response.blob()
        : new Blob([JSON.stringify(content.value, null, 2)], {
            type: "application/json",
          });
    const location = URL.createObjectURL(blob);
    target.location.replace(location);
    window.setTimeout(() => URL.revokeObjectURL(location), 5 * 60 * 1_000);
  } catch (error) {
    target.close();
    throw error;
  }
};

/** Browser-only adapter over the validated final response of the canonical 302 route. */
export const openProductExportDownload = async (downloadPath: string): Promise<void> => {
  validateProductExportDownloadPath(downloadPath);
  const target = window.open("about:blank", "_blank");
  if (target === null) throw new ApiResponseError(0, "export_download_popup_blocked");
  target.opener = null;
  try {
    const response = await client.getProductExportDownload(downloadPath);
    const location = URL.createObjectURL(await response.blob());
    target.location.replace(location);
    window.setTimeout(() => URL.revokeObjectURL(location), 5 * 60 * 1_000);
  } catch (error) {
    target.close();
    throw error;
  }
};

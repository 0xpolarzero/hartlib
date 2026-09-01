export * from "./components/ui/index";

export {
  AppShell,
  type AppShellProps,
  type PublisherSubnavItem,
} from "./components/product/app-shell";
export {
  ClientChat,
  type ClientChatResizeAdapter,
  type ClientChatLayoutState,
  type ClientChatProps,
} from "./components/product/client-chat";
export {
  CommandPalette,
  useCommandPalette,
  type PaletteAction,
  type PaletteState,
} from "./components/product/command-palette";
export {
  DataTable,
  SortableTableHead,
  type DataTableColumn,
  type DataTableProps,
  type DemoDataState,
} from "./components/product/data-table";
export {
  IssueWizard,
  type IssueWizardProps,
  type IssueWizardStep,
  type IssueWizardValue,
} from "./components/product/issue-wizard";
export {
  NotificationBell,
  type PublisherNotification,
} from "./components/product/notification-bell";
export {
  NotificationSettings,
  type NotificationSettingRow,
  type NotificationSettingsProps,
} from "./components/product/notification-settings";
export {
  SubscriberSubscriptions,
  type SubscriberSubscriptionsProps,
  type SubscriptionDocument,
  type SubscriptionPublication,
  type SubscriptionSource,
} from "./components/product/subscriber-subscriptions";
export {
  DocumentsTable,
  PublicationsTable,
  SourcesTable,
  SubscribersTable,
  type DocumentsTableProps,
  type NewPublisherSubscriber,
  type PublicationsTableProps,
  type PublisherDocument,
  type PublisherPublicationRow,
  type PublisherSourceRow,
  type PublisherSubscriberRow,
  type PublisherTableState,
  type SourcesTableProps,
  type SubscribersTableProps,
} from "./components/product/tables";
export {
  PublisherComposition,
  PUBLISHER_COMPOSITION_TABS,
  type DormantPublisherCompositionProps,
  type PublisherCompositionProps,
  type PublisherCompositionTab,
} from "./components/product/publisher";
export {
  Gallery,
  type GalleryCompanyOption,
  type GalleryLinkProps,
  type GalleryProps,
} from "./components/product/gallery";
export {
  CitationChip,
  CitationProvider,
  ClaimSpan,
  MarginCard,
  citationKindLabel,
  hasMarkers,
  injectCitations,
} from "./components/product/chat/citations";
export { AnswerBody, splitBlocks, type CopyAdapter } from "./components/product/chat/markdown";
export { AssistantMessage, FailureBlock, UserMessage } from "./components/product/chat/message";
export {
  Composer,
  type ComposerProps,
  type DictationAdapter,
  type DictationState,
} from "./components/product/chat/composer";
export {
  DebugDrawer,
  type DebugDrawerProps,
  type DebugLoadState,
} from "./components/product/chat/debug-drawer";
export { MemoriesPanel, type MemoriesPanelProps } from "./components/product/chat/memories-panel";
export { RunRail, RunStatusLine } from "./components/product/chat/run-rail";
export {
  SourcesDisclosure,
  type SourcesDisclosureProps,
} from "./components/product/chat/sources-disclosure";
export {
  Transcript,
  TRANSCRIPT_NEAR_BOTTOM_PX,
  type TranscriptProps,
} from "./components/product/chat/transcript";
export { VizPane, type VizPaneProps } from "./components/product/chat/viz-pane";
export {
  parseCitationTags,
  stripPendingCitationTail,
  type CitationMarkerSegment,
  type CitationParseMode,
  type CitationTagSegment,
  type CitationTextSegment,
  type ParsedCitationTags,
} from "./components/product/chat/citation-tags";
export {
  createAuthenticatedDocumentOpener,
  publisherDocumentCitationTarget,
  type AuthenticatedDocumentBrowser,
  type AuthenticatedDocumentOpener,
  type AuthenticatedPublisherDocument,
  type PublisherDocumentCitationTarget,
  type PublisherDocumentLoader,
} from "./components/product/chat/authenticated-document";
export {
  memoryRevisionFragment,
  parseMemoryRevisionFragment,
  type MemoryRevisionFragment,
} from "./components/product/chat/memory-provenance";
export type {
  ChatRunProjection,
  ChatTranscriptMessage,
  RunDiagnostics,
  RunFailure,
  RunStageId,
  RunStages,
  StageStatus,
  VisualizationAssociation,
  VisualizationPresentationState,
  VisualizationState,
  VisualizationVersion,
} from "./components/product/chat/types";
export { AnnounceProvider, useAnnounce } from "./lib/announce";
export {
  formatBytes,
  formatDate,
  formatDateShort,
  formatDateTime,
  formatMonthYear,
  formatNumber,
  formatTime,
  uiMessage,
} from "./lib/format";
export { clamp, cn, safeId } from "./lib/utils";
export { standaloneDocumentCss } from "./styles/document-style";

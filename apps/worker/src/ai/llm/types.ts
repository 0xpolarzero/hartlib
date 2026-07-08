import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";

import type { SourceAccess } from "../retrieval/query-spec";
import type { ChatHistoryMessage } from "../window/assemble-prompt";
import type { ManifestEntry, MemoryItem, MemoryKind } from "../window/blocks";

export const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
});

export type AiCallResult<A> =
  | { readonly kind: "ok"; readonly value: A }
  | {
      readonly kind: "overflow";
      readonly message: AssistantMessage;
      readonly usage: Usage;
      readonly errorMessage: string;
    }
  | {
      readonly kind: "retryable";
      readonly message: AssistantMessage;
      readonly usage: Usage;
      readonly errorMessage: string;
    }
  | {
      readonly kind: "fatal";
      readonly message: AssistantMessage;
      readonly usage: Usage;
      readonly errorMessage: string;
    };

export interface SourceCatalogSummaryItem {
  readonly sourceId: string;
  readonly displayName: string;
  readonly country: string;
  readonly language: string;
  readonly ingestionType: string;
}

export interface StandingWindowBlockSummary {
  readonly blockId: string;
  readonly label: string;
  readonly tokenEstimate: number;
}

export interface PreflightInputs {
  readonly systemPrompt: string;
  readonly sourceCatalog: readonly SourceCatalogSummaryItem[];
  readonly today: string;
  readonly market: string;
  readonly locale: string;
  readonly standingWindow: readonly StandingWindowBlockSummary[];
  readonly memories: readonly MemoryItem[];
  readonly history: readonly ChatHistoryMessage[];
  readonly userMessage: string;
  readonly remainingBlockBudget: number;
  readonly insufficiencyGap?: string | undefined;
}

export interface PreflightToolContext {
  readonly access: SourceAccess;
  readonly maxSearchLimit: number;
  readonly recencyHalfLifeDays: number;
  readonly now?: Date | undefined;
}

export type PreflightToolEvent =
  | {
      readonly type: "search";
      readonly terms: string;
      readonly resultCount: number;
    }
  | {
      readonly type: "peek";
      readonly documentId: string;
      readonly offsetChars: number | null;
      readonly lengthChars: number | null;
      readonly found: boolean;
    }
  | {
      readonly type: "manifest";
      readonly entries: readonly ManifestEntry[];
    }
  | {
      readonly type: "tool_rejected";
      readonly toolName: string;
      readonly reason: string;
    }
  | {
      readonly type: "degraded";
      readonly reason: "forced_manifest" | "empty_delta";
    };

export interface PreflightOutput {
  readonly manifest: readonly ManifestEntry[];
  readonly usage: Usage;
  readonly toolEvents: readonly PreflightToolEvent[];
}

export interface PromptMessagePart {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface StreamAnswerInput {
  readonly systemPrompt: string;
  readonly messages: readonly PromptMessagePart[];
}

export interface AnswerOutput {
  readonly message: AssistantMessage;
  readonly text: string;
  readonly usage: Usage;
  readonly insufficiencyGap: string | null;
}

export type AnswerStreamEvent =
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "result"; readonly result: AiCallResult<AnswerOutput> };

export interface ExistingMemory {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
}

export interface ProposedMemory {
  readonly kind: MemoryKind;
  readonly content: string;
  readonly evidenceQuote: string;
  readonly targetMemoryId?: string | undefined;
}

export interface DiscardedMemoryProposal {
  readonly proposal: ProposedMemory;
  readonly reason: "empty_content" | "invalid_quote" | "duplicate" | "write_cap";
}

export interface MemoryExtractionInput {
  readonly userText: string;
  readonly existingMemories: readonly ExistingMemory[];
}

export interface MemoryExtractionOutput {
  readonly proposals: readonly ProposedMemory[];
  readonly discarded: readonly DiscardedMemoryProposal[];
  readonly usage: Usage;
}

export interface AiClient {
  runPreflight(
    inputs: PreflightInputs,
    toolContext: PreflightToolContext,
  ): Promise<AiCallResult<PreflightOutput>>;

  streamAnswer(input: StreamAnswerInput): AsyncIterable<AnswerStreamEvent>;

  extractMemories(input: MemoryExtractionInput): Promise<AiCallResult<MemoryExtractionOutput>>;
}

export const toPiMessages = (messages: readonly PromptMessagePart[]): Message[] =>
  messages.map((message) =>
    message.role === "user"
      ? {
          role: "user",
          content: message.content,
          timestamp: Date.now(),
        }
      : {
          role: "assistant",
          content: [{ type: "text", text: message.content }],
          api: "openai-completions",
          provider: "zai",
          model: "history",
          usage: zeroUsage(),
          stopReason: "stop",
          timestamp: Date.now(),
        },
  );

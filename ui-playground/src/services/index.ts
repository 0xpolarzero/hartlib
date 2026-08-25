import { MockApi } from "./mock/engine";
import type { ApiClient } from "./types";

export type * from "./types";

/**
 * The app only ever talks to this interface — swap `mock` for a real client
 * without touching consumers. The mock simulates latency, SSE streaming and
 * failures deterministically.
 */
export const api: ApiClient = new MockApi();

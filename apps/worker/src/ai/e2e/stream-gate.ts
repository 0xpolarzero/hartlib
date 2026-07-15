const streamGateIdPattern = /^[A-Za-z0-9_-]{1,80}$/u;
const streamGateMarkerPattern = /\[e2e-stream-gate:([A-Za-z0-9_-]{1,80})\]/u;

export const isE2eStreamGateId = (value: string): boolean => streamGateIdPattern.test(value);

export const e2eStreamGateLockKey = (gateId: string): string =>
  `brief:ai:e2e-stream-gate:${gateId}`;

export const e2eStreamGateIdFromMessage = (message: string): string | null =>
  streamGateMarkerPattern.exec(message)?.[1] ?? null;

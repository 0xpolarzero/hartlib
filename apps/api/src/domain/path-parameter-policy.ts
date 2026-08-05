import {
  OpaquePathParameter,
  PositiveIntegerPathParameter,
  UuidPathParameter,
} from "@hartlib/shared";
import { Schema } from "effect";

import type { Route } from "../http";

export type PathParameterKind = "uuid" | "opaque" | "positive_integer";

const opaqueParameters = new Set([
  "PUT /v1/client-companies/:companyId/public-sources/:sourceId sourceId",
  "PUT /v1/public-sources/:sourceId sourceId",
  "GET /public-source-documents/:documentId/content documentId",
  "PUT /v1/client-companies/:companyId/members/:userId/ai-limit userId",
  "PATCH /v1/publisher-companies/:companyId/members/:userId userId",
  "DELETE /v1/publisher-companies/:companyId/members/:userId userId",
  "PATCH /v1/client-companies/:companyId/members/:userId userId",
  "DELETE /v1/client-companies/:companyId/members/:userId userId",
  "POST /v1/client-companies/:companyId/members/:userId/subscription-grants userId",
  "DELETE /v1/client-companies/:companyId/members/:userId/subscription-grants/:accessId userId",
]);

const positiveIntegerParameters = new Set([
  "POST /v1/platform/support/access/:accessId/review accessId",
]);

export const pathParameterNames = (path: string): ReadonlyArray<string> =>
  [...path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/gu)].map((match) => match[1]!);

export const pathParameterKind = (
  method: Route["method"],
  path: Route["path"],
  name: string,
): PathParameterKind => {
  const key = `${method} ${path} ${name}`;
  if (opaqueParameters.has(key)) return "opaque";
  if (positiveIntegerParameters.has(key)) return "positive_integer";
  return "uuid";
};

const schemaFor = (kind: PathParameterKind) =>
  kind === "uuid"
    ? UuidPathParameter
    : kind === "positive_integer"
      ? PositiveIntegerPathParameter
      : OpaquePathParameter;

export type DecodedPathParameters = Readonly<Record<string, string>>;

/**
 * Validate the decoded parameters captured by Effect HTTP and return the exact
 * values consumed by the endpoint adapter. This keeps matching, validation,
 * and consumption on one canonical path; adapters never reconstruct IDs from
 * the raw URL.
 */
export const decodePathParameters = (
  route: Route,
  captured: Readonly<Record<string, string | undefined>>,
): DecodedPathParameters | null => {
  const names = pathParameterNames(route.path);
  if (names.length === 0) return {};
  const decoded: Record<string, string> = {};
  for (const name of names) {
    const value = captured[name];
    if (value === undefined) return null;
    try {
      Schema.decodeUnknownSync(schemaFor(pathParameterKind(route.method, route.path, name)))(value);
    } catch {
      return null;
    }
    decoded[name] = value;
  }
  return decoded;
};

export const pathParameterPolicyExceptions = {
  opaque: [...opaqueParameters].sort(),
  positiveInteger: [...positiveIntegerParameters].sort(),
} as const;

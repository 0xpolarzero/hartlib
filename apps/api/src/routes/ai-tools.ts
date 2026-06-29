import { Effect } from "effect";
import { json, type Route } from "../http";

const placeholderToolResponse = (tool: string) =>
  json(
    {
      tool,
      status: "placeholder",
      results: [],
    },
    { status: 501 },
  );

export const listIssuesToolRoute: Route = {
  method: "POST",
  pattern: /^\/v1\/ai\/tools\/list_issues$/,
  handle: () => Effect.succeed(placeholderToolResponse("list_issues")),
};

export const searchIssuesToolRoute: Route = {
  method: "POST",
  pattern: /^\/v1\/ai\/tools\/search_issues$/,
  handle: () => Effect.succeed(placeholderToolResponse("search_issues")),
};

export const readIssueToolRoute: Route = {
  method: "POST",
  pattern: /^\/v1\/ai\/tools\/read_issue$/,
  handle: () => Effect.succeed(placeholderToolResponse("read_issue")),
};

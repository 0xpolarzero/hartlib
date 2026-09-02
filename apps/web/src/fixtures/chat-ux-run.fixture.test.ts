import type { AiRunActivityEvent } from "@hartlib/ui";

import { describe, expect, it } from "vitest";

import { chatUxRunFixture } from "./chat-ux-run.fixture";

describe("chat UX live run fixture", () => {
  it("contains recorded internal and web retrieval activity", () => {
    const activities: readonly AiRunActivityEvent[] = chatUxRunFixture.run.activities;
    expect(chatUxRunFixture.captureMode).toBe("running_after_context_ready");
    expect(
      activities.some(
        (activity) =>
          activity.detail?.kind === "internal_queries" && activity.status === "complete",
      ),
    ).toBe(true);
    const webSearch = activities.find(
      (activity) => activity.detail?.kind === "web_search" && activity.status === "complete",
    );
    expect(webSearch?.detail).toMatchObject({
      kind: "web_search",
      query: "raccordement solaire France Enedis statistiques officiel",
      resultCount: 9,
    });
    const webFetch = activities.find(
      (activity) => activity.detail?.kind === "web_fetch" && activity.status === "complete",
    );
    expect(webFetch?.detail).toMatchObject({
      kind: "web_fetch",
      domain: "www.statistiques.developpement-durable.gouv.fr",
      title: "Statinfo - solaire photovoltaique",
    });
    expect(activities.filter((activity) => activity.status === "retrying").length).toBeGreaterThan(
      0,
    );
  });

  it("contains the three source records selected for answer context", () => {
    expect(chatUxRunFixture.sourcesRead.map((source) => source.kind)).toEqual([
      "document",
      "document",
      "web",
    ]);
    expect(chatUxRunFixture.sourcesRead.map((source) => source.sourceKey)).toHaveLength(3);
    expect(chatUxRunFixture.answer).toBeNull();
    expect(chatUxRunFixture.answerState).toBe("not_started");
  });
});

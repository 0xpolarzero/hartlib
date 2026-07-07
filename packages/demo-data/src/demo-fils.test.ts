import { publicSourceDefinitions } from "@brief/source-ingestion";
import { describe, expect, it } from "vitest";

import { demoIssues, demoSources } from "./index";
import { buildDemoFils, publicSourceDemoIssues } from "./demo-fils";
import { demoFils, findDemoIssueById } from "./index";

describe("buildDemoFils", () => {
  it("includes all publisher invite sources", () => {
    const fils = buildDemoFils(demoSources, demoIssues);
    const publisherFils = fils.filter((fil) => fil.sourceType === "publisher_invite");
    expect(publisherFils).toHaveLength(demoSources.length);
    for (const source of demoSources) {
      const fil = publisherFils.find((f) => f.id === source.id);
      expect(fil).toBeDefined();
      expect(fil?.name).toBe(source.name);
      expect(fil?.publisherName).toBe(source.branding.publisherName);
      expect(fil?.branding).toBe(source.branding);
    }
  });

  it("includes all 7 public sources from publicSourceDefinitions", () => {
    const fils = buildDemoFils(demoSources, demoIssues);
    const publicFils = fils.filter((fil) => fil.sourceType === "public");
    expect(publicFils).toHaveLength(publicSourceDefinitions.length);
    expect(publicSourceDefinitions).toHaveLength(7);
    for (const def of publicSourceDefinitions) {
      const fil = publicFils.find((f) => f.id === def.id);
      expect(fil).toBeDefined();
      expect(fil?.name).toBe(def.displayName);
      expect(fil?.publisherName).toBe(def.publisherName);
      expect(fil?.expectedCadence).toBe(def.expectedCadence);
      expect(fil?.branding).toBeUndefined();
    }
  });

  it("assigns correct sourceType to each fil", () => {
    for (const fil of demoFils) {
      if (fil.sourceType === "publisher_invite") {
        expect(demoSources.some((s) => s.id === fil.id)).toBe(true);
      } else if (fil.sourceType === "public") {
        expect(publicSourceDefinitions.some((s) => s.id === fil.id)).toBe(true);
      }
    }
  });

  it("computes lastPublicationDate from the latest issue for each fil", () => {
    for (const fil of demoFils) {
      if (fil.sourceType === "publisher_invite") {
        const sourceIssues = demoIssues.filter((i) => i.sourceId === fil.id);
        if (sourceIssues.length > 0) {
          let expected = sourceIssues[0]!.publicationDate;
          for (const issue of sourceIssues) {
            if (issue.publicationDate > expected) expected = issue.publicationDate;
          }
          expect(fil.lastPublicationDate).toBe(expected);
        }
      }
      if (fil.sourceType === "public") {
        const sourceIssues = publicSourceDemoIssues.filter((i) => i.sourceId === fil.id);
        if (sourceIssues.length > 0) {
          let expected = sourceIssues[0]!.publicationDate;
          for (const issue of sourceIssues) {
            if (issue.publicationDate > expected) expected = issue.publicationDate;
          }
          expect(fil.lastPublicationDate).toBe(expected);
        }
      }
    }
  });

  it("has unique fil ids across publisher and public sources", () => {
    const ids = demoFils.map((fil) => fil.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defaults subscribed to true for all fils", () => {
    for (const fil of demoFils) {
      expect(fil.subscribed).toBe(true);
    }
  });
});

describe("publicSourceDemoIssues", () => {
  it("references valid public source ids", () => {
    const validSourceIds = new Set(publicSourceDefinitions.map((def) => def.id));
    for (const issue of publicSourceDemoIssues) {
      expect(validSourceIds.has(issue.sourceId as never)).toBe(true);
    }
  });

  it("has at least one issue per public source", () => {
    const sourceIdsWithIssues = new Set(publicSourceDemoIssues.map((i) => i.sourceId));
    for (const def of publicSourceDefinitions) {
      expect(sourceIdsWithIssues.has(def.id)).toBe(true);
    }
  });
});

describe("findDemoIssueById", () => {
  it("finds a publisher issue by id", () => {
    const issue = findDemoIssueById("issue_regfin_2026_06_24");
    expect(issue).toBeDefined();
    expect(issue?.sourceId).toBe("source_regulation_financiere");
  });

  it("finds a public source issue by id", () => {
    const issue = findDemoIssueById("public_issue_service_public_2026_06_28");
    expect(issue).toBeDefined();
    expect(issue?.sourceId).toBe("service_public_rss");
  });

  it("returns undefined for unknown ids", () => {
    expect(findDemoIssueById("nonexistent")).toBeUndefined();
  });
});

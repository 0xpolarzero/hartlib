import { useState } from "react";
import { VizPane, type VisualizationVersion, uiMessage } from "@hartlib/ui";

export function visualizationFixtureVersionsForLocale(
  locale = "en-US",
): readonly VisualizationVersion[] {
  const trend = uiMessage(locale, "ui.visualizationEnergyPriceTrend");
  const revised = uiMessage(locale, "ui.visualizationEnergyPriceTrendRevised");
  const settlement = uiMessage(locale, "ui.visualizationJuneSettlement");
  const chart = uiMessage(locale, "ui.visualizationLineChart");
  return [
    {
      id: "viz-v1",
      specId: "energy-price",
      label: trend,
      html: `<!doctype html><html><body style='font:14px sans-serif;padding:24px'><h1>${trend}</h1><svg viewBox='0 0 320 120' width='100%' role='img' aria-label='${chart}'><polyline fill='none' stroke='#0f766e' stroke-width='3' points='0,92 55,75 110,80 165,48 220,56 280,20 320,28'/></svg></body></html>`,
      createdAt: "2026-06-24T12:00:00.000Z",
    },
    {
      id: "viz-v2",
      specId: "energy-price",
      label: revised,
      html: `<!doctype html><html><body style='font:14px sans-serif;padding:24px'><h1>${trend}</h1><p>${settlement}</p><svg viewBox='0 0 320 120' width='100%' role='img' aria-label='${chart}'><polyline fill='none' stroke='#b45309' stroke-width='3' points='0,90 55,70 110,76 165,42 220,50 280,18 320,24'/></svg></body></html>`,
      createdAt: "2026-06-25T09:30:00.000Z",
    },
  ];
}
export const visualizationFixtureVersions = visualizationFixtureVersionsForLocale();
export interface VisualizationFixtureProps {
  locale?: string;
  onEvent?: (event: string) => void;
}

export function VisualizationFixture({
  locale = "en-US",
  onEvent,
}: VisualizationFixtureProps = {}) {
  const versions = visualizationFixtureVersionsForLocale(locale);
  const [activeVersionId, setActiveVersionId] = useState("viz-v1");
  return (
    <div className="grid gap-5" data-testid="visualization-fixture">
      <section className="h-80">
        <h2 className="mb-2 font-display text-lg">
          {uiMessage(locale, "ui.visualizationEmptyFixture")}
        </h2>
        <VizPane locale={locale} versions={[]} activeVersionId={null} />
      </section>
      <section className="h-96">
        <h2 className="mb-2 font-display text-lg">
          {uiMessage(locale, "ui.visualizationVersionsFixture")}
        </h2>
        <VizPane
          locale={locale}
          versions={versions}
          activeVersionId={activeVersionId}
          state="idle"
          association={{ messageId: "message-42", versionId: "viz-v1" }}
          onSelectVersion={(id) => {
            setActiveVersionId(id);
            onEvent?.(`viz.select:${id}`);
          }}
          onRestoreVersion={(id) => {
            setActiveVersionId(id);
            onEvent?.(`viz.restore:${id}`);
          }}
          onRefresh={() => onEvent?.("viz.refresh")}
          onDownload={(selected) => onEvent?.(`viz.download:${selected.id}`)}
          onFullscreen={() => onEvent?.("viz.fullscreen")}
          onShow={(association) => onEvent?.(`viz.show:${association.messageId}`)}
        />
      </section>
      <section className="h-96">
        <h2 className="mb-2 font-display text-lg">
          {uiMessage(locale, "ui.visualizationRegeneratingFixture")}
        </h2>
        <VizPane
          locale={locale}
          versions={versions}
          activeVersionId="viz-v1"
          state="regenerating"
          highlightKey="price"
          onRefresh={() => onEvent?.("viz.refresh:regenerating")}
        />
      </section>
    </div>
  );
}
export default VisualizationFixture;

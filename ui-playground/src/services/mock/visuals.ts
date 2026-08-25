import type { VisualSpec } from "@/services/types";
import type { Locale } from "@/i18n";

/*
 * Generates self-contained HTML documents (hand-rolled SVG, no scripts, no
 * network) rendered inside a fully sandboxed iframe (`sandbox=""`).
 * Numbers are pre-formatted with Intl before injection; all text is escaped.
 */

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const num = (locale: Locale, n: number) => new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US").format(n);

function shell(title: string, subtitle: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #faf8f3; color: #211d16; font-size: 12.5px; line-height: 1.45;
    padding: 16px 18px 18px;
  }
  h1 { font-family: Georgia, "Times New Roman", serif; font-size: 17px; font-weight: 500; }
  .sub { color: #5c5546; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; margin: 4px 0 2px; }
  .foot { color: #8a8272; font-size: 10px; margin-top: 12px; border-top: 1px solid #e3ddd0; padding-top: 8px; font-family: ui-monospace, monospace; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th { text-align: left; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: #5c5546; border-bottom: 1px solid #cfc7b4; padding: 6px 8px 6px 0; font-weight: 500; }
  td { border-bottom: 1px solid #e3ddd0; padding: 7px 8px 7px 0; }
  td.num, th.num { text-align: right; font-family: ui-monospace, monospace; }
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0; border: 1px solid #e3ddd0; }
  .kpi { padding: 12px 12px 10px; border-right: 1px solid #e3ddd0; }
  .kpi:last-child { border-right: 0; }
  .kpi .label { font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase; color: #5c5546; }
  .kpi .value { font-family: Georgia, serif; font-size: 24px; margin: 6px 0 2px; }
  .kpi .delta { font-family: ui-monospace, monospace; font-size: 10.5px; }
  .up { color: #23694a; } .down { color: #a02c22; } .flat { color: #5c5546; }
  svg text { font-family: system-ui, sans-serif; }
</style>
</head>
<body>
<p class="sub">${esc(subtitle)}</p>
<h1>${esc(title)}</h1>
${body}
<p class="foot">BREF · GÉNÉRÉ AUTOMATIQUEMENT · SANS DONNÉES CONFIDENTIELLES</p>
</body>
</html>`;
}

function barChart(spec: Extract<VisualSpec, { kind: "bar" }>, locale: Locale): string {
  const W = 560, H = 260, padL = 46, padB = 30, padT = 14;
  const innerW = W - padL - 12, innerH = H - padT - padB;
  const groups = spec.categories.length;
  const series = spec.series.length;
  const groupW = innerW / groups;
  const barW = Math.min(26, (groupW - 14) / series);
  const max = Math.max(...spec.series.flatMap((s) => s.values), 1);
  const steps = 4;
  let grid = "";
  for (let i = 0; i <= steps; i++) {
    const y = padT + innerH - (innerH * i) / steps;
    const v = (max * i) / steps;
    grid += `<line x1="${padL}" y1="${y}" x2="${W - 12}" y2="${y}" stroke="#e3ddd0" stroke-width="1"/>
      <text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9.5" fill="#8a8272">${num(locale, Math.round(v))}</text>`;
  }
  let bars = "";
  const fills = ["#9d2235", "#cfc7b4", "#5c5546"];
  spec.series.forEach((s, si) => {
    s.values.forEach((v, gi) => {
      const h = (v / max) * innerH;
      const x = padL + gi * groupW + (groupW - barW * series - 4 * (series - 1)) / 2 + si * (barW + 4);
      const y = padT + innerH - h;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" fill="${fills[si % fills.length]}"><title>${esc(spec.categories[gi])} — ${esc(s.name)} : ${num(locale, v)} ${esc(spec.unit)}</title></rect>`;
    });
  });
  const cats = spec.categories
    .map(
      (c, gi) =>
        `<text x="${padL + gi * groupW + groupW / 2}" y="${H - 10}" text-anchor="middle" font-size="9.5" fill="#5c5546">${esc(c.length > 14 ? c.slice(0, 13) + "…" : c)}</text>`,
    )
    .join("");
  const legend = spec.series
    .map((s, i) => `<span style="white-space:nowrap;margin-right:12px"><span style="display:inline-block;width:8px;height:8px;background:${fills[i % fills.length]};margin-right:4px"></span>${esc(s.name)}</span>`)
    .join("");
  return shell(
    spec.title,
    spec.subtitle,
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title)} — diagramme en barres" width="100%">${grid}${bars}${cats}</svg>
     <p style="font-size:10.5px;margin-top:6px;color:#5c5546">${legend}</p>`,
  );
}

function lineChart(spec: Extract<VisualSpec, { kind: "line" }>, locale: Locale): string {
  const W = 560, H = 260, padL = 46, padB = 30, padT = 14;
  const innerW = W - padL - 12, innerH = H - padT - padB;
  const n = spec.xLabels.length;
  const max = Math.max(...spec.series.flatMap((s) => s.values), 1);
  const steps = 4;
  let grid = "";
  for (let i = 0; i <= steps; i++) {
    const y = padT + innerH - (innerH * i) / steps;
    const v = (max * i) / steps;
    grid += `<line x1="${padL}" y1="${y}" x2="${W - 12}" y2="${y}" stroke="#e3ddd0" stroke-width="1"/>
      <text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9.5" fill="#8a8272">${num(locale, Math.round(v))}</text>`;
  }
  const xAt = (i: number) => padL + (innerW * i) / Math.max(n - 1, 1);
  const yAt = (v: number) => padT + innerH - (v / max) * innerH;
  const strokes = ["#9d2235", "#5c5546", "#8a5a12"];
  let paths = "";
  spec.series.forEach((s, si) => {
    const d = s.values.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
    paths += `<path d="${d}" fill="none" stroke="${strokes[si % strokes.length]}" stroke-width="1.75"><title>${esc(s.name)}</title></path>`;
    s.values.forEach((v, i) => {
      paths += `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" r="2.5" fill="#faf8f3" stroke="${strokes[si % strokes.length]}" stroke-width="1.5"><title>${esc(spec.xLabels[i])} — ${esc(s.name)} : ${num(locale, v)} ${esc(spec.unit)}</title></circle>`;
    });
  });
  const labels = spec.xLabels
    .map((l, i) => `<text x="${xAt(i)}" y="${H - 10}" text-anchor="middle" font-size="9.5" fill="#5c5546">${esc(l)}</text>`)
    .join("");
  const legend = spec.series
    .map((s, i) => `<span style="white-space:nowrap;margin-right:12px"><span style="display:inline-block;width:8px;height:8px;background:${strokes[i % strokes.length]};margin-right:4px"></span>${esc(s.name)}</span>`)
    .join("");
  return shell(
    spec.title,
    spec.subtitle,
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title)} — courbe" width="100%">${grid}${paths}${labels}</svg>
     <p style="font-size:10.5px;margin-top:6px;color:#5c5546">${legend}</p>`,
  );
}

function comparisonTable(spec: Extract<VisualSpec, { kind: "table" }>, locale: Locale): string {
  void locale;
  const head = spec.columns.map((c, i) => `<th class="${i > 0 ? "num" : ""}" scope="col">${esc(c)}</th>`).join("");
  const rows = spec.rows
    .map((r) => `<tr>${r.map((cell, i) => `<td class="${i > 0 ? "num" : ""}">${esc(cell)}</td>`).join("")}</tr>`)
    .join("");
  return shell(
    spec.title,
    spec.subtitle,
    `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`,
  );
}

function kpiStrip(spec: Extract<VisualSpec, { kind: "kpi" }>, locale: Locale): string {
  void locale;
  const items = spec.items
    .map(
      (it) =>
        `<div class="kpi"><p class="label">${esc(it.label)}</p><p class="value">${esc(it.value)}</p><p class="delta ${it.direction}">${esc(it.delta)}</p></div>`,
    )
    .join("");
  return shell(spec.title, spec.subtitle, `<div class="kpi-grid">${items}</div>`);
}

export function renderVisualDoc(spec: VisualSpec, locale: Locale): string {
  switch (spec.kind) {
    case "bar":
      return barChart(spec, locale);
    case "line":
      return lineChart(spec, locale);
    case "table":
      return comparisonTable(spec, locale);
    case "kpi":
      return kpiStrip(spec, locale);
  }
}

/** Deterministic jitter for “Refresh”: nudges values so a new version differs visibly. */
export function jitterSpec(spec: VisualSpec, rand: () => number): VisualSpec {
  const wobble = (v: number) => Math.max(0, Math.round(v * (0.94 + rand() * 0.12)));
  switch (spec.kind) {
    case "bar":
    case "line":
      return { ...spec, series: spec.series.map((s) => ({ ...s, values: s.values.map(wobble) })) };
    default:
      return spec;
  }
}

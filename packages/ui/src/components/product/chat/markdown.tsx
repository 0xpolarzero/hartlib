import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { uiMessage } from "../../../lib/format";
import { CitationChip, CitationProvider, ClaimSpan, MarginCard } from "./citations";
import { stripPendingCitationTail } from "./citation-tags";
import type { PublicCitationRecord } from "./types";

/* ── Block splitting (fence-aware) ──────────────────────────────────────
 * Top-level markdown blocks split on blank lines outside code fences.
 * Each block renders as its own memoized renderer — completed messages
 * never re-render, and during streaming only the growing last block does.
 */
export function splitBlocks(src: string): string[] {
  const lines = src.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") {
      if (current.length > 0) blocks.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks;
}

export interface CopyAdapter {
  copy: (text: string) => Promise<void>;
  defer: (callback: () => void, milliseconds: number) => void;
}
const CopyContext = createContext<CopyAdapter | null>(null);
const LocaleContext = createContext<string>("en-US");

/* ── Inline rendering (fence-aware blocks, secure links) ──────────────── */

type NumberedCitation = PublicCitationRecord & { ordinal: number; meta?: string | undefined };

function inline(
  text: string,
  sources: readonly NumberedCitation[],
  focusKeys: Set<string>,
): ReactNode[] {
  const map = new Map(sources.map((source) => [source.sourceKey, source]));
  const nodes: ReactNode[] = [];
  const token =
    /(\[\[cite:([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*)\]\])|(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^)]+)\))|(!\[([^\]]*)\]\([^)]*\))/g;
  let cursor = 0;
  for (const match of text.matchAll(token)) {
    const index = match.index ?? 0;
    const prefix = text.slice(cursor, index);
    if (match[2]) {
      const ids = match[2].split(",");
      if (prefix) {
        const boundary = Math.max(
          prefix.lastIndexOf(". "),
          prefix.lastIndexOf("! "),
          prefix.lastIndexOf("? "),
          prefix.lastIndexOf("\n"),
        );
        const plain = prefix.slice(
          0,
          boundary + (boundary >= 0 && prefix[boundary] !== "\n" ? 2 : 1),
        );
        const claim = prefix.slice(plain.length);
        if (plain) nodes.push(plain);
        if (claim)
          nodes.push(
            <ClaimSpan key={`claim-${index}`} cites={ids}>
              {claim}
            </ClaimSpan>,
          );
      }
      ids.forEach((id) => {
        const source = map.get(id);
        if (source) {
          const focusable = !focusKeys.has(id);
          focusKeys.add(id);
          nodes.push(
            <CitationChip
              key={`${id}-${index}`}
              source={source as NumberedCitation}
              focusable={focusable}
            />,
          );
        } else nodes.push(`[[cite:${id}]]`);
      });
    } else {
      if (prefix) nodes.push(prefix);
    }
    if (match[4])
      nodes.push(<strong key={`strong-${index}`}>{inline(match[4], sources, focusKeys)}</strong>);
    else if (match[6]) nodes.push(<code key={`code-${index}`}>{match[6]}</code>);
    else if (match[8])
      nodes.push(
        <a
          key={`link-${index}`}
          href={match[9]}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
        >
          {match[8]}
        </a>,
      );
    else if (match[11]) nodes.push(match[11] || "image");
    cursor = index + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function tableBlock(
  lines: readonly string[],
  sources: readonly NumberedCitation[],
  focusKeys: Set<string>,
): ReactNode | null {
  if (
    lines.length < 2 ||
    !/^\s*\|?.+\|.+\|?\s*$/.test(lines[0] ?? "") ||
    !/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[1] ?? "")
  )
    return null;
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  const headings = cells(lines[0]!);
  return (
    <div className="overflow-x-auto">
      <table>
        <thead>
          <tr>
            {headings.map((heading, index) => (
              <th key={index} scope="col">
                {inline(heading, sources, focusKeys)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines
            .slice(2)
            .filter((line) => line.trim() !== "")
            .map((line, rowIndex) => (
              <tr key={rowIndex}>
                {cells(line).map((cell, cellIndex) => (
                  <td key={cellIndex}>{inline(cell, sources, focusKeys)}</td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Code block with copy ─────────────────────────────────────────────── */

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const copyAdapter = useContext(CopyContext);
  const lang = /language-([\w-]+)/.exec(String(className ?? ""))?.[1] ?? "";
  const locale = useContext(LocaleContext);

  return (
    <div className="group/code relative">
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1.5">
        {lang && <span className="font-mono text-[10px] tracking-wide text-ink-2">{lang}</span>}
        <button
          type="button"
          className="flex h-5 items-center gap-1 rounded-tiny border border-line-2 bg-surface px-1.5 font-sans text-[10.5px] text-ink-2 opacity-0 transition-opacity duration-100 group-hover/code:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          aria-label={uiMessage(locale, "ui.copyCode")}
          onClick={async () => {
            const text = preRef.current?.textContent ?? "";
            try {
              if (copyAdapter !== null) {
                await copyAdapter.copy(text);
                setCopied(true);
                copyAdapter.defer(() => setCopied(false), 1400);
              } else {
                await navigator.clipboard.writeText(text);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              }
            } catch {
              /* clipboard unavailable — ignore */
            }
          }}
        >
          {copied ? (
            <Check aria-hidden="true" className="size-2.5 text-ok" />
          ) : (
            <Copy aria-hidden="true" className="size-2.5" />
          )}
          {copied ? uiMessage(locale, "ui.copied") : uiMessage(locale, "ui.copy")}
        </button>
      </div>
      <pre ref={preRef} className={className}>
        {children}
      </pre>
    </div>
  );
}

/* ── Block renderer (fence/table/lists/quote/headings/paragraph) ──────── */

function Block({
  source,
  sources,
  focusKeys,
}: {
  source: string;
  sources: readonly NumberedCitation[];
  focusKeys: Set<string>;
}) {
  const lines = source.split("\n");
  const fence = lines[0]?.match(/^\s*```(?:([\w-]+))?/);
  if (fence) {
    const code = lines
      .slice(1, lines[lines.length - 1]?.startsWith("```") ? -1 : undefined)
      .join("\n");
    const language = fence[1];
    return (
      <CodeBlock {...(language === undefined ? {} : { className: `language-${language}` })}>
        <code>{code}</code>
      </CodeBlock>
    );
  }
  const table = tableBlock(lines, sources, focusKeys);
  if (table) return table;
  if (lines.every((line) => /^\s*[-*]\s+/.test(line)))
    return (
      <ul>
        {lines.map((line, i) => (
          <li key={i}>{inline(line.replace(/^\s*[-*]\s+/, ""), sources, focusKeys)}</li>
        ))}
      </ul>
    );
  if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line)))
    return (
      <ol>
        {lines.map((line, i) => (
          <li key={i}>{inline(line.replace(/^\s*\d+[.)]\s+/, ""), sources, focusKeys)}</li>
        ))}
      </ol>
    );
  if (/^>\s?/.test(lines[0] ?? ""))
    return (
      <blockquote>
        {inline(lines.map((line) => line.replace(/^>\s?/, "")).join("\n"), sources, focusKeys)}
      </blockquote>
    );
  if (/^#{1,4}\s/.test(lines[0] ?? "")) {
    const match = /^#{1,4}/.exec(lines[0]!);
    const heading = inline(lines[0]!.replace(/^#{1,4}\s+/, ""), sources, focusKeys);
    switch (match?.[0].length ?? 2) {
      case 1:
        return <h1>{heading}</h1>;
      case 2:
        return <h2>{heading}</h2>;
      case 3:
        return <h3>{heading}</h3>;
      default:
        return <h4>{heading}</h4>;
    }
  }
  return <p>{inline(source, sources, focusKeys)}</p>;
}

/* ── Answer body: reading column + citation gutter ─────────────────────── */

export function AnswerBody({
  content,
  sources = [],
  streaming = false,
  locale = "en-US",
  onCitation,
  copyAdapter,
}: {
  content: string;
  sources?: readonly PublicCitationRecord[];
  streaming?: boolean;
  locale?: string;
  onCitation?: (citation: PublicCitationRecord) => void | Promise<void>;
  copyAdapter?: CopyAdapter;
}) {
  const visibleContent = streaming ? stripPendingCitationTail(content) : content;
  const blocks = useMemo(() => splitBlocks(visibleContent), [visibleContent]);
  const citationSources = useMemo<NumberedCitation[]>(
    () =>
      sources.map((source, index) => ({
        ...source,
        ordinal: index + 1,
        ...(source.kind === "web" && source.domain ? { meta: source.domain } : {}),
        ...(source.kind === "document" && (source.sourceName ?? source.issueTitle)
          ? { meta: source.sourceName ?? source.issueTitle }
          : {}),
      })),
    [sources],
  );
  const carded = useMemo(() => {
    const map = new Map<number, number>();
    blocks.forEach((block, index) => {
      for (const match of block.matchAll(/\[\[cite:([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*)\]\]/g)) {
        for (const sourceKey of match[1]!.split(",")) {
          const ordinal =
            citationSources.findIndex((candidate) => candidate.sourceKey === sourceKey) + 1;
          if (ordinal > 0 && !map.has(ordinal)) map.set(ordinal, index);
        }
      }
    });
    return map;
  }, [blocks, citationSources]);
  const focusKeys = new Set<string>();

  return (
    <CopyContext.Provider value={copyAdapter ?? null}>
      <CitationProvider
        sources={citationSources}
        carded={carded}
        locale={locale}
        {...(onCitation ? { onCitation } : {})}
      >
        <LocaleContext.Provider value={locale}>
          <div className="grid gap-3">
            {blocks.map((block, index) => {
              const blockCards = citationSources.filter(
                (source) => source.ordinal > 0 && carded.get(source.ordinal) === index,
              );
              const isLast = index === blocks.length - 1;
              return (
                <div
                  key={index}
                  className="lg:grid lg:grid-cols-[minmax(0,1fr)_13rem] lg:items-start lg:gap-x-5"
                >
                  <div className="prose-answer min-w-0">
                    <Block source={block} sources={citationSources} focusKeys={focusKeys} />
                    {streaming && isLast && (
                      <span
                        aria-hidden="true"
                        className="animate-caret ml-px inline-block h-[1em] w-[2px] translate-y-[2px] bg-accent align-baseline"
                      />
                    )}
                  </div>
                  {blockCards.length > 0 && (
                    <div className="hidden gap-2 lg:grid">
                      {blockCards.map((source) => (
                        <MarginCard key={source.sourceKey} source={source} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </LocaleContext.Provider>
      </CitationProvider>
    </CopyContext.Provider>
  );
}

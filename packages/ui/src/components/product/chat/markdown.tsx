import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../../../lib/utils";
import { uiMessage } from "../../../lib/format";
import { CitationChip, CitationProvider, ClaimSpan, MarginCard } from "./citations";
import { stripPendingCitationTail } from "./citation-tags";
import type { PublicCitationRecord } from "./types";

export function splitBlocks(source: string): string[] {
  const lines = source.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && line.trim() === "") {
      if (current.length) blocks.push(current.join("\n"));
      current = [];
    } else current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}
type NumberedCitation = PublicCitationRecord & { ordinal: number };
export interface CopyAdapter {
  copy: (text: string) => Promise<void>;
  defer: (callback: () => void, milliseconds: number) => void;
}
const CopyContext = createContext<CopyAdapter | null>(null);
function inline(
  text: string,
  sources: readonly PublicCitationRecord[],
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
  sources: readonly PublicCitationRecord[],
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
              <th key={index}>{inline(heading, sources, focusKeys)}</th>
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
function Block({
  source,
  sources,
  focusKeys,
  locale,
}: {
  source: string;
  sources: readonly PublicCitationRecord[];
  focusKeys: Set<string>;
  locale: string;
}) {
  const lines = source.split("\n");
  const fence = lines[0]?.match(/^\s*```(?:([\w-]+))?/);
  if (fence) {
    const code = lines
      .slice(1, lines[lines.length - 1]?.startsWith("```") ? -1 : undefined)
      .join("\n");
    return fence[1] === undefined ? (
      <CodeBlock locale={locale}>{code}</CodeBlock>
    ) : (
      <CodeBlock language={fence[1]} locale={locale}>
        {code}
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
function CodeBlock({
  language,
  children,
  locale = "en-US",
}: {
  language?: string;
  children: string;
  locale?: string;
}) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLPreElement>(null);
  const copyAdapter = useContext(CopyContext);
  return (
    <div className="group/code relative">
      <pre ref={ref}>
        <code className={cn(language === undefined ? false : `language-${language}`)}>
          {children}
        </code>
      </pre>
      <button
        type="button"
        aria-label={uiMessage(locale, "ui.copyCode")}
        className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-tiny border border-line-2 bg-surface px-1.5 py-0.5 text-[10.5px] opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100"
        onClick={async () => {
          if (copyAdapter === null) return;
          try {
            await copyAdapter.copy(ref.current?.textContent ?? children);
            setCopied(true);
            copyAdapter.defer(() => setCopied(false), 1200);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? <Check className="size-2.5 text-ok" /> : <Copy className="size-2.5" />}
        {copied ? uiMessage(locale, "ui.copied") : uiMessage(locale, "ui.copy")}
      </button>
    </div>
  );
}
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
    () => sources.map((source, index) => ({ ...source, ordinal: index + 1 })),
    [sources],
  );
  const shown = new Set<string>();
  const focusKeys = new Set<string>();
  return (
    <CopyContext.Provider value={copyAdapter ?? null}>
      <CitationProvider
        sources={citationSources}
        locale={locale}
        {...(onCitation === undefined ? {} : { onCitation })}
      >
        {blocks.map((block, index) => {
          const blockKeys = [
            ...block.matchAll(/\[\[cite:([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*)\]\]/g),
          ].flatMap((match) => match[1]!.split(","));
          const marginSources = citationSources.filter(
            (source) => blockKeys.includes(source.sourceKey) && !shown.has(source.sourceKey),
          );
          marginSources.forEach((source) => shown.add(source.sourceKey));
          return (
            <div key={index} className="lg:grid lg:grid-cols-[minmax(0,1fr)_13rem] lg:gap-x-5">
              <div className="prose-answer min-w-0">
                <Block
                  source={block}
                  sources={citationSources}
                  focusKeys={focusKeys}
                  locale={locale}
                />
                {streaming && index === blocks.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="animate-caret ml-px inline-block h-[1em] w-[2px] bg-accent align-baseline"
                  />
                )}
              </div>
              {marginSources.length > 0 && (
                <div className="hidden gap-2 lg:grid">
                  {marginSources.map((source) => (
                    <MarginCard key={source.sourceKey} source={source} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </CitationProvider>
    </CopyContext.Provider>
  );
}

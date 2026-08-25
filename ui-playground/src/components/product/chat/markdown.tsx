import { memo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { useI18n } from "@/i18n";
import type { CitedSource } from "@/services/types";
import { CitationProvider, injectCitations, hasMarkers, MarginCard } from "./citations";

/* ── Block splitting (fence-aware) ──────────────────────────────────────
 * Top-level markdown blocks split on blank lines outside code fences.
 * Each block renders as its own memoized ReactMarkdown — completed messages
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

/** ordinal → index of the first block citing it (earns the margin card). */
export function computeCardedBlocks(blocks: string[]): Map<number, number> {
  const map = new Map<number, number>();
  const re = /\[\[([\d,\s]+)(?:\|[^\]]*)?\]\]/g;
  blocks.forEach((block, i) => {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(block)) !== null) {
      for (const part of m[1].split(",")) {
        const n = Number(part.trim());
        if (n > 0 && !map.has(n)) map.set(n, i);
      }
    }
  });
  return map;
}

/* ── Inline citation injection into rendered markdown children ────────── */

function hasMarkerInTree(node: ReactNode): boolean {
  if (typeof node === "string") return hasMarkers(node);
  if (Array.isArray(node)) return node.some(hasMarkerInTree);
  if (node !== null && typeof node === "object" && "props" in node && node.props) {
    return hasMarkerInTree((node.props as { children?: ReactNode }).children);
  }
  return false;
}

function injectTree(node: ReactNode): ReactNode {
  if (typeof node === "string") {
    return hasMarkers(node) ? injectCitations(node) : node;
  }
  if (Array.isArray(node)) {
    let touched = false;
    const next = node.map((child) => {
      const mapped = injectTree(child);
      if (mapped !== child) touched = true;
      return mapped;
    });
    return touched ? next : node;
  }
  if (
    node !== null &&
    typeof node === "object" &&
    "props" in node &&
    node.props &&
    hasMarkerInTree((node.props as { children?: ReactNode }).children)
  ) {
    const props = node.props as { children?: ReactNode };
    return { ...node, props: { ...props, children: injectTree(props.children) } } as ReactNode;
  }
  return node;
}

/* ── Code block with copy ─────────────────────────────────────────────── */

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const lang = /language-([\w-]+)/.exec(String(className ?? ""))?.[1] ?? "";

  return (
    <div className="group/code relative">
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1.5">
        {lang && <span className="font-mono text-[10px] tracking-wide text-ink-2">{lang}</span>}
        <button
          type="button"
          className="flex h-5 items-center gap-1 rounded-tiny border border-line-2 bg-surface px-1.5 font-sans text-[10.5px] text-ink-2 opacity-0 transition-opacity duration-100 group-hover/code:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={async () => {
            const text = preRef.current?.textContent ?? "";
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            } catch {
              /* clipboard unavailable — ignore in demo */
            }
          }}
          aria-label={t("code.copy")}
        >
          {copied ? <Check aria-hidden="true" className="size-2.5 text-ok" /> : <Copy aria-hidden="true" className="size-2.5" />}
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <pre ref={preRef} className={className}>
        {children}
      </pre>
    </div>
  );
}

/* ── Block markdown (memoized per source block) ───────────────────────── */

type MdComponents = NonNullable<Parameters<typeof ReactMarkdown>[0]["components"]>;

const mdComponents: MdComponents = {
  pre: (props) => <CodeBlock {...(props as { children?: ReactNode; className?: string })} />,
  p: ({ children }) => <p>{injectTree(children)}</p>,
  li: ({ children }) => <li>{injectTree(children)}</li>,
  h1: ({ children }) => <h1>{injectTree(children)}</h1>,
  h2: ({ children }) => <h2>{injectTree(children)}</h2>,
  h3: ({ children }) => <h3>{injectTree(children)}</h3>,
  h4: ({ children }) => <h4>{injectTree(children)}</h4>,
  th: ({ children }) => <th scope="col">{injectTree(children)}</th>,
  td: ({ children }) => <td>{injectTree(children)}</td>,
};

const BlockMarkdown = memo(function BlockMarkdown({ source }: { source: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
      components={mdComponents}
    >
      {source}
    </ReactMarkdown>
  );
});

/* ── Answer body: reading column + citation gutter ─────────────────────── */

export function AnswerBody({
  content,
  sources,
  streaming,
}: {
  content: string;
  sources: CitedSource[];
  streaming?: boolean;
}) {
  const blocks = splitBlocks(content);
  const carded = computeCardedBlocks(blocks);

  return (
    <CitationProvider sources={sources} carded={carded}>
      <div className="grid gap-3">
        {blocks.map((block, i) => {
          const blockCards = sources.filter((s) => s.ordinal > 0 && carded.get(s.ordinal) === i);
          const isLast = i === blocks.length - 1;
          return (
            <div key={i} className="lg:grid lg:grid-cols-[minmax(0,1fr)_13rem] lg:items-start lg:gap-x-5">
              <div className="prose-answer min-w-0">
                <BlockMarkdown source={block} />
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
                    <MarginCard key={source.ordinal} source={source} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </CitationProvider>
  );
}

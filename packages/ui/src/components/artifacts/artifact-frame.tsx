import { cn } from "../../lib/utils";

type ArtifactFrameProps = {
  title: string;
  html: string;
  className?: string;
};

export function ArtifactFrame({ title, html, className }: ArtifactFrameProps) {
  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-sm border border-rule bg-paper",
        className,
      )}
    >
      <div className="pointer-events-none absolute right-0 top-0 h-3 w-3 border-r border-t border-rule" />
      <div className="flex-shrink-0 border-b border-rule px-3 py-2">
        <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted">
          {title}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <iframe
          title={title}
          className="h-full min-h-[24rem] w-full"
          sandbox="allow-scripts"
          srcDoc={buildArtifactDocument(html)}
        />
      </div>
    </div>
  );
}

function buildArtifactDocument(html: string) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline';"
    />
    <style>
      html, body { margin: 0; min-height: 100%; background: #ffffff; color: #0f172a; }
      * { box-sizing: border-box; }
    </style>
  </head>
  <body>${html}</body>
</html>`;
}

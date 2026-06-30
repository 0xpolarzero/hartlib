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
        "relative bg-paper border border-rule overflow-hidden flex flex-col rounded-sm",
        className,
      )}
    >
      <div className="absolute top-0 right-0 w-3 h-3 pointer-events-none border-t border-r border-rule" />
      <div className="border-b border-rule px-4 py-2.5 flex-shrink-0">
        <span className="text-xs font-medium text-muted uppercase tracking-wider">{title}</span>
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

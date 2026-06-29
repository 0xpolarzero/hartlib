import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type ArtifactFrameProps = {
  title: string
  html: string
  className?: string
}

export function ArtifactFrame({ title, html, className }: ArtifactFrameProps) {
  return (
    <Card className={cn("flex flex-col overflow-hidden", className)}>
      <CardHeader className="border-b">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-0">
        <iframe
          title={title}
          className="h-full min-h-[24rem] w-full bg-white"
          sandbox="allow-scripts"
          srcDoc={buildArtifactDocument(html)}
        />
      </CardContent>
    </Card>
  )
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
</html>`
}

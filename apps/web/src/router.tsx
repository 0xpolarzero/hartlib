import { QueryClientProvider, type QueryClient } from "@tanstack/react-query"
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter
} from "@tanstack/react-router"

import { ArtifactFrame } from "@/components/artifacts/artifact-frame"
import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { queryClient } from "@/lib/query-client"

type RouterContext = {
  queryClient: QueryClient
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeRoute
})

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat/$chatId",
  component: ChatRoute
})

const routeTree = rootRoute.addChildren([indexRoute, chatRoute])

export const router = createRouter({
  routeTree,
  context: { queryClient }
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell>
        <Outlet />
      </AppShell>
    </QueryClientProvider>
  )
}

function HomeRoute() {
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-10">
      <div className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">Brief</p>
        <h1 className="text-3xl font-semibold tracking-normal text-foreground">
          Publisher issues, client archive search, and AI chat.
        </h1>
        <p className="text-base leading-7 text-muted-foreground">
          This frontend shell is ready for authenticated app routes, TanStack
          state wiring, and sandboxed AI artifacts.
        </p>
      </div>

      <div className="flex gap-3">
        <Button asChild>
          <a href="/chat/demo">Open chat</a>
        </Button>
      </div>
    </section>
  )
}

function ChatRoute() {
  return (
    <section className="grid min-h-[calc(100vh-8rem)] gap-4 py-6 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="flex min-h-[32rem] flex-col rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h1 className="text-sm font-medium">Chat</h1>
        </div>
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          Chat messages and source panels will render here.
        </div>
      </div>

      <ArtifactFrame
        title="Artifact preview"
        html={sampleArtifactHtml}
        className="min-h-[32rem]"
      />
    </section>
  )
}

const sampleArtifactHtml = `
  <main style="font-family: Inter, ui-sans-serif, system-ui; padding: 24px;">
    <p style="font-size: 12px; color: #64748b; margin: 0 0 8px;">Artifact</p>
    <h1 style="font-size: 24px; margin: 0 0 12px;">Issue timeline placeholder</h1>
    <p style="line-height: 1.6; color: #334155;">
      AI-generated HTML artifacts will render in this sandbox.
    </p>
  </main>
`

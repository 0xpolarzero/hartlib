import { RouterProvider } from "@tanstack/react-router"
import React from "react"
import ReactDOM from "react-dom/client"

import { queryClient } from "@/lib/query-client"
import { router } from "@/router"
import "@/styles.css"

const rootElement = document.getElementById("root")

if (!rootElement) {
  throw new Error("Missing root element")
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <RouterProvider router={router} context={{ queryClient }} />
  </React.StrictMode>
)

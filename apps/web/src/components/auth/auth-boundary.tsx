import { SignIn, SignedIn, SignedOut } from "@clerk/clerk-react";
import { createContext, useContext, type ReactNode } from "react";

interface WebSecurityContextValue {
  readonly mode: "demo" | "clerk";
  readonly securityContactEmail: string | null;
}

const WebAuthModeContext = createContext<WebSecurityContextValue>({
  mode: "clerk",
  securityContactEmail: null,
});

export function WebAuthModeProvider({
  value,
  children,
}: {
  readonly value: WebSecurityContextValue;
  readonly children: ReactNode;
}) {
  return <WebAuthModeContext.Provider value={value}>{children}</WebAuthModeContext.Provider>;
}

export const useWebSecurityContext = (): WebSecurityContextValue => useContext(WebAuthModeContext);

export function RequireAuthentication({ children }: { readonly children: ReactNode }) {
  const { mode } = useContext(WebAuthModeContext);
  if (mode === "demo") return children;
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <main className="flex min-h-[calc(100vh-8rem)] items-center justify-center p-6">
          <SignIn />
        </main>
      </SignedOut>
    </>
  );
}

import { useAuth } from "@clerk/clerk-react";
import { useEffect, type ReactNode } from "react";

import { setApiTokenProvider } from "@/lib/api-auth";
import { cleanupWebCollections } from "@/lib/db";
import { queryClient } from "@/lib/query-client";

export function ApiAuthBridge({ children }: { readonly children: ReactNode }) {
  const { getToken } = useAuth();

  useEffect(() => {
    queryClient.clear();
    void cleanupWebCollections();
    const resetTokenProvider = setApiTokenProvider(() => getToken());
    return () => {
      resetTokenProvider();
      queryClient.clear();
      void cleanupWebCollections();
    };
  }, [getToken]);
  return children;
}

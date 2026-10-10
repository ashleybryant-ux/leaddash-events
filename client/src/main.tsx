import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./lib/trpc";
import { App } from "./App";
import { ToastHost } from "./ui/toast";
import "./ui/theme.css";

function Root() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: (count, err: any) => count < 2 && !["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(err?.data?.code), refetchOnWindowFocus: true, staleTime: 15_000 },
        },
      })
  );
  const [client] = useState(() =>
    trpc.createClient({ links: [httpBatchLink({ url: "/api/trpc", transformer: superjson, fetch: (url, opts) => fetch(url, { ...opts, credentials: "include" }) })] })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
        <ToastHost />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => undefined));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);

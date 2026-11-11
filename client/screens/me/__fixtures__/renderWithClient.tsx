// A fresh react-query client per test, with no retries and no garbage-collection timers (gcTime Infinity schedules
// none), so a suite exits as soon as its tests end. The REAL hooks run on it; tests stub only lib/publicCardApi.
import React from "react";
import { render } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const r = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { ...r, client };
}

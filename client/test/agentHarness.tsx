/**
 * agentHarness — renders an agent card or screen the way the app does (its own query cache, an AgentApi, card handlers),
 * over the in-memory fixture API by default. For the agent UI's .test.tsx suites; not a test itself.
 */
import React from "react";
// Explicit import (not the ambient globals) so this helper also type-checks under the app's tsconfig.
import { jest } from "@jest/globals";

type Mock = ReturnType<typeof jest.fn>;
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react-native";
import { AgentApiProvider } from "../lib/agent/hooks";
import { fixtureAgentApi, type FixtureApiOptions } from "../lib/agent/fixtureApi";
import type { AgentApi } from "../lib/agent/api";
import { AgentCardHandlersProvider, type AgentCardHandlers } from "../components/agent/handlers";

export function makeHandlers(): Required<AgentCardHandlers> & { [K in keyof AgentCardHandlers]-?: Mock } {
  return {
    openLink: jest.fn(),
    startWorkflow: jest.fn(),
    prefill: jest.fn(),
    connect: jest.fn(async () => true) as Mock,
    act: jest.fn(async () => {}) as Mock,
    startCapability: jest.fn(),
    reply: jest.fn(),
  } as any;
}

/** Wraps every method of an AgentApi in a jest spy (calls still go through). */
export function spyApi<T extends AgentApi>(api: T): T & { [K in keyof AgentApi]: Mock } {
  const out: any = { ...api };
  for (const k of Object.keys(api) as Array<keyof AgentApi>) {
    const fn = (api as any)[k];
    if (typeof fn === "function") out[k] = jest.fn((...a: unknown[]) => fn(...a));
  }
  return out;
}

export function renderAgent(
  ui: React.ReactElement,
  { api, opts, handlers }: { api?: AgentApi; opts?: FixtureApiOptions; handlers?: AgentCardHandlers } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false } } });
  const theApi = api ?? spyApi(fixtureAgentApi(opts));
  const h = handlers ?? makeHandlers();
  const utils = render(
    <QueryClientProvider client={qc}>
      <AgentApiProvider api={theApi}>
        <AgentCardHandlersProvider value={h}>{ui}</AgentCardHandlersProvider>
      </AgentApiProvider>
    </QueryClientProvider>,
  );
  return { ...utils, api: theApi as AgentApi & { [K in keyof AgentApi]: Mock }, handlers: h as ReturnType<typeof makeHandlers>, qc };
}

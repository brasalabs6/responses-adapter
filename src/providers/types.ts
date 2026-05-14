import type { Request, Response } from "express";

import type { TraceSpan } from "../observability.js";
import type { GenericRecord } from "../adapter-utils.js";
import type { ResponsesStore } from "../responses-store.js";

export type ProviderServices = {
  responsesStore: ResponsesStore;
  debugLog: (message: string, extra?: unknown) => void;
  debugDumpJson: (filePath: string, value: unknown) => void;
};

export type ProviderContext = {
  req: Request;
  res: Response;
  requestSpan: TraceSpan | null;
  body: GenericRecord;
  upstreamModel: string;
  stream: boolean;
  providerApiKey: string;
  previousResponseId: string | null;
  services: ProviderServices;
};

export type ProviderAdapter = {
  id: string;
  modelPrefixes: readonly string[];
  getApiKey: () => string | undefined;
  handleChatCompletions: (context: ProviderContext) => Promise<void>;
  handleResponses: (context: ProviderContext) => Promise<void>;
};

export type ProviderResolution = {
  provider: ProviderAdapter;
  upstreamModel: string;
};

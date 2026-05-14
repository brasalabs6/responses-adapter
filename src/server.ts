import fs from "node:fs";

import dotenv from "dotenv";
import express, { NextFunction, Request, Response } from "express";

import {
  getPreviousResponseId,
  isRecord,
  isStreamRequested,
  sendOpenAIError,
  withRequestTrace,
  type GenericRecord,
} from "./adapter-utils.js";
import {
  getLangWatchEndpoint,
  isLangWatchEnabled,
  setSpanAttributes,
  setSpanOutput,
  type TraceSpan,
} from "./observability.js";
import { ResponsesStore } from "./responses-store.js";
import {
  buildProviderHealth,
  createDefaultProviders,
  resolveProvider,
  type ProviderAdapter,
  type ProviderServices,
} from "./providers/index.js";

dotenv.config();

const PORT = Number.parseInt(process.env.PORT ?? "19090", 10);
const ADAPTER_API_KEY = process.env.ADAPTER_API_KEY;
const ADAPTER_DEBUG = process.env.ADAPTER_DEBUG === "1";

if (!ADAPTER_API_KEY) {
  throw new Error("Missing required env var: ADAPTER_API_KEY");
}

type RequestWithRaw = Request & { rawBody?: string };

const app = express();
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      (req as RequestWithRaw).rawBody = buf.toString("utf8");
    },
  }),
);

function debugLog(message: string, extra?: unknown): void {
  if (!ADAPTER_DEBUG) return;
  if (extra !== undefined) {
    // eslint-disable-next-line no-console
    console.error(`[adapter-debug] ${message}`, extra);
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`[adapter-debug] ${message}`);
}

function debugDumpJson(filePath: string, value: unknown): void {
  if (!ADAPTER_DEBUG) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[adapter-debug] debugDumpJson failed", error);
  }
}

const responsesStore = new ResponsesStore({
  onWarning: (message, extra) => {
    // eslint-disable-next-line no-console
    console.warn(`[responses-store] ${message}`, extra ?? "");
  },
});

const providerAdapters = createDefaultProviders();
const providerServices: ProviderServices = {
  responsesStore,
  debugLog,
  debugDumpJson,
};

function requireAdapterAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    sendOpenAIError(res, 401, "Missing bearer token", "authentication_error");
    return;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (token !== ADAPTER_API_KEY) {
    sendOpenAIError(res, 403, "Invalid bearer token", "authentication_error");
    return;
  }

  next();
}

function providerApiKeyName(provider: ProviderAdapter): string {
  return `${provider.id.toUpperCase()}_API_KEY`;
}

function resolveProviderContext(
  req: Request,
  res: Response,
  requestSpan: TraceSpan | null,
): {
  body: GenericRecord;
  provider: ProviderAdapter;
  providerApiKey: string;
  upstreamModel: string;
  stream: boolean;
  previousResponseId: string | null;
} | null {
  const body = isRecord(req.body) ? req.body : {};

  let resolved;
  try {
    resolved = resolveProvider(body.model, providerAdapters);
  } catch (error) {
    setSpanAttributes(requestSpan, { "http.status_code": 400 });
    setSpanOutput(requestSpan, { error: error instanceof Error ? error.message : "Invalid model" });
    sendOpenAIError(res, 400, error instanceof Error ? error.message : "Invalid model");
    return null;
  }

  const { provider, upstreamModel } = resolved;
  const providerApiKey = provider.getApiKey();
  if (!providerApiKey) {
    setSpanAttributes(requestSpan, {
      "http.status_code": 500,
      "adapter.provider": provider.id,
    });
    setSpanOutput(requestSpan, { error: `Missing ${providerApiKeyName(provider)}` });
    sendOpenAIError(res, 500, `Missing ${providerApiKeyName(provider)}`, "configuration_error");
    return null;
  }

  return {
    body,
    provider,
    providerApiKey,
    upstreamModel,
    stream: isStreamRequested(body),
    previousResponseId: getPreviousResponseId(body),
  };
}

async function proxyChatCompletions(req: Request, res: Response, requestSpan: TraceSpan | null): Promise<void> {
  const context = resolveProviderContext(req, res, requestSpan);
  if (!context) return;

  const { body, provider, providerApiKey, previousResponseId, stream, upstreamModel } = context;
  setSpanAttributes(requestSpan, {
    "adapter.provider": provider.id,
    "gen_ai.request.model": typeof body.model === "string" ? body.model : "",
    "gen_ai.response.model": upstreamModel,
    "langwatch.gen_ai.streaming": stream,
  });

  await provider.handleChatCompletions({
    req,
    res,
    requestSpan,
    body,
    upstreamModel,
    stream,
    providerApiKey,
    previousResponseId,
    services: providerServices,
  });
}

async function proxyResponses(req: Request, res: Response, requestSpan: TraceSpan | null): Promise<void> {
  const bodyPreview = isRecord(req.body) ? req.body : {};
  debugLog("incoming /v1/responses", {
    contentType: req.headers["content-type"] ?? "",
    contentEncoding: req.headers["content-encoding"] ?? "",
    bodyPreview: JSON.stringify(bodyPreview).slice(0, 800),
  });

  const context = resolveProviderContext(req, res, requestSpan);
  if (!context) return;

  const { body, provider, providerApiKey, previousResponseId, stream, upstreamModel } = context;
  setSpanAttributes(requestSpan, {
    "adapter.provider": provider.id,
    "gen_ai.request.model": typeof body.model === "string" ? body.model : "",
    "gen_ai.response.model": upstreamModel,
    "langwatch.gen_ai.streaming": stream,
    "gen_ai.request.previous_response_id": previousResponseId ?? "",
  });

  await provider.handleResponses({
    req,
    res,
    requestSpan,
    body,
    upstreamModel,
    stream,
    providerApiKey,
    previousResponseId,
    services: providerServices,
  });
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    adapter: "responses-adapter",
    langwatch: {
      enabled: isLangWatchEnabled(),
      endpoint: getLangWatchEndpoint(),
    },
    providers: buildProviderHealth(providerAdapters),
    responses_store: {
      path: responsesStore.storagePath,
    },
  });
});

app.use("/v1", requireAdapterAuth);

app.post("/v1/chat/completions", async (req, res, next) => {
  try {
    await withRequestTrace(req, res, "http.request.v1.chat_completions", async (span) => {
      await proxyChatCompletions(req, res, span);
    });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/responses", async (req, res, next) => {
  try {
    await withRequestTrace(req, res, "http.request.v1.responses", async (span) => {
      await proxyResponses(req, res, span);
    });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/responses/compact", async (req, res, next) => {
  try {
    await withRequestTrace(req, res, "http.request.v1.responses_compact", async (span) => {
      await proxyResponses(req, res, span);
    });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof SyntaxError && "body" in error) {
    const req = _req as RequestWithRaw;
    sendOpenAIError(res, 400, "invalid JSON body", "invalid_request_error", {
      path: _req.path,
      method: _req.method,
      content_type: _req.headers["content-type"] ?? "",
      content_encoding: _req.headers["content-encoding"] ?? "",
      raw_body_preview: (req.rawBody ?? "").slice(0, 300),
    });
    return;
  }

  const message = error instanceof Error ? error.message : "Unexpected error";
  sendOpenAIError(res, 500, message, "server_error");
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`responses-adapter listening on http://localhost:${PORT}`);
});

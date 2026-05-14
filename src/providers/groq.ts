import {
  asNumber,
  ensureResponsesPayloadOutputText,
  extractAssistantTextFromChatCompletionPayload,
  extractResponseIdFromPayload,
  fetchUpstreamWithTrace,
  forwardSelectedHeaders,
  isRecord,
  pipeRawStream,
  pipeResponsesStreamWithCapture,
  readUpstreamPayload,
  sanitizeChatCompletionPayload,
  sendUpstreamError,
  setResponsesUsageMetrics,
  setTraceThreadId,
  traceResponsesOutput,
  stripUndefined,
  type GenericRecord,
} from "../adapter-utils.js";
import { setSpanAttributes, setSpanOutput } from "../observability.js";
import type { ProviderAdapter, ProviderContext } from "./types.js";

const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";

type GroqProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
};

export function buildGroqPayloadFromResponses(
  body: GenericRecord,
  upstreamModel: string,
  previousResponseId: string | null,
): GenericRecord {
  const payload: GenericRecord = {
    model: upstreamModel,
    input: body.input,
    instructions: typeof body.instructions === "string" ? body.instructions : undefined,
    previous_response_id: previousResponseId ?? undefined,
    store: typeof body.store === "boolean" ? body.store : undefined,
    stream: body.stream === true ? true : body.stream === false ? false : undefined,
    temperature: asNumber(body.temperature),
    top_p: asNumber(body.top_p),
    max_output_tokens: asNumber(body.max_output_tokens) ?? asNumber(body.max_tokens),
  };

  if (Array.isArray(body.tools)) {
    const functionTools = body.tools.filter((tool) => isRecord(tool) && tool.type === "function");
    if (functionTools.length > 0) {
      payload.tools = functionTools;
    }
  }

  if (typeof body.tool_choice === "string" || isRecord(body.tool_choice)) {
    payload.tool_choice = body.tool_choice;
  }

  return stripUndefined(payload);
}

async function handleGroqChatCompletions(
  baseUrl: string,
  context: ProviderContext,
): Promise<void> {
  const { body, providerApiKey, requestSpan, res, stream, upstreamModel } = context;
  const upstreamBody: GenericRecord = {
    ...body,
    model: upstreamModel,
  };

  const upstream = await fetchUpstreamWithTrace(
    "upstream.groq.chat_completions",
    "groq",
    "chat_completions",
    `${baseUrl}/chat/completions`,
    providerApiKey,
    upstreamBody,
    stream,
  );

  if (!stream) {
    forwardSelectedHeaders(upstream, res);
    const payload = await readUpstreamPayload(upstream);
    if (isRecord(payload)) {
      const normalizedPayload = sanitizeChatCompletionPayload(payload);
      setResponsesUsageMetrics(requestSpan, normalizedPayload.usage);
      const assistantText = extractAssistantTextFromChatCompletionPayload(normalizedPayload);
      setSpanOutput(requestSpan, assistantText !== "" ? assistantText : "[empty assistant output]");
      res.status(upstream.status).json(normalizedPayload);
      return;
    }

    setSpanOutput(requestSpan, typeof payload === "string" ? payload.slice(0, 4000) : "[non-json response]");
    res.status(upstream.status).send(String(payload));
    return;
  }

  if (!upstream.ok) {
    await sendUpstreamError(res, upstream, "groq", "chat_completion", requestSpan);
    return;
  }

  setSpanOutput(requestSpan, { stream: true, status_code: upstream.status });
  await pipeRawStream(upstream, res);
}

async function handleGroqResponses(baseUrl: string, context: ProviderContext): Promise<void> {
  const {
    body,
    previousResponseId,
    providerApiKey,
    requestSpan,
    res,
    services,
    stream,
    upstreamModel,
  } = context;

  const groqBody = buildGroqPayloadFromResponses(body, upstreamModel, previousResponseId);
  services.debugDumpJson("/tmp/adapter-last-groq-request.json", groqBody);

  const upstream = await fetchUpstreamWithTrace(
    "upstream.groq.responses",
    "groq",
    "responses",
    `${baseUrl}/responses`,
    providerApiKey,
    groqBody,
    stream,
  );

  if (!stream) {
    forwardSelectedHeaders(upstream, res);
    const payload = await readUpstreamPayload(upstream);
    if (isRecord(payload)) {
      const normalizedPayload = ensureResponsesPayloadOutputText(payload);
      setResponsesUsageMetrics(requestSpan, normalizedPayload.usage);
      const responseId = extractResponseIdFromPayload(normalizedPayload);
      const threadId = previousResponseId ?? responseId;
      setTraceThreadId(requestSpan, threadId);
      traceResponsesOutput(requestSpan, normalizedPayload, upstream.status, false);
      res.status(upstream.status).json(normalizedPayload);
      return;
    }

    setTraceThreadId(requestSpan, previousResponseId);
    setSpanOutput(requestSpan, typeof payload === "string" ? payload.slice(0, 4000) : "[non-json response]");
    res.status(upstream.status).send(String(payload));
    return;
  }

  if (!upstream.ok) {
    await sendUpstreamError(res, upstream, "groq", "responses", requestSpan);
    return;
  }

  const capture = await pipeResponsesStreamWithCapture(upstream, res);
  if (capture) {
    setResponsesUsageMetrics(requestSpan, capture.usage);
    const threadId = previousResponseId ?? capture.responseId;
    setTraceThreadId(requestSpan, threadId);
    traceResponsesOutput(
      requestSpan,
      capture.completedResponse ?? {
        id: capture.responseId,
        output_text: capture.assistantText,
      },
      upstream.status,
      true,
    );
  } else {
    setTraceThreadId(requestSpan, previousResponseId);
    setSpanOutput(requestSpan, "[empty assistant output]");
  }
}

export function createGroqProvider(options: GroqProviderOptions = {}): ProviderAdapter {
  const apiKey = options.apiKey ?? process.env.GROQ_API_KEY;
  const baseUrl = (options.baseUrl ?? process.env.GROQ_BASE_URL ?? DEFAULT_GROQ_BASE_URL).replace(/\/$/, "");

  return {
    id: "groq",
    modelPrefixes: ["groq"],
    getApiKey: () => apiKey,
    handleChatCompletions: async (context) => {
      setSpanAttributes(context.requestSpan, { "adapter.provider": "groq" });
      await handleGroqChatCompletions(baseUrl, context);
    },
    handleResponses: async (context) => {
      setSpanAttributes(context.requestSpan, { "adapter.provider": "groq" });
      await handleGroqResponses(baseUrl, context);
    },
  };
}

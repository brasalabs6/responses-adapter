import crypto from "node:crypto";
import fs from "node:fs";

import dotenv from "dotenv";
import express, { NextFunction, Request, Response } from "express";
import {
  TraceSpan,
  getLangWatchEndpoint,
  isLangWatchEnabled,
  recordSpanException,
  setSpanAttributes,
  setSpanInput,
  setSpanMetrics,
  setSpanOutput,
  setSpanType,
  withSpan,
} from "./observability.js";
import { ReplayMessage, ResponsesStore } from "./responses-store.js";

dotenv.config();

type Provider = "groq" | "minimax";
type Role = "system" | "user" | "assistant" | "tool";

type GenericRecord = Record<string, unknown>;

const PORT = Number.parseInt(process.env.PORT ?? "19090", 10);
const ADAPTER_API_KEY = process.env.ADAPTER_API_KEY;
const ADAPTER_DEBUG = process.env.ADAPTER_DEBUG === "1";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const STRIP_THINK_TAGS = process.env.STRIP_THINK_TAGS !== "false";

const GROQ_BASE_URL = (process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/$/, "");
const MINIMAX_BASE_URL = (process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1").replace(/\/$/, "");

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

function summarizeForTrace(value: unknown): unknown {
  if (typeof value === "string") {
    return value.slice(0, 1200);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20);
  }

  if (!isRecord(value)) {
    return value;
  }

  const summary = { ...value } as GenericRecord;
  for (const key of ["input", "instructions", "messages", "tools", "output"]) {
    if (key in summary) {
      summary[key] = summarizeForTrace(summary[key]);
    }
  }
  return summary;
}

async function withRequestTrace(
  req: Request,
  res: Response,
  spanName: string,
  handler: (span: TraceSpan | null) => Promise<void>,
): Promise<void> {
  const startedAt = Date.now();
  const body = isRecord(req.body) ? req.body : {};

  await withSpan(spanName, async (span) => {
    setSpanType(span, "workflow");
    setSpanAttributes(span, {
      "http.method": req.method,
      "http.route": req.path,
      "http.target": req.originalUrl,
      "langwatch.gen_ai.streaming": body.stream === true,
    });
    setSpanInput(span, summarizeForTrace(body));

    try {
      await handler(span);
    } catch (error) {
      recordSpanException(span, error);
      throw error;
    } finally {
      setSpanAttributes(span, {
        "http.status_code": res.statusCode,
        "adapter.request.duration_ms": Date.now() - startedAt,
      });
    }
  });
}

async function fetchUpstreamWithTrace(
  spanName: string,
  provider: Provider,
  requestType: string,
  url: string,
  providerApiKey: string,
  body: GenericRecord,
  stream: boolean,
): Promise<globalThis.Response> {
  return await withSpan(spanName, async (span) => {
    setSpanType(span, "llm");
    setSpanAttributes(span, {
      "http.method": "POST",
      "http.url": url,
      "adapter.provider": provider,
      "adapter.request_type": requestType,
      "langwatch.gen_ai.streaming": stream,
    });
    setSpanInput(span, summarizeForTrace(body));

    const startedAt = Date.now();
    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerApiKey}`,
          "Content-Type": "application/json",
          Accept: stream ? "text/event-stream" : "application/json",
        },
        body: JSON.stringify(body),
      });

      setSpanAttributes(span, {
        "http.status_code": upstream.status,
        "adapter.upstream.ok": upstream.ok,
        "adapter.upstream.duration_ms": Date.now() - startedAt,
      });
      setSpanOutput(span, {
        status_code: upstream.status,
        ok: upstream.ok,
      });
      return upstream;
    } catch (error) {
      setSpanAttributes(span, {
        "adapter.upstream.duration_ms": Date.now() - startedAt,
        "adapter.upstream.network_error": true,
      });
      recordSpanException(span, error);
      throw error;
    }
  });
}

function sendOpenAIError(
  res: Response,
  status: number,
  message: string,
  type = "invalid_request_error",
  extra?: GenericRecord,
): void {
  res.status(status).json({
    error: {
      message,
      type,
    },
    ...(extra ? { extra_fields: extra } : {}),
  });
}

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

function isRecord(value: unknown): value is GenericRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (isRecord(entry)) {
          if (typeof entry.text === "string") return entry.text;
          if (typeof entry.content === "string") return entry.content;
          if (Array.isArray(entry.content)) return extractText(entry.content);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return extractText(value.content);
  }

  return "";
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stripUndefined<T extends GenericRecord>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T;
}

function parseModel(model: unknown): { provider: Provider; upstreamModel: string } {
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error("model is required and must be a string in provider/model format");
  }

  const [prefix, ...rest] = model.split("/");
  if (!prefix || rest.length === 0) {
    throw new Error("model should be in provider/model format");
  }

  const provider = prefix.toLowerCase();
  if (provider !== "groq" && provider !== "minimax") {
    throw new Error("unsupported provider prefix. Use groq/<model> or minimax/<model>");
  }

  const upstreamModel = rest.join("/").trim();
  if (!upstreamModel) {
    throw new Error("model should be in provider/model format");
  }

  return { provider, upstreamModel };
}

function getProviderApiKey(provider: Provider): string | undefined {
  return provider === "groq" ? GROQ_API_KEY : MINIMAX_API_KEY;
}

function isStreamRequested(body: GenericRecord): boolean {
  return body.stream === true;
}

function toRole(value: unknown): Role {
  if (value === "system" || value === "assistant" || value === "user" || value === "tool") return value;
  return "user";
}

function stringifyJsonValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "";
  }
}

function normalizeResponsesInputToMessages(
  input: unknown,
  options: {
    fallbackBlank?: boolean;
  } = {},
): GenericRecord[] {
  const messages: GenericRecord[] = [];

  if (typeof input === "string") {
    if (input.trim() !== "") {
      messages.push({ role: "user", content: input });
    }
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        if (item.trim() !== "") {
          messages.push({ role: "user", content: item });
        }
        continue;
      }

      if (!isRecord(item)) continue;

      if (item.type === "function_call") {
        if (typeof item.name !== "string" || item.name.trim() === "") {
          continue;
        }

        const callId =
          typeof item.call_id === "string" && item.call_id.trim() !== ""
            ? item.call_id
            : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: {
                name: item.name,
                arguments: stringifyJsonValue(item.arguments),
              },
            },
          ],
        });
        continue;
      }

      if (item.type === "function_call_output") {
        const content = extractText(item.output);
        if (content.trim() === "") continue;

        messages.push({
          role: "tool",
          content,
          tool_call_id:
            typeof item.call_id === "string" && item.call_id.trim() !== "" ? item.call_id : undefined,
        });
        continue;
      }

      if ("role" in item) {
        const role = toRole(item.role);
        const content = extractText(item.content);
        if (content.trim() !== "") {
          messages.push({ role, content });
        }
        continue;
      }

      const content = extractText(item);
      if (content.trim() !== "") {
        messages.push({ role: "user", content });
      }
    }
  } else if (isRecord(input)) {
    const content = extractText(input);
    if (content.trim() !== "") {
      messages.push({ role: "user", content });
    }
  }

  if (messages.length === 0 && options.fallbackBlank !== false) {
    messages.push({ role: "user", content: " " });
  }

  return messages;
}

function buildInstructionMessage(body: GenericRecord): GenericRecord | null {
  if (typeof body.instructions === "string" && body.instructions.trim() !== "") {
    return {
      role: "system",
      content: body.instructions.trim(),
    };
  }
  return null;
}

function buildMiniMaxPayloadFromResponses(
  body: GenericRecord,
  upstreamModel: string,
  stream: boolean,
  messagesOverride?: GenericRecord[],
): GenericRecord {
  const minimaxTools = normalizeMiniMaxTools(body.tools);
  const minimaxToolChoice = normalizeMiniMaxToolChoice(body.tool_choice);
  const instructionMessage = buildInstructionMessage(body);
  const messages =
    messagesOverride ??
    [
      ...(instructionMessage ? [instructionMessage] : []),
      ...normalizeResponsesInputToMessages(body.input, { fallbackBlank: true }),
    ];

  const payload: GenericRecord = {
    model: upstreamModel,
    messages,
    stream,
    temperature: asNumber(body.temperature),
    top_p: asNumber(body.top_p),
    max_tokens: asNumber(body.max_output_tokens) ?? asNumber(body.max_tokens),
    reasoning_split: typeof body.reasoning_split === "boolean" ? body.reasoning_split : true,
    tools: minimaxTools,
    tool_choice: minimaxToolChoice,
  };

  return stripUndefined(payload);
}

function normalizeMiniMaxTools(toolsValue: unknown): GenericRecord[] | undefined {
  if (!Array.isArray(toolsValue)) return undefined;

  const tools: GenericRecord[] = [];
  for (const tool of toolsValue) {
    if (!isRecord(tool) || tool.type !== "function") continue;
    if (typeof tool.name !== "string" || tool.name.trim() === "") continue;

    const fn: GenericRecord = {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      parameters: isRecord(tool.parameters) ? tool.parameters : undefined,
    };

    tools.push({
      type: "function",
      function: stripUndefined(fn),
    });
  }

  return tools.length > 0 ? tools : undefined;
}

function normalizeMiniMaxToolChoice(toolChoiceValue: unknown): unknown {
  if (typeof toolChoiceValue === "string") {
    return toolChoiceValue;
  }

  if (!isRecord(toolChoiceValue)) {
    return undefined;
  }

  if (isRecord(toolChoiceValue.function)) {
    return toolChoiceValue;
  }

  if (toolChoiceValue.type === "function" && typeof toolChoiceValue.name === "string") {
    return {
      type: "function",
      function: {
        name: toolChoiceValue.name,
      },
    };
  }

  return undefined;
}

function buildGroqPayloadFromResponses(body: GenericRecord, upstreamModel: string): GenericRecord {
  const payload: GenericRecord = {
    model: upstreamModel,
    input: body.input,
    instructions: typeof body.instructions === "string" ? body.instructions : undefined,
    previous_response_id: getPreviousResponseId(body) ?? undefined,
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

  // Groq rejects unsupported top-level fields from Codex requests.
  return stripUndefined(payload);
}

function getPreviousResponseId(body: GenericRecord): string | null {
  if (typeof body.previous_response_id !== "string") return null;
  const previousResponseId = body.previous_response_id.trim();
  return previousResponseId === "" ? null : previousResponseId;
}

function replayMessageToGeneric(message: ReplayMessage): GenericRecord {
  const normalized: GenericRecord = {
    role: message.role,
  };

  if (typeof message.content === "string") {
    normalized.content = message.content;
  }

  if (typeof message.tool_call_id === "string" && message.tool_call_id.trim() !== "") {
    normalized.tool_call_id = message.tool_call_id;
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    normalized.tool_calls = message.tool_calls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
    }));
  }

  return normalized;
}

function toReplayMessages(messages: GenericRecord[]): ReplayMessage[] {
  const replayMessages: ReplayMessage[] = [];

  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant" && message.role !== "tool") {
      continue;
    }

    const replayMessage: ReplayMessage = {
      role: message.role,
    };

    if (typeof message.content === "string") {
      replayMessage.content = message.content;
    }

    if (typeof message.tool_call_id === "string" && message.tool_call_id.trim() !== "") {
      replayMessage.tool_call_id = message.tool_call_id;
    }

    if (Array.isArray(message.tool_calls)) {
      const toolCalls = message.tool_calls
        .map((rawToolCall) => {
          if (!isRecord(rawToolCall)) return null;
          if (rawToolCall.type !== "function") return null;
          if (typeof rawToolCall.id !== "string" || rawToolCall.id.trim() === "") return null;
          if (!isRecord(rawToolCall.function)) return null;
          if (typeof rawToolCall.function.name !== "string" || rawToolCall.function.name.trim() === "") return null;

          return {
            id: rawToolCall.id,
            type: "function" as const,
            function: {
              name: rawToolCall.function.name,
              arguments: typeof rawToolCall.function.arguments === "string" ? rawToolCall.function.arguments : "",
            },
          };
        })
        .filter((value): value is NonNullable<ReplayMessage["tool_calls"]>[number] => value !== null);

      if (toolCalls.length > 0) {
        replayMessage.tool_calls = toolCalls;
      }
    }

    replayMessages.push(replayMessage);
  }

  return replayMessages;
}

function buildReplayMessagesFromStoredChain(previousResponseId: string): {
  ok: true;
  messages: GenericRecord[];
} | {
  ok: false;
  reason: "missing" | "cycle" | "depth_limit";
  response_id: string;
} {
  const resolved = responsesStore.resolveChain(previousResponseId);
  if (!resolved.ok) {
    return resolved;
  }

  const messages: GenericRecord[] = [];
  for (const record of resolved.chain) {
    for (const message of record.request_input_messages) {
      messages.push(replayMessageToGeneric(message));
    }
    for (const message of record.assistant_messages) {
      messages.push(replayMessageToGeneric(message));
    }
  }

  return {
    ok: true,
    messages,
  };
}

function extractAssistantTextFromMessageItem(item: GenericRecord): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map((contentPart) => {
      if (!isRecord(contentPart)) return "";
      if (contentPart.type === "output_text" && typeof contentPart.text === "string") {
        return contentPart.text;
      }
      if (typeof contentPart.text === "string") {
        return contentPart.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

function sanitizeAssistantText(text: string): string {
  if (!STRIP_THINK_TAGS) return text;
  const withoutClosedThinkBlocks = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "");
  const withoutDanglingThinkStart = withoutClosedThinkBlocks.replace(/<think>[\s\S]*$/gi, "");
  const withoutThinkMarkers = withoutDanglingThinkStart.replace(/<\/?think>/gi, "");
  const sanitized = withoutThinkMarkers.replace(/\n{3,}/g, "\n\n").trim();
  if (sanitized !== "") return sanitized;
  return text.trim();
}

function sanitizeResponsesOutput(output: unknown): unknown {
  if (!Array.isArray(output)) return output;
  return output.map((item) => {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
      return item;
    }

    const sanitizedContent = item.content.map((contentPart) => {
      if (!isRecord(contentPart)) return contentPart;
      if (typeof contentPart.text !== "string") return contentPart;
      return {
        ...contentPart,
        text: sanitizeAssistantText(contentPart.text),
      };
    });

    return {
      ...item,
      content: sanitizedContent,
    };
  });
}

function extractAssistantTextFromResponseOutput(output: unknown): string {
  if (!Array.isArray(output)) return "";
  let combinedText = "";

  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type !== "message") continue;
    if (typeof item.role === "string" && item.role !== "assistant") continue;

    const messageText = extractAssistantTextFromMessageItem(item);
    if (messageText !== "") {
      combinedText += sanitizeAssistantText(messageText);
    }
  }

  return combinedText;
}

function extractAssistantTextFromResponsesPayload(payload: unknown): string {
  if (!isRecord(payload)) return "";
  if (typeof payload.output_text === "string" && payload.output_text !== "") {
    return sanitizeAssistantText(payload.output_text);
  }

  const outputTextFromOutput = extractAssistantTextFromResponseOutput(payload.output);
  if (outputTextFromOutput !== "") {
    return outputTextFromOutput;
  }

  if (isRecord(payload.response)) {
    return extractAssistantTextFromResponsesPayload(payload.response);
  }

  return "";
}

function ensureResponsesPayloadOutputText(payload: GenericRecord): GenericRecord {
  const assistantText = extractAssistantTextFromResponsesPayload(payload);
  if (assistantText === "") return payload;
  if (typeof payload.output_text === "string" && payload.output_text.trim() !== "") {
    return payload;
  }
  return {
    ...payload,
    output_text: assistantText,
  };
}

function extractAssistantTextFromChatCompletionPayload(payload: GenericRecord): string {
  if (!Array.isArray(payload.choices)) return "";

  for (const choice of payload.choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    const text = sanitizeAssistantText(extractText(choice.message.content));
    if (text !== "") return text;
  }

  return "";
}

function sanitizeChatCompletionPayload(payload: GenericRecord): GenericRecord {
  if (!Array.isArray(payload.choices)) return payload;

  const choices = payload.choices.map((choice) => {
    if (!isRecord(choice) || !isRecord(choice.message)) return choice;
    const sanitizedContent = sanitizeAssistantText(extractText(choice.message.content));
    return {
      ...choice,
      message: {
        ...choice.message,
        content: sanitizedContent,
      },
    };
  });

  return {
    ...payload,
    choices,
  };
}

function extractResponseIdFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.id === "string" && payload.id.trim() !== "") {
    return payload.id;
  }
  if (isRecord(payload.response) && typeof payload.response.id === "string" && payload.response.id.trim() !== "") {
    return payload.response.id;
  }
  return null;
}

function setResponsesUsageMetrics(span: TraceSpan | null, usageValue: unknown): void {
  if (!isRecord(usageValue)) return;
  setSpanMetrics(span, {
    promptTokens:
      typeof usageValue.input_tokens === "number"
        ? usageValue.input_tokens
        : typeof usageValue.prompt_tokens === "number"
          ? usageValue.prompt_tokens
          : undefined,
    completionTokens:
      typeof usageValue.output_tokens === "number"
        ? usageValue.output_tokens
        : typeof usageValue.completion_tokens === "number"
          ? usageValue.completion_tokens
          : undefined,
  });
}

function traceResponsesOutput(span: TraceSpan | null, payload: unknown, statusCode: number, stream: boolean): void {
  const responseId = extractResponseIdFromPayload(payload);
  const assistantText = extractAssistantTextFromResponsesPayload(payload).slice(0, 12000);
  setSpanAttributes(span, {
    "gen_ai.response.id": responseId ?? "",
    "http.status_code": statusCode,
    "langwatch.gen_ai.streaming": stream,
  });
  setSpanOutput(span, assistantText === "" ? "[empty assistant output]" : assistantText);
}

function setTraceThreadId(span: TraceSpan | null, threadId: string | null): void {
  if (!threadId) return;
  setSpanAttributes(span, {
    "langwatch.thread.id": threadId,
  });
}

function buildAssistantReplayMessagesFromOutput(output: unknown): ReplayMessage[] {
  if (!Array.isArray(output)) return [];
  const replayMessages: ReplayMessage[] = [];

  for (const item of output) {
    if (!isRecord(item)) continue;

    if (item.type === "message") {
      if (typeof item.role === "string" && item.role !== "assistant") {
        continue;
      }
      const text = sanitizeAssistantText(extractAssistantTextFromMessageItem(item));
      replayMessages.push({
        role: "assistant",
        content: text,
      });
      continue;
    }

    if (item.type === "function_call") {
      if (typeof item.name !== "string" || item.name.trim() === "") continue;
      const callId =
        typeof item.call_id === "string" && item.call_id.trim() !== ""
          ? item.call_id
          : typeof item.id === "string" && item.id.trim() !== ""
            ? item.id
            : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

      replayMessages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: {
              name: item.name,
              arguments: typeof item.arguments === "string" ? item.arguments : stringifyJsonValue(item.arguments),
            },
          },
        ],
      });
    }
  }

  return replayMessages;
}

function mapChainErrorToMessage(reason: "missing" | "cycle" | "depth_limit", responseId: string): string {
  if (reason === "missing") {
    return `previous_response_id not found: ${responseId}`;
  }
  if (reason === "cycle") {
    return `previous_response_id chain contains a cycle at: ${responseId}`;
  }
  return `previous_response_id chain exceeded max depth near: ${responseId}`;
}

function createAdapterResponseId(): string {
  return `resp_${crypto.randomUUID().replace(/-/g, "")}`;
}

function buildMiniMaxRequestSnapshot(body: GenericRecord, previousResponseId: string | null): GenericRecord {
  return stripUndefined({
    previous_response_id: previousResponseId ?? undefined,
    input: body.input,
    instructions: typeof body.instructions === "string" ? body.instructions : undefined,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    tool_choice:
      typeof body.tool_choice === "string" || isRecord(body.tool_choice) ? body.tool_choice : undefined,
    temperature: asNumber(body.temperature),
    top_p: asNumber(body.top_p),
    max_output_tokens: asNumber(body.max_output_tokens) ?? asNumber(body.max_tokens),
    stream: body.stream === true,
    store: typeof body.store === "boolean" ? body.store : undefined,
  });
}

function persistMiniMaxResponseRecord(input: {
  responseId: string;
  previousResponseId: string | null;
  upstreamModel: string;
  requestBody: GenericRecord;
  requestInputMessages: GenericRecord[];
  normalizedResponse: GenericRecord;
  rawUpstreamPayload?: unknown;
}): void {
  try {
    responsesStore.append({
      id: input.responseId,
      provider: "minimax",
      model: input.upstreamModel,
      created_at:
        typeof input.normalizedResponse.created_at === "number"
          ? input.normalizedResponse.created_at
          : Math.floor(Date.now() / 1000),
      previous_response_id: input.previousResponseId,
      status:
        typeof input.normalizedResponse.status === "string" ? input.normalizedResponse.status : "completed",
      request_snapshot: buildMiniMaxRequestSnapshot(input.requestBody, input.previousResponseId),
      request_input_messages: toReplayMessages(input.requestInputMessages),
      assistant_messages: buildAssistantReplayMessagesFromOutput(input.normalizedResponse.output),
      output: sanitizeResponsesOutput(input.normalizedResponse.output),
      assistant_final_text: extractAssistantTextFromResponsesPayload(input.normalizedResponse),
      usage: isRecord(input.normalizedResponse.usage) ? input.normalizedResponse.usage : undefined,
      raw_upstream_summary: summarizeForTrace(input.rawUpstreamPayload),
    });
  } catch (error) {
    debugLog("failed to persist minimax response record", {
      responseId: input.responseId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function extractMiniMaxFunctionCallItems(choice: unknown): GenericRecord[] {
  if (!isRecord(choice) || !isRecord(choice.message) || !Array.isArray(choice.message.tool_calls)) {
    return [];
  }

  const items: GenericRecord[] = [];
  for (const rawCall of choice.message.tool_calls) {
    if (!isRecord(rawCall) || !isRecord(rawCall.function)) continue;
    if (typeof rawCall.function.name !== "string" || rawCall.function.name.trim() === "") continue;

    const callId =
      typeof rawCall.id === "string" && rawCall.id.trim() !== ""
        ? rawCall.id
        : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

    items.push({
      type: "function_call",
      id: callId,
      status: "completed",
      call_id: callId,
      name: rawCall.function.name,
      arguments: typeof rawCall.function.arguments === "string" ? rawCall.function.arguments : "",
    });
  }

  return items;
}

function convertMiniMaxChatToResponses(
  chatCompletion: GenericRecord,
  upstreamModel: string,
  options: {
    responseId: string;
    previousResponseId: string | null;
  },
): GenericRecord {
  const choice0 = Array.isArray(chatCompletion.choices) ? chatCompletion.choices[0] : undefined;
  const functionCallItems = extractMiniMaxFunctionCallItems(choice0);
  const assistantContentRaw = isRecord(choice0) && isRecord(choice0.message) ? extractText(choice0.message.content) : "";
  const assistantContent = sanitizeAssistantText(assistantContentRaw);

  const usage = isRecord(chatCompletion.usage) ? chatCompletion.usage : {};

  const responseId = options.responseId;
  const output =
    functionCallItems.length > 0
      ? functionCallItems
      : [
          {
            id: `msg_${crypto.randomUUID()}`,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: assistantContent,
                annotations: [],
              },
            ],
          },
        ];

  return {
    id: responseId,
    object: "response",
    status: "completed",
    created_at:
      typeof chatCompletion.created === "number" ? chatCompletion.created : Math.floor(Date.now() / 1000),
    model: typeof chatCompletion.model === "string" ? chatCompletion.model : upstreamModel,
    previous_response_id: options.previousResponseId,
    output: sanitizeResponsesOutput(output),
    output_text: functionCallItems.length > 0 ? "" : assistantContent,
    error: null,
    incomplete_details: null,
    usage: {
      input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
      total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : 0,
    },
  };
}

function forwardSelectedHeaders(from: globalThis.Response, to: Response): void {
  const allowed = [
    "x-request-id",
    "x-groq-region",
    "x-ratelimit-limit-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "trace-id",
    "minimax-request-id",
    "x-mm-request-id",
    "x-session-id",
    "alb_receive_time",
    "alb_request_id",
  ];

  for (const headerName of allowed) {
    const value = from.headers.get(headerName);
    if (value) {
      to.setHeader(headerName, value);
    }
  }
}

async function readUpstreamPayload(upstream: globalThis.Response): Promise<unknown> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await upstream.json();
    } catch {
      return { error: { message: "Invalid JSON response from upstream provider" } };
    }
  }

  return await upstream.text();
}

async function sendUpstreamError(
  res: Response,
  upstream: globalThis.Response,
  provider: Provider,
  requestType: string,
  span: TraceSpan | null = null,
): Promise<void> {
  forwardSelectedHeaders(upstream, res);
  const payload = await readUpstreamPayload(upstream);
  debugLog("upstream-error", {
    provider,
    requestType,
    status: upstream.status,
    payload,
  });
  setSpanAttributes(span, {
    "http.status_code": upstream.status,
    "adapter.provider": provider,
    "adapter.request_type": requestType,
    "adapter.upstream.ok": false,
  });
  setSpanOutput(span, summarizeForTrace(payload));

  if (isRecord(payload)) {
    res.status(upstream.status).json({
      ...payload,
      ...(payload.extra_fields ? {} : { extra_fields: { provider, request_type: requestType } }),
    });
    return;
  }

  sendOpenAIError(res, upstream.status, String(payload), "upstream_error", {
    provider,
    request_type: requestType,
  });
}

async function pipeRawStream(upstream: globalThis.Response, res: Response): Promise<void> {
  if (!upstream.body) {
    sendOpenAIError(res, 502, "Upstream stream is empty", "upstream_error");
    return;
  }

  res.status(upstream.status);
  forwardSelectedHeaders(upstream, res);
  res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

type ResponsesStreamCapture = {
  responseId: string | null;
  assistantText: string;
  usage: GenericRecord | null;
  completedResponse: GenericRecord | null;
};

function consumeResponsesSseData(capture: ResponsesStreamCapture, dataLine: string): void {
  if (dataLine === "[DONE]") return;

  let payload: unknown;
  try {
    payload = JSON.parse(dataLine);
  } catch {
    return;
  }

  if (!isRecord(payload)) return;

  if (typeof payload.response_id === "string" && payload.response_id.trim() !== "") {
    capture.responseId = payload.response_id;
  }

  if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
    capture.assistantText += payload.delta;
    return;
  }

  if (payload.type === "response.output_text.done" && typeof payload.text === "string") {
    capture.assistantText = payload.text;
    return;
  }

  if (payload.type === "response.completed" && isRecord(payload.response)) {
    capture.completedResponse = payload.response;
    if (typeof payload.response.id === "string" && payload.response.id.trim() !== "") {
      capture.responseId = payload.response.id;
    }
    if (isRecord(payload.response.usage)) {
      capture.usage = payload.response.usage;
    }
    if (capture.assistantText === "") {
      capture.assistantText = extractAssistantTextFromResponsesPayload(payload.response);
    }
  }
}

async function pipeResponsesStreamWithCapture(
  upstream: globalThis.Response,
  res: Response,
): Promise<ResponsesStreamCapture | null> {
  if (!upstream.body) {
    sendOpenAIError(res, 502, "Upstream stream is empty", "upstream_error");
    return null;
  }

  const capture: ResponsesStreamCapture = {
    responseId: null,
    assistantText: "",
    usage: null,
    completedResponse: null,
  };

  res.status(upstream.status);
  forwardSelectedHeaders(upstream, res);
  res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let chunkBuffer = "";
  let eventLines: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const rawChunk = Buffer.from(value);
      res.write(rawChunk);

      chunkBuffer += decoder.decode(value, { stream: true });
      const lines = chunkBuffer.split(/\r?\n/);
      chunkBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "") {
          if (eventLines.length > 0) {
            consumeResponsesSseData(capture, eventLines.join("\n"));
            eventLines = [];
          }
          continue;
        }

        if (line.startsWith("data:")) {
          eventLines.push(line.slice(5).trimStart());
        }
      }
    }

    chunkBuffer += decoder.decode();
    const remainingLines = chunkBuffer.split(/\r?\n/);
    for (const line of remainingLines) {
      if (line === "") {
        if (eventLines.length > 0) {
          consumeResponsesSseData(capture, eventLines.join("\n"));
          eventLines = [];
        }
        continue;
      }
      if (line.startsWith("data:")) {
        eventLines.push(line.slice(5).trimStart());
      }
    }
    if (eventLines.length > 0) {
      consumeResponsesSseData(capture, eventLines.join("\n"));
    }
  } finally {
    res.end();
  }

  if (capture.assistantText === "" && capture.completedResponse) {
    capture.assistantText = extractAssistantTextFromResponsesPayload(capture.completedResponse);
  }
  capture.assistantText = sanitizeAssistantText(capture.assistantText);

  return capture;
}

async function* parseSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();

  let chunkBuffer = "";
  let eventLines: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunkBuffer += decoder.decode(value, { stream: true });
    const lines = chunkBuffer.split(/\r?\n/);
    chunkBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line === "") {
        if (eventLines.length > 0) {
          yield eventLines.join("\n");
          eventLines = [];
        }
        continue;
      }

      if (line.startsWith("data:")) {
        eventLines.push(line.slice(5).trimStart());
      }
    }
  }

  if (eventLines.length > 0) {
    yield eventLines.join("\n");
  }
}

function writeSse(res: Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function streamMiniMaxAsResponses(
  upstream: globalThis.Response,
  res: Response,
  upstreamModel: string,
  options: {
    responseId: string;
    previousResponseId: string | null;
  },
): Promise<GenericRecord | null> {
  if (!upstream.body) {
    sendOpenAIError(res, 502, "Upstream stream is empty", "upstream_error");
    return null;
  }

  type ToolCallState = {
    outputIndex: number;
    id: string;
    callId: string;
    name: string;
    arguments: string;
    added: boolean;
  };

  const responseId = options.responseId;
  const toolCalls = new Map<number, ToolCallState>();
  let outputText = "";
  let usage: GenericRecord = {};
  let sequenceNumber = 0;

  res.status(200);
  forwardSelectedHeaders(upstream, res);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  writeSse(res, {
    type: "response.created",
    sequence_number: sequenceNumber++,
    response: {
      id: responseId,
      object: "response",
      previous_response_id: options.previousResponseId,
      status: "in_progress",
      model: upstreamModel,
      output: [],
    },
  });

  writeSse(res, {
    type: "response.in_progress",
    sequence_number: sequenceNumber++,
    response: {
      id: responseId,
      object: "response",
      previous_response_id: options.previousResponseId,
      status: "in_progress",
      model: upstreamModel,
      output: [],
    },
  });

  for await (const dataLine of parseSseData(upstream.body)) {
    if (dataLine === "[DONE]") {
      break;
    }

    let chunk: unknown;
    try {
      chunk = JSON.parse(dataLine);
    } catch {
      continue;
    }

    if (!isRecord(chunk)) continue;

    const choice0 = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (isRecord(choice0) && isRecord(choice0.delta)) {
      const delta = extractText(choice0.delta.content);
      if (delta !== "") {
        outputText += delta;
      }

      if (Array.isArray(choice0.delta.tool_calls)) {
        for (const rawCall of choice0.delta.tool_calls) {
          if (!isRecord(rawCall)) continue;

          const parsedIndex = asNumber(rawCall.index);
          const outputIndex = parsedIndex !== undefined ? parsedIndex : toolCalls.size;

          let callState = toolCalls.get(outputIndex);
          if (!callState) {
            const generatedCallId = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
            const initialCallId =
              typeof rawCall.id === "string" && rawCall.id.trim() !== "" ? rawCall.id : generatedCallId;
            callState = {
              outputIndex,
              id: initialCallId,
              callId: initialCallId,
              name: `tool_${outputIndex}`,
              arguments: "",
              added: false,
            };
            toolCalls.set(outputIndex, callState);
          }

          if (typeof rawCall.id === "string" && rawCall.id.trim() !== "") {
            callState.id = rawCall.id;
            callState.callId = rawCall.id;
          }

          if (isRecord(rawCall.function)) {
            if (typeof rawCall.function.name === "string" && rawCall.function.name.trim() !== "") {
              callState.name = rawCall.function.name;
            }

            if (typeof rawCall.function.arguments === "string") {
              const argDelta = rawCall.function.arguments;
              if (!callState.added) {
                writeSse(res, {
                  type: "response.output_item.added",
                  sequence_number: sequenceNumber++,
                  output_index: callState.outputIndex,
                  item: {
                    type: "function_call",
                    id: callState.id,
                    call_id: callState.callId,
                    name: callState.name,
                    arguments: "",
                  },
                });
                callState.added = true;
              }

              if (argDelta !== "") {
                callState.arguments += argDelta;
                writeSse(res, {
                  type: "response.function_call_arguments.delta",
                  sequence_number: sequenceNumber++,
                  item_id: callState.id,
                  output_index: callState.outputIndex,
                  delta: argDelta,
                });
              }
            }
          }

          if (!callState.added) {
            writeSse(res, {
              type: "response.output_item.added",
              sequence_number: sequenceNumber++,
              output_index: callState.outputIndex,
              item: {
                type: "function_call",
                id: callState.id,
                call_id: callState.callId,
                name: callState.name,
                arguments: "",
              },
            });
            callState.added = true;
          }
        }
      }
    }

    if (isRecord(chunk.usage)) {
      usage = chunk.usage;
    }
  }

  let completedOutput: GenericRecord[];
  if (toolCalls.size > 0) {
    const sortedCalls = [...toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex);
    for (const callState of sortedCalls) {
      if (!callState.added) {
        writeSse(res, {
          type: "response.output_item.added",
          sequence_number: sequenceNumber++,
          output_index: callState.outputIndex,
          item: {
            type: "function_call",
            id: callState.id,
            call_id: callState.callId,
            name: callState.name,
            arguments: "",
          },
        });
      }

      writeSse(res, {
        type: "response.function_call_arguments.done",
        sequence_number: sequenceNumber++,
        item_id: callState.id,
        output_index: callState.outputIndex,
        arguments: callState.arguments,
      });

      writeSse(res, {
        type: "response.output_item.done",
        sequence_number: sequenceNumber++,
        output_index: callState.outputIndex,
        item: {
          type: "function_call",
          id: callState.id,
          status: "completed",
          call_id: callState.callId,
          name: callState.name,
          arguments: callState.arguments,
        },
      });
    }

    completedOutput = sortedCalls.map((callState) => ({
      type: "function_call",
      id: callState.id,
      status: "completed",
      call_id: callState.callId,
      name: callState.name,
      arguments: callState.arguments,
    }));
  } else {
    const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    writeSse(res, {
      type: "response.output_item.added",
      sequence_number: sequenceNumber++,
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        content: [],
      },
    });

    writeSse(res, {
      type: "response.content_part.added",
      sequence_number: sequenceNumber++,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: {
        type: "output_text",
        text: "",
        annotations: [],
      },
    });

    const sanitizedOutputText = sanitizeAssistantText(outputText);

    if (sanitizedOutputText !== "") {
      writeSse(res, {
        type: "response.output_text.delta",
        sequence_number: sequenceNumber++,
        response_id: responseId,
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        delta: sanitizedOutputText,
      });
    }

    writeSse(res, {
      type: "response.output_text.done",
      sequence_number: sequenceNumber++,
      response_id: responseId,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text: sanitizedOutputText,
    });

    writeSse(res, {
      type: "response.content_part.done",
      sequence_number: sequenceNumber++,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: {
        type: "output_text",
        text: sanitizedOutputText,
        annotations: [],
      },
    });

    writeSse(res, {
      type: "response.output_item.done",
      sequence_number: sequenceNumber++,
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: sanitizedOutputText,
            annotations: [],
          },
        ],
      },
    });

    completedOutput = [
      {
        id: messageId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: sanitizedOutputText,
            annotations: [],
          },
        ],
      },
    ];
    outputText = sanitizedOutputText;
  }

  const completedResponse = {
    id: responseId,
    object: "response",
    previous_response_id: options.previousResponseId,
    status: "completed",
    model: upstreamModel,
    output: sanitizeResponsesOutput(completedOutput),
    output_text: outputText,
    usage: {
      input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
      total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : 0,
    },
  };

  writeSse(res, {
    type: "response.completed",
    sequence_number: sequenceNumber++,
    response: completedResponse,
  });

  res.write("data: [DONE]\n\n");
  res.end();
  return completedResponse;
}

async function proxyChatCompletions(req: Request, res: Response, requestSpan: TraceSpan | null): Promise<void> {
  const body = isRecord(req.body) ? req.body : {};

  let parsedModel: { provider: Provider; upstreamModel: string };
  try {
    parsedModel = parseModel(body.model);
  } catch (error) {
    setSpanAttributes(requestSpan, { "http.status_code": 400 });
    setSpanOutput(requestSpan, { error: error instanceof Error ? error.message : "Invalid model" });
    sendOpenAIError(res, 400, error instanceof Error ? error.message : "Invalid model");
    return;
  }

  const { provider, upstreamModel } = parsedModel;
  const providerApiKey = getProviderApiKey(provider);
  if (!providerApiKey) {
    setSpanAttributes(requestSpan, {
      "http.status_code": 500,
      "adapter.provider": provider,
    });
    setSpanOutput(requestSpan, { error: `Missing ${provider.toUpperCase()}_API_KEY` });
    sendOpenAIError(res, 500, `Missing ${provider.toUpperCase()}_API_KEY`, "configuration_error");
    return;
  }

  setSpanAttributes(requestSpan, {
    "adapter.provider": provider,
    "gen_ai.request.model": typeof body.model === "string" ? body.model : "",
    "gen_ai.response.model": upstreamModel,
    "langwatch.gen_ai.streaming": isStreamRequested(body),
  });

  const upstreamUrl =
    provider === "groq" ? `${GROQ_BASE_URL}/chat/completions` : `${MINIMAX_BASE_URL}/chat/completions`;

  const upstreamBody: GenericRecord = {
    ...body,
    model: upstreamModel,
  };
  if (provider === "minimax" && typeof upstreamBody.reasoning_split !== "boolean") {
    upstreamBody.reasoning_split = true;
  }

  const stream = isStreamRequested(body);
  const upstream = await fetchUpstreamWithTrace(
    `upstream.${provider}.chat_completions`,
    provider,
    "chat_completions",
    upstreamUrl,
    providerApiKey,
    upstreamBody,
    stream,
  );

  if (!stream) {
    forwardSelectedHeaders(upstream, res);
    const payload = await readUpstreamPayload(upstream);
    if (isRecord(payload)) {
      const normalizedPayload = sanitizeChatCompletionPayload(payload);
      if (isRecord(normalizedPayload.usage)) {
        const usage = normalizedPayload.usage;
        setSpanMetrics(requestSpan, {
          promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
          completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
        });
      }
      const assistantText = extractAssistantTextFromChatCompletionPayload(normalizedPayload);
      setSpanOutput(requestSpan, assistantText !== "" ? assistantText : "[empty assistant output]");
      res.status(upstream.status).json(normalizedPayload);
      return;
    }

    setSpanOutput(requestSpan, summarizeForTrace(payload));
    res.status(upstream.status).send(String(payload));
    return;
  }

  if (!upstream.ok) {
    await sendUpstreamError(res, upstream, provider, "chat_completion", requestSpan);
    return;
  }

  setSpanOutput(requestSpan, { stream: true, status_code: upstream.status });
  await pipeRawStream(upstream, res);
}

async function proxyResponses(req: Request, res: Response, requestSpan: TraceSpan | null): Promise<void> {
  const body = isRecord(req.body) ? req.body : {};
  debugLog("incoming /v1/responses", {
    contentType: req.headers["content-type"] ?? "",
    contentEncoding: req.headers["content-encoding"] ?? "",
    bodyPreview: JSON.stringify(body).slice(0, 800),
  });

  let parsedModel: { provider: Provider; upstreamModel: string };
  try {
    parsedModel = parseModel(body.model);
  } catch (error) {
    setSpanAttributes(requestSpan, { "http.status_code": 400 });
    setSpanOutput(requestSpan, { error: error instanceof Error ? error.message : "Invalid model" });
    sendOpenAIError(res, 400, error instanceof Error ? error.message : "Invalid model");
    return;
  }

  const { provider, upstreamModel } = parsedModel;
  const providerApiKey = getProviderApiKey(provider);
  const previousResponseId = getPreviousResponseId(body);
  let resolvedThreadId: string | null = previousResponseId;
  if (!providerApiKey) {
    setSpanAttributes(requestSpan, {
      "http.status_code": 500,
      "adapter.provider": provider,
    });
    setSpanOutput(requestSpan, { error: `Missing ${provider.toUpperCase()}_API_KEY` });
    sendOpenAIError(res, 500, `Missing ${provider.toUpperCase()}_API_KEY`, "configuration_error");
    return;
  }

  setSpanAttributes(requestSpan, {
    "adapter.provider": provider,
    "gen_ai.request.model": typeof body.model === "string" ? body.model : "",
    "gen_ai.response.model": upstreamModel,
    "langwatch.gen_ai.streaming": isStreamRequested(body),
    "gen_ai.request.previous_response_id": previousResponseId ?? "",
  });

  if (provider === "groq") {
    const groqBody = buildGroqPayloadFromResponses(body, upstreamModel);
    debugDumpJson("/tmp/adapter-last-groq-request.json", groqBody);
    debugLog("groq outbound payload", {
      bodyPreview: JSON.stringify(groqBody).slice(0, 800),
    });

    const stream = isStreamRequested(body);
    const upstream = await fetchUpstreamWithTrace(
      "upstream.groq.responses",
      provider,
      "responses",
      `${GROQ_BASE_URL}/responses`,
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
      await sendUpstreamError(res, upstream, provider, "responses", requestSpan);
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
    return;
  }

  const replayHistoryMessages: GenericRecord[] = [];
  if (previousResponseId) {
    const replayHistory = buildReplayMessagesFromStoredChain(previousResponseId);
    if (!replayHistory.ok) {
      const message = mapChainErrorToMessage(replayHistory.reason, replayHistory.response_id);
      setSpanAttributes(requestSpan, { "http.status_code": 400 });
      setSpanOutput(requestSpan, { error: message });
      sendOpenAIError(res, 400, message, "invalid_request_error", {
        previous_response_id: previousResponseId,
        chain_error: replayHistory.reason,
      });
      return;
    }
    resolvedThreadId = replayHistory.messages.length > 0 ? previousResponseId : resolvedThreadId;
    replayHistoryMessages.push(...replayHistory.messages);
  }

  const currentInputMessages = normalizeResponsesInputToMessages(body.input, { fallbackBlank: false });
  const instructionMessage = buildInstructionMessage(body);
  const minimaxMessages: GenericRecord[] = [
    ...(instructionMessage ? [instructionMessage] : []),
    ...replayHistoryMessages,
    ...currentInputMessages,
  ];
  if (minimaxMessages.length === 0) {
    minimaxMessages.push({ role: "user", content: " " });
  }

  const adapterResponseId = createAdapterResponseId();
  if (!resolvedThreadId) {
    resolvedThreadId = adapterResponseId;
  }
  setTraceThreadId(requestSpan, resolvedThreadId);
  const stream = isStreamRequested(body);
  const minimaxPayload = buildMiniMaxPayloadFromResponses(body, upstreamModel, stream, minimaxMessages);
  debugDumpJson("/tmp/adapter-last-minimax-request.json", minimaxPayload);
  const upstream = await fetchUpstreamWithTrace(
    "upstream.minimax.chat_completions",
    provider,
    stream ? "responses_stream" : "responses",
    `${MINIMAX_BASE_URL}/chat/completions`,
    providerApiKey,
    minimaxPayload,
    stream,
  );

  if (!stream) {
    if (!upstream.ok) {
      await sendUpstreamError(res, upstream, provider, "responses", requestSpan);
      return;
    }

    forwardSelectedHeaders(upstream, res);
    const payload = await readUpstreamPayload(upstream);
    if (!isRecord(payload)) {
      setSpanAttributes(requestSpan, { "http.status_code": 502 });
      setSpanOutput(requestSpan, { error: "Invalid JSON response from MiniMax" });
      sendOpenAIError(res, 502, "Invalid JSON response from MiniMax", "upstream_error");
      return;
    }

    const normalized = await withSpan("bridge.minimax.chat_to_responses", async (span) => {
      setSpanType(span, "tool");
      setSpanInput(span, summarizeForTrace(payload));
      const converted = convertMiniMaxChatToResponses(payload, upstreamModel, {
        responseId: adapterResponseId,
        previousResponseId,
      });
      setSpanOutput(span, summarizeForTrace(converted));
      return converted;
    });

    setResponsesUsageMetrics(requestSpan, payload.usage);
    setTraceThreadId(requestSpan, resolvedThreadId);
    traceResponsesOutput(requestSpan, normalized, 200, false);
    persistMiniMaxResponseRecord({
      responseId: adapterResponseId,
      previousResponseId,
      upstreamModel,
      requestBody: body,
      requestInputMessages: currentInputMessages,
      normalizedResponse: normalized,
      rawUpstreamPayload: payload,
    });
    res.status(200).json(normalized);
    return;
  }

  if (!upstream.ok) {
    await sendUpstreamError(res, upstream, provider, "responses_stream", requestSpan);
    return;
  }

  const completedResponse = await withSpan("bridge.minimax.stream_chat_to_responses", async (span) => {
    setSpanType(span, "tool");
    setSpanAttributes(span, {
      "adapter.provider": provider,
      "langwatch.gen_ai.streaming": true,
      "gen_ai.response.model": upstreamModel,
      "gen_ai.response.id": adapterResponseId,
    });
    const response = await streamMiniMaxAsResponses(upstream, res, upstreamModel, {
      responseId: adapterResponseId,
      previousResponseId,
    });
    setSpanOutput(span, summarizeForTrace(response));
    return response;
  });
  if (!completedResponse) {
    setTraceThreadId(requestSpan, resolvedThreadId);
    setSpanOutput(requestSpan, "[empty assistant output]");
    return;
  }

  setResponsesUsageMetrics(requestSpan, completedResponse.usage);
  setTraceThreadId(requestSpan, resolvedThreadId);
  traceResponsesOutput(requestSpan, completedResponse, 200, true);
  persistMiniMaxResponseRecord({
    responseId: adapterResponseId,
    previousResponseId,
    upstreamModel,
    requestBody: body,
    requestInputMessages: currentInputMessages,
    normalizedResponse: completedResponse,
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
    providers: {
      groq_configured: Boolean(GROQ_API_KEY),
      minimax_configured: Boolean(MINIMAX_API_KEY),
    },
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

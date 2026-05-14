import crypto from "node:crypto";

import type { Request, Response } from "express";

import {
  recordSpanException,
  setSpanAttributes,
  setSpanInput,
  setSpanMetrics,
  setSpanOutput,
  setSpanType,
  withSpan,
  type TraceSpan,
} from "./observability.js";
import { type ReplayMessage, ResponsesStore } from "./responses-store.js";

export type GenericRecord = Record<string, unknown>;
export type Role = "system" | "user" | "assistant" | "tool";

export function isRecord(value: unknown): value is GenericRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function summarizeForTrace(value: unknown): unknown {
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

export async function withRequestTrace(
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

export async function fetchUpstreamWithTrace(
  spanName: string,
  provider: string,
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

export function sendOpenAIError(
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

export function extractText(value: unknown): string {
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

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function stripUndefined<T extends GenericRecord>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T;
}

export function isStreamRequested(body: GenericRecord): boolean {
  return body.stream === true;
}

export function toRole(value: unknown): Role {
  if (value === "system" || value === "assistant" || value === "user" || value === "tool") return value;
  return "user";
}

export function stringifyJsonValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "";
  }
}

export function normalizeResponsesInputToMessages(
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

export function buildInstructionMessage(body: GenericRecord): GenericRecord | null {
  if (typeof body.instructions === "string" && body.instructions.trim() !== "") {
    return {
      role: "system",
      content: body.instructions.trim(),
    };
  }
  return null;
}

export function getPreviousResponseId(body: GenericRecord): string | null {
  if (typeof body.previous_response_id !== "string") return null;
  const previousResponseId = body.previous_response_id.trim();
  return previousResponseId === "" ? null : previousResponseId;
}

export function replayMessageToGeneric(message: ReplayMessage): GenericRecord {
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

export function toReplayMessages(messages: GenericRecord[]): ReplayMessage[] {
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

export function buildReplayMessagesFromStoredChain(
  responsesStore: ResponsesStore,
  previousResponseId: string,
): {
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

export function mapChainErrorToMessage(reason: "missing" | "cycle" | "depth_limit", responseId: string): string {
  if (reason === "missing") {
    return `previous_response_id not found: ${responseId}`;
  }
  if (reason === "cycle") {
    return `previous_response_id chain contains a cycle at: ${responseId}`;
  }
  return `previous_response_id chain exceeded max depth near: ${responseId}`;
}

export function sanitizeAssistantText(text: string): string {
  if (process.env.STRIP_THINK_TAGS === "false") return text;
  if (text === "") return text;
  const withoutClosedThinkBlocks = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "");
  const withoutDanglingThinkStart = withoutClosedThinkBlocks.replace(/<think>[\s\S]*$/gi, "");
  const withoutThinkMarkers = withoutDanglingThinkStart.replace(/<\/?think>/gi, "");
  const sanitized = withoutThinkMarkers.replace(/\n{3,}/g, "\n\n").trim();
  if (sanitized !== "") return sanitized;
  return text.trim();
}

export function sanitizeResponsesOutput(output: unknown): unknown {
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

export function extractAssistantTextFromMessageItem(item: GenericRecord): string {
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

export function extractAssistantTextFromResponseOutput(output: unknown): string {
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

export function extractAssistantTextFromResponsesPayload(payload: unknown): string {
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

export function ensureResponsesPayloadOutputText(payload: GenericRecord): GenericRecord {
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

export function extractAssistantTextFromChatCompletionPayload(payload: GenericRecord): string {
  if (!Array.isArray(payload.choices)) return "";

  for (const choice of payload.choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    const text = sanitizeAssistantText(extractText(choice.message.content));
    if (text !== "") return text;
  }

  return "";
}

export function sanitizeChatCompletionPayload(payload: GenericRecord): GenericRecord {
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

export function extractResponseIdFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.id === "string" && payload.id.trim() !== "") {
    return payload.id;
  }
  if (isRecord(payload.response) && typeof payload.response.id === "string" && payload.response.id.trim() !== "") {
    return payload.response.id;
  }
  return null;
}

export function setResponsesUsageMetrics(span: TraceSpan | null, usageValue: unknown): void {
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

export function traceResponsesOutput(
  span: TraceSpan | null,
  payload: unknown,
  statusCode: number,
  stream: boolean,
): void {
  const responseId = extractResponseIdFromPayload(payload);
  const assistantText = extractAssistantTextFromResponsesPayload(payload).slice(0, 12000);
  setSpanAttributes(span, {
    "gen_ai.response.id": responseId ?? "",
    "http.status_code": statusCode,
    "langwatch.gen_ai.streaming": stream,
  });
  setSpanOutput(span, assistantText === "" ? "[empty assistant output]" : assistantText);
}

export function setTraceThreadId(span: TraceSpan | null, threadId: string | null): void {
  if (!threadId) return;
  setSpanAttributes(span, {
    "langwatch.thread.id": threadId,
  });
}

export function createAdapterResponseId(): string {
  return `resp_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function forwardSelectedHeaders(from: globalThis.Response, to: Response): void {
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

export async function readUpstreamPayload(upstream: globalThis.Response): Promise<unknown> {
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

export async function sendUpstreamError(
  res: Response,
  upstream: globalThis.Response,
  provider: string,
  requestType: string,
  span: TraceSpan | null = null,
): Promise<void> {
  forwardSelectedHeaders(upstream, res);
  const payload = await readUpstreamPayload(upstream);
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

export async function pipeRawStream(upstream: globalThis.Response, res: Response): Promise<void> {
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

export type ResponsesStreamCapture = {
  responseId: string | null;
  assistantText: string;
  usage: GenericRecord | null;
  completedResponse: GenericRecord | null;
};

export function consumeResponsesSseData(capture: ResponsesStreamCapture, dataLine: string): void {
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

export async function pipeResponsesStreamWithCapture(
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

export async function* parseSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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

export function writeSse(res: Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function buildAssistantReplayMessagesFromOutput(output: unknown): ReplayMessage[] {
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

export function buildMiniMaxRequestSnapshot(body: GenericRecord, previousResponseId: string | null): GenericRecord {
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

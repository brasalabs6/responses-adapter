import crypto from "node:crypto";
import fs from "node:fs";

import dotenv from "dotenv";
import express, { NextFunction, Request, Response } from "express";

dotenv.config();

type Provider = "groq" | "minimax";
type Role = "system" | "user" | "assistant" | "tool";

type GenericRecord = Record<string, unknown>;

const PORT = Number.parseInt(process.env.PORT ?? "19090", 10);
const ADAPTER_API_KEY = process.env.ADAPTER_API_KEY;
const ADAPTER_DEBUG = process.env.ADAPTER_DEBUG === "1";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;

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

function normalizeResponsesInputToMessages(body: GenericRecord): GenericRecord[] {
  const messages: GenericRecord[] = [];

  if (typeof body.instructions === "string" && body.instructions.trim() !== "") {
    messages.push({ role: "system", content: body.instructions.trim() });
  }

  const input = body.input;

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

  if (messages.length === 0) {
    messages.push({ role: "user", content: " " });
  }

  return messages;
}

function buildMiniMaxPayloadFromResponses(body: GenericRecord, upstreamModel: string, stream: boolean): GenericRecord {
  const minimaxTools = normalizeMiniMaxTools(body.tools);
  const minimaxToolChoice = normalizeMiniMaxToolChoice(body.tool_choice);

  const payload: GenericRecord = {
    model: upstreamModel,
    messages: normalizeResponsesInputToMessages(body),
    stream,
    temperature: asNumber(body.temperature),
    top_p: asNumber(body.top_p),
    max_tokens: asNumber(body.max_output_tokens) ?? asNumber(body.max_tokens),
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

function convertMiniMaxChatToResponses(chatCompletion: GenericRecord, upstreamModel: string): GenericRecord {
  const choice0 = Array.isArray(chatCompletion.choices) ? chatCompletion.choices[0] : undefined;
  const functionCallItems = extractMiniMaxFunctionCallItems(choice0);
  const assistantContent = isRecord(choice0) && isRecord(choice0.message) ? extractText(choice0.message.content) : "";

  const usage = isRecord(chatCompletion.usage) ? chatCompletion.usage : {};

  const responseId = `resp_${typeof chatCompletion.id === "string" ? chatCompletion.id : crypto.randomUUID()}`;
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
    output,
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
): Promise<void> {
  forwardSelectedHeaders(upstream, res);
  const payload = await readUpstreamPayload(upstream);
  debugLog("upstream-error", {
    provider,
    requestType,
    status: upstream.status,
    payload,
  });

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
): Promise<void> {
  if (!upstream.body) {
    sendOpenAIError(res, 502, "Upstream stream is empty", "upstream_error");
    return;
  }

  type ToolCallState = {
    outputIndex: number;
    id: string;
    callId: string;
    name: string;
    arguments: string;
    added: boolean;
  };

  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
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

    if (outputText !== "") {
      writeSse(res, {
        type: "response.output_text.delta",
        sequence_number: sequenceNumber++,
        response_id: responseId,
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        delta: outputText,
      });
    }

    writeSse(res, {
      type: "response.output_text.done",
      sequence_number: sequenceNumber++,
      response_id: responseId,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text: outputText,
    });

    writeSse(res, {
      type: "response.content_part.done",
      sequence_number: sequenceNumber++,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: {
        type: "output_text",
        text: outputText,
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
            text: outputText,
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
            text: outputText,
            annotations: [],
          },
        ],
      },
    ];
  }

  writeSse(res, {
    type: "response.completed",
    sequence_number: sequenceNumber++,
    response: {
      id: responseId,
      object: "response",
      status: "completed",
      model: upstreamModel,
      output: completedOutput,
      usage: {
        input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
        output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
        total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : 0,
      },
    },
  });

  res.write("data: [DONE]\n\n");
  res.end();
}

async function proxyChatCompletions(req: Request, res: Response): Promise<void> {
  const body = isRecord(req.body) ? req.body : {};

  let parsedModel: { provider: Provider; upstreamModel: string };
  try {
    parsedModel = parseModel(body.model);
  } catch (error) {
    sendOpenAIError(res, 400, error instanceof Error ? error.message : "Invalid model");
    return;
  }

  const { provider, upstreamModel } = parsedModel;
  const providerApiKey = getProviderApiKey(provider);
  if (!providerApiKey) {
    sendOpenAIError(res, 500, `Missing ${provider.toUpperCase()}_API_KEY`, "configuration_error");
    return;
  }

  const upstreamUrl =
    provider === "groq" ? `${GROQ_BASE_URL}/chat/completions` : `${MINIMAX_BASE_URL}/chat/completions`;

  const upstreamBody = {
    ...body,
    model: upstreamModel,
  };

  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${providerApiKey}`,
      "Content-Type": "application/json",
      Accept: isStreamRequested(body) ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(upstreamBody),
  });

  if (!isStreamRequested(body)) {
    forwardSelectedHeaders(upstream, res);
    const payload = await readUpstreamPayload(upstream);
    if (isRecord(payload)) {
      res.status(upstream.status).json(payload);
      return;
    }

    res.status(upstream.status).send(String(payload));
    return;
  }

  if (!upstream.ok) {
    await sendUpstreamError(res, upstream, provider, "chat_completion");
    return;
  }

  await pipeRawStream(upstream, res);
}

async function proxyResponses(req: Request, res: Response): Promise<void> {
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
    sendOpenAIError(res, 400, error instanceof Error ? error.message : "Invalid model");
    return;
  }

  const { provider, upstreamModel } = parsedModel;
  const providerApiKey = getProviderApiKey(provider);
  if (!providerApiKey) {
    sendOpenAIError(res, 500, `Missing ${provider.toUpperCase()}_API_KEY`, "configuration_error");
    return;
  }

  if (provider === "groq") {
    const groqBody = buildGroqPayloadFromResponses(body, upstreamModel);
    debugDumpJson("/tmp/adapter-last-groq-request.json", groqBody);
    debugLog("groq outbound payload", {
      bodyPreview: JSON.stringify(groqBody).slice(0, 800),
    });

    const upstream = await fetch(`${GROQ_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${providerApiKey}`,
        "Content-Type": "application/json",
        Accept: isStreamRequested(body) ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(groqBody),
    });

    if (!isStreamRequested(body)) {
      forwardSelectedHeaders(upstream, res);
      const payload = await readUpstreamPayload(upstream);
      if (isRecord(payload)) {
        res.status(upstream.status).json(payload);
        return;
      }

      res.status(upstream.status).send(String(payload));
      return;
    }

    if (!upstream.ok) {
      await sendUpstreamError(res, upstream, provider, "responses");
      return;
    }

    await pipeRawStream(upstream, res);
    return;
  }

  const stream = isStreamRequested(body);
  const minimaxPayload = buildMiniMaxPayloadFromResponses(body, upstreamModel, stream);

  const upstream = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${providerApiKey}`,
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(minimaxPayload),
  });

  if (!stream) {
    if (!upstream.ok) {
      await sendUpstreamError(res, upstream, provider, "responses");
      return;
    }

    forwardSelectedHeaders(upstream, res);
    const payload = await readUpstreamPayload(upstream);
    if (!isRecord(payload)) {
      sendOpenAIError(res, 502, "Invalid JSON response from MiniMax", "upstream_error");
      return;
    }

    res.status(200).json(convertMiniMaxChatToResponses(payload, upstreamModel));
    return;
  }

  if (!upstream.ok) {
    await sendUpstreamError(res, upstream, provider, "responses_stream");
    return;
  }

  await streamMiniMaxAsResponses(upstream, res, upstreamModel);
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    adapter: "responses-adapter",
    providers: {
      groq_configured: Boolean(GROQ_API_KEY),
      minimax_configured: Boolean(MINIMAX_API_KEY),
    },
  });
});

app.use("/v1", requireAdapterAuth);

app.post("/v1/chat/completions", async (req, res, next) => {
  try {
    await proxyChatCompletions(req, res);
  } catch (error) {
    next(error);
  }
});

app.post("/v1/responses", async (req, res, next) => {
  try {
    await proxyResponses(req, res);
  } catch (error) {
    next(error);
  }
});

app.post("/v1/responses/compact", async (req, res, next) => {
  try {
    await proxyResponses(req, res);
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

import crypto from "node:crypto";

import {
  asNumber,
  buildAssistantReplayMessagesFromOutput,
  buildInstructionMessage,
  buildMiniMaxRequestSnapshot,
  buildReplayMessagesFromStoredChain,
  createAdapterResponseId,
  extractAssistantTextFromChatCompletionPayload,
  extractAssistantTextFromResponsesPayload,
  extractText,
  fetchUpstreamWithTrace,
  forwardSelectedHeaders,
  isRecord,
  mapChainErrorToMessage,
  normalizeResponsesInputToMessages,
  parseSseData,
  pipeRawStream,
  readUpstreamPayload,
  sanitizeAssistantText,
  sanitizeChatCompletionPayload,
  sanitizeResponsesOutput,
  sendOpenAIError,
  sendUpstreamError,
  setResponsesUsageMetrics,
  setTraceThreadId,
  stripUndefined,
  stringifyJsonValue,
  summarizeForTrace,
  toReplayMessages,
  traceResponsesOutput,
  writeSse,
  type GenericRecord,
} from "../adapter-utils.js";
import {
  setSpanAttributes,
  setSpanInput,
  setSpanOutput,
  setSpanType,
  withSpan,
} from "../observability.js";
import type { ProviderAdapter, ProviderContext } from "./types.js";

const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";

type MiniMaxProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
};

export function normalizeMiniMaxTools(toolsValue: unknown): GenericRecord[] | undefined {
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

export function normalizeMiniMaxToolChoice(toolChoiceValue: unknown): unknown {
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

export function buildMiniMaxPayloadFromResponses(
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

function persistMiniMaxResponseRecord(input: {
  context: ProviderContext;
  responseId: string;
  previousResponseId: string | null;
  upstreamModel: string;
  requestBody: GenericRecord;
  requestInputMessages: GenericRecord[];
  normalizedResponse: GenericRecord;
  rawUpstreamPayload?: unknown;
}): void {
  try {
    input.context.services.responsesStore.append({
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
    input.context.services.debugLog("failed to persist minimax response record", {
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

export function convertMiniMaxChatToResponses(
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

async function streamMiniMaxAsResponses(
  upstream: globalThis.Response,
  context: ProviderContext,
  upstreamModel: string,
  options: {
    responseId: string;
    previousResponseId: string | null;
  },
): Promise<GenericRecord | null> {
  const { res } = context;
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

async function handleMiniMaxChatCompletions(baseUrl: string, context: ProviderContext): Promise<void> {
  const { body, providerApiKey, requestSpan, res, stream, upstreamModel } = context;
  const upstreamBody: GenericRecord = {
    ...body,
    model: upstreamModel,
  };
  if (typeof upstreamBody.reasoning_split !== "boolean") {
    upstreamBody.reasoning_split = true;
  }

  const upstream = await fetchUpstreamWithTrace(
    "upstream.minimax.chat_completions",
    "minimax",
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
    await sendUpstreamError(res, upstream, "minimax", "chat_completion", requestSpan);
    return;
  }

  setSpanOutput(requestSpan, { stream: true, status_code: upstream.status });
  await pipeRawStream(upstream, res);
}

async function handleMiniMaxResponses(baseUrl: string, context: ProviderContext): Promise<void> {
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

  let resolvedThreadId: string | null = previousResponseId;
  const replayHistoryMessages: GenericRecord[] = [];
  if (previousResponseId) {
    const replayHistory = buildReplayMessagesFromStoredChain(services.responsesStore, previousResponseId);
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

  const minimaxPayload = buildMiniMaxPayloadFromResponses(body, upstreamModel, stream, minimaxMessages);
  services.debugDumpJson("/tmp/adapter-last-minimax-request.json", minimaxPayload);
  const upstream = await fetchUpstreamWithTrace(
    "upstream.minimax.chat_completions",
    "minimax",
    stream ? "responses_stream" : "responses",
    `${baseUrl}/chat/completions`,
    providerApiKey,
    minimaxPayload,
    stream,
  );

  if (!stream) {
    if (!upstream.ok) {
      await sendUpstreamError(res, upstream, "minimax", "responses", requestSpan);
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
      context,
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
    await sendUpstreamError(res, upstream, "minimax", "responses_stream", requestSpan);
    return;
  }

  const completedResponse = await withSpan("bridge.minimax.stream_chat_to_responses", async (span) => {
    setSpanType(span, "tool");
    setSpanAttributes(span, {
      "adapter.provider": "minimax",
      "langwatch.gen_ai.streaming": true,
      "gen_ai.response.model": upstreamModel,
      "gen_ai.response.id": adapterResponseId,
    });
    const response = await streamMiniMaxAsResponses(upstream, context, upstreamModel, {
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
    context,
    responseId: adapterResponseId,
    previousResponseId,
    upstreamModel,
    requestBody: body,
    requestInputMessages: currentInputMessages,
    normalizedResponse: completedResponse,
  });
}

export function createMiniMaxProvider(options: MiniMaxProviderOptions = {}): ProviderAdapter {
  const apiKey = options.apiKey ?? process.env.MINIMAX_API_KEY;
  const baseUrl = (options.baseUrl ?? process.env.MINIMAX_BASE_URL ?? DEFAULT_MINIMAX_BASE_URL).replace(/\/$/, "");

  return {
    id: "minimax",
    modelPrefixes: ["minimax"],
    getApiKey: () => apiKey,
    handleChatCompletions: async (context) => {
      setSpanAttributes(context.requestSpan, { "adapter.provider": "minimax" });
      await handleMiniMaxChatCompletions(baseUrl, context);
    },
    handleResponses: async (context) => {
      setSpanAttributes(context.requestSpan, { "adapter.provider": "minimax" });
      await handleMiniMaxResponses(baseUrl, context);
    },
  };
}

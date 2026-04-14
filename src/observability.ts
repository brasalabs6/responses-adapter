import { getLangWatchTracer } from "langwatch";
import { setupObservability } from "langwatch/observability/node";

type MaybePromise<T> = T | Promise<T>;

export type TraceSpan = {
  setType: (type: string) => unknown;
  setAttributes: (attributes: Record<string, unknown>) => unknown;
  setInput: (input: unknown) => unknown;
  setOutput: (output: unknown) => unknown;
  setMetrics: (metrics: { promptTokens?: number; completionTokens?: number; cost?: number }) => unknown;
  recordException: (exception: unknown) => unknown;
};

const DEFAULT_LANGWATCH_ENDPOINT = "https://langwatch.brasaai.com.br";
const LANGWATCH_API_KEY = process.env.LANGWATCH_API_KEY;
const LANGWATCH_ENDPOINT_URL = process.env.LANGWATCH_ENDPOINT_URL ?? DEFAULT_LANGWATCH_ENDPOINT;
const LANGWATCH_SERVICE_NAME = process.env.LANGWATCH_SERVICE_NAME ?? "responses-adapter";

let enabled = false;
let traceRunner:
  | (<T>(name: string, callback: (span: TraceSpan) => MaybePromise<T>) => Promise<T>)
  | null = null;

if (LANGWATCH_API_KEY) {
  try {
    setupObservability({
      serviceName: LANGWATCH_SERVICE_NAME,
      langwatch: {
        apiKey: LANGWATCH_API_KEY,
        endpoint: LANGWATCH_ENDPOINT_URL,
        processorType: "batch",
      },
      dataCapture: "all",
      attributes: {
        "deployment.environment.name": process.env.NODE_ENV ?? "development",
      },
    });

    const tracer = getLangWatchTracer(LANGWATCH_SERVICE_NAME);
    traceRunner = async <T>(name: string, callback: (span: TraceSpan) => MaybePromise<T>): Promise<T> => {
      return await tracer.withActiveSpan(name, async (span) => {
        return await callback(span as unknown as TraceSpan);
      });
    };
    enabled = true;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[langwatch] failed to initialize, running without LangWatch", error);
    traceRunner = null;
    enabled = false;
  }
}

export async function withSpan<T>(name: string, callback: (span: TraceSpan | null) => MaybePromise<T>): Promise<T> {
  if (!traceRunner) {
    return await callback(null);
  }
  return await traceRunner(name, callback);
}

export function isLangWatchEnabled(): boolean {
  return enabled;
}

export function getLangWatchEndpoint(): string | null {
  return enabled ? LANGWATCH_ENDPOINT_URL : null;
}

export function setSpanType(span: TraceSpan | null, type: string): void {
  span?.setType(type);
}

export function setSpanAttributes(span: TraceSpan | null, attributes: Record<string, unknown>): void {
  span?.setAttributes(attributes);
}

export function setSpanInput(span: TraceSpan | null, input: unknown): void {
  span?.setInput(input);
}

export function setSpanOutput(span: TraceSpan | null, output: unknown): void {
  span?.setOutput(output);
}

export function setSpanMetrics(
  span: TraceSpan | null,
  metrics: { promptTokens?: number; completionTokens?: number; cost?: number },
): void {
  span?.setMetrics(metrics);
}

export function recordSpanException(span: TraceSpan | null, exception: unknown): void {
  span?.recordException(exception);
}

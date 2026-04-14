import fs from "node:fs";
import path from "node:path";

type Role = "system" | "user" | "assistant" | "tool";
type GenericRecord = Record<string, unknown>;

export type ReplayToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ReplayMessage = {
  role: Role;
  content?: string;
  tool_call_id?: string;
  tool_calls?: ReplayToolCall[];
};

export type StoredResponseRecord = {
  id: string;
  provider: "minimax";
  model: string;
  created_at: number;
  previous_response_id: string | null;
  status: string;
  request_snapshot: GenericRecord;
  request_input_messages: ReplayMessage[];
  assistant_messages: ReplayMessage[];
  output: unknown;
  assistant_final_text: string;
  usage?: GenericRecord;
  raw_upstream_summary?: unknown;
};

export type ResolveChainResult =
  | {
      ok: true;
      chain: StoredResponseRecord[];
    }
  | {
      ok: false;
      reason: "missing" | "cycle" | "depth_limit";
      response_id: string;
    };

type ResponsesStoreOptions = {
  dataDir?: string;
  fileName?: string;
  maxChainDepth?: number;
  onWarning?: (message: string, extra?: unknown) => void;
};

function isRecord(value: unknown): value is GenericRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeReplayMessages(value: unknown): ReplayMessage[] {
  if (!Array.isArray(value)) return [];
  const output: ReplayMessage[] = [];

  for (const item of value) {
    if (!isRecord(item)) continue;
    if (item.role !== "system" && item.role !== "user" && item.role !== "assistant" && item.role !== "tool") {
      continue;
    }

    const message: ReplayMessage = {
      role: item.role,
    };

    if (typeof item.content === "string") {
      message.content = item.content;
    }

    if (typeof item.tool_call_id === "string" && item.tool_call_id.trim() !== "") {
      message.tool_call_id = item.tool_call_id;
    }

    if (Array.isArray(item.tool_calls)) {
      const toolCalls: ReplayToolCall[] = [];
      for (const rawToolCall of item.tool_calls) {
        if (!isRecord(rawToolCall)) continue;
        if (rawToolCall.type !== "function") continue;
        if (typeof rawToolCall.id !== "string" || rawToolCall.id.trim() === "") continue;
        if (!isRecord(rawToolCall.function)) continue;
        if (typeof rawToolCall.function.name !== "string" || rawToolCall.function.name.trim() === "") continue;

        toolCalls.push({
          id: rawToolCall.id,
          type: "function",
          function: {
            name: rawToolCall.function.name,
            arguments:
              typeof rawToolCall.function.arguments === "string" ? rawToolCall.function.arguments : "",
          },
        });
      }
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }
    }

    output.push(message);
  }

  return output;
}

function normalizeStoredRecord(value: unknown): StoredResponseRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id.trim() === "") return null;
  if (value.provider !== "minimax") return null;
  if (typeof value.model !== "string" || value.model.trim() === "") return null;
  if (typeof value.created_at !== "number" || !Number.isFinite(value.created_at)) return null;

  const normalized: StoredResponseRecord = {
    id: value.id,
    provider: "minimax",
    model: value.model,
    created_at: value.created_at,
    previous_response_id: typeof value.previous_response_id === "string" ? value.previous_response_id : null,
    status: typeof value.status === "string" ? value.status : "completed",
    request_snapshot: isRecord(value.request_snapshot) ? value.request_snapshot : {},
    request_input_messages: normalizeReplayMessages(value.request_input_messages),
    assistant_messages: normalizeReplayMessages(value.assistant_messages),
    output: value.output,
    assistant_final_text: typeof value.assistant_final_text === "string" ? value.assistant_final_text : "",
    usage: isRecord(value.usage) ? value.usage : undefined,
    raw_upstream_summary: value.raw_upstream_summary,
  };

  return normalized;
}

export class ResponsesStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly maxChainDepth: number;
  private readonly onWarning?: (message: string, extra?: unknown) => void;
  private readonly records = new Map<string, StoredResponseRecord>();

  constructor(options: ResponsesStoreOptions = {}) {
    this.dataDir = options.dataDir ?? path.resolve(process.cwd(), process.env.ADAPTER_DATA_DIR ?? "data");
    const fileName = options.fileName ?? process.env.RESPONSES_HISTORY_FILE ?? "responses-history.jsonl";
    this.filePath = path.join(this.dataDir, fileName);
    this.maxChainDepth = options.maxChainDepth ?? 200;
    this.onWarning = options.onWarning;
    this.loadFromDisk();
  }

  get storagePath(): string {
    return this.filePath;
  }

  get(responseId: string): StoredResponseRecord | undefined {
    return this.records.get(responseId);
  }

  append(record: StoredResponseRecord): void {
    this.records.set(record.id, record);
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  resolveChain(previousResponseId: string): ResolveChainResult {
    const seen = new Set<string>();
    const chain: StoredResponseRecord[] = [];
    let cursor: string | null = previousResponseId;

    while (cursor) {
      if (seen.has(cursor)) {
        return { ok: false, reason: "cycle", response_id: cursor };
      }
      seen.add(cursor);

      const found = this.records.get(cursor);
      if (!found) {
        return { ok: false, reason: "missing", response_id: cursor };
      }

      chain.push(found);
      if (chain.length > this.maxChainDepth) {
        return { ok: false, reason: "depth_limit", response_id: cursor };
      }

      cursor = found.previous_response_id;
    }

    chain.reverse();
    return { ok: true, chain };
  }

  private loadFromDisk(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "", "utf8");
      return;
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    if (raw.trim() === "") return;

    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        const normalized = normalizeStoredRecord(parsed);
        if (!normalized) {
          this.onWarning?.("Ignoring invalid stored response record", { line: trimmed.slice(0, 200) });
          continue;
        }
        this.records.set(normalized.id, normalized);
      } catch (error) {
        this.onWarning?.("Failed to parse stored response record", {
          line: trimmed.slice(0, 200),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

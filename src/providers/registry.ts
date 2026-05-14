import type { GenericRecord } from "../adapter-utils.js";
import type { ProviderAdapter, ProviderResolution } from "./types.js";

function supportedProviderHint(providers: readonly ProviderAdapter[]): string {
  const examples = providers
    .flatMap((provider) => provider.modelPrefixes)
    .map((prefix) => `${prefix}/<model>`);

  if (examples.length === 0) return "a registered provider prefix";
  if (examples.length === 1) return examples[0];
  return `${examples.slice(0, -1).join(", ")} or ${examples.at(-1)}`;
}

export function resolveProvider(model: unknown, providers: readonly ProviderAdapter[]): ProviderResolution {
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error("model is required and must be a string in provider/model format");
  }

  const [rawPrefix, ...rest] = model.trim().split("/");
  if (!rawPrefix || rest.length === 0) {
    throw new Error("model should be in provider/model format");
  }

  const prefix = rawPrefix.toLowerCase();
  const provider = providers.find((candidate) =>
    candidate.modelPrefixes.some((candidatePrefix) => candidatePrefix.toLowerCase() === prefix),
  );
  if (!provider) {
    throw new Error(`unsupported provider prefix. Use ${supportedProviderHint(providers)}`);
  }

  const upstreamModel = rest.join("/").trim();
  if (!upstreamModel) {
    throw new Error("model should be in provider/model format");
  }

  return { provider, upstreamModel };
}

export function buildProviderHealth(providers: readonly ProviderAdapter[]): GenericRecord {
  const legacyConfiguredFields = Object.fromEntries(
    providers.map((provider) => [`${provider.id}_configured`, Boolean(provider.getApiKey())]),
  );

  return {
    ...legacyConfiguredFields,
    available: providers.map((provider) => ({
      id: provider.id,
      prefixes: provider.modelPrefixes,
      configured: Boolean(provider.getApiKey()),
    })),
  };
}

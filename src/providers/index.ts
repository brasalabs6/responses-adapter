import { createGroqProvider } from "./groq.js";
import { createMiniMaxProvider } from "./minimax.js";
import type { ProviderAdapter } from "./types.js";

export { buildGroqPayloadFromResponses, createGroqProvider } from "./groq.js";
export {
  buildMiniMaxPayloadFromResponses,
  convertMiniMaxChatToResponses,
  createMiniMaxProvider,
  normalizeMiniMaxToolChoice,
  normalizeMiniMaxTools,
} from "./minimax.js";
export { buildProviderHealth, resolveProvider } from "./registry.js";
export type { ProviderAdapter, ProviderContext, ProviderResolution, ProviderServices } from "./types.js";

export function createDefaultProviders(): ProviderAdapter[] {
  return [createGroqProvider(), createMiniMaxProvider()];
}

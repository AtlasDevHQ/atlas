/**
 * Multi-provider LLM configuration.
 *
 * Set ATLAS_PROVIDER and the corresponding API key in your .env.
 * Supports Anthropic, OpenAI, AWS Bedrock, Ollama, and Vercel AI Gateway.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { bedrock } from "@ai-sdk/amazon-bedrock";
import { gateway } from "ai";
import type { LanguageModel } from "ai";

const PROVIDER_DEFAULTS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  bedrock: "anthropic.claude-sonnet-4-6-v1:0",
  ollama: "llama3.1",
  gateway: "anthropic/claude-sonnet-4.6",
};

export function getModel(): LanguageModel {
  const provider = process.env.ATLAS_PROVIDER ?? "anthropic";
  const modelId = process.env.ATLAS_MODEL ?? PROVIDER_DEFAULTS[provider];

  if (!modelId) {
    throw new Error(
      `Unknown provider "${provider}". Supported: anthropic, openai, bedrock, ollama, gateway`
    );
  }

  switch (provider) {
    case "anthropic":
      return anthropic(modelId);

    case "openai":
      return openai(modelId);

    case "bedrock":
      return bedrock(modelId);

    case "ollama": {
      const ollama = createOpenAI({
        baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
      });
      return ollama(modelId);
    }

    case "gateway":
      if (!process.env.AI_GATEWAY_API_KEY) {
        throw new Error(
          "AI_GATEWAY_API_KEY is not set. The gateway provider requires an API key. " +
            "Create one at https://vercel.com/~/ai/api-keys and set it in your .env file."
        );
      }
      return gateway(modelId);

    default:
      throw new Error(
        `Unknown provider "${provider}". Supported: anthropic, openai, bedrock, ollama, gateway`
      );
  }
}

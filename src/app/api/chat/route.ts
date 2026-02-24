import { type UIMessage } from "ai";
import { runAgent } from "@/lib/agent";
import { validateEnvironment } from "@/lib/startup";
import { GatewayModelNotFoundError } from "@ai-sdk/gateway";

export async function POST(req: Request) {
  // Startup diagnostics — fast-fail with actionable errors
  const diagnostics = await validateEnvironment();
  if (diagnostics.length > 0) {
    return Response.json(
      {
        error: "configuration_error",
        message: diagnostics.map((d) => d.message).join("\n\n"),
        diagnostics,
      },
      { status: 400 }
    );
  }

  // Parse request body separately so malformed JSON gets a 400, not 500
  let messages: UIMessage[];
  try {
    ({ messages } = await req.json());
  } catch {
    return Response.json(
      {
        error: "invalid_request",
        message: "Invalid request body. Expected JSON with a 'messages' array.",
      },
      { status: 400 }
    );
  }

  try {
    const result = await runAgent({ messages });
    return result.toUIMessageStreamResponse();
  } catch (err) {
    const message = err instanceof Error ? err.message : "";

    // Gateway-specific errors (structured types, checked before regex fallbacks)
    if (GatewayModelNotFoundError.isInstance(err)) {
      console.error("[atlas] Gateway model not found in /api/chat:", message);
      return Response.json(
        {
          error: "provider_model_not_found",
          message:
            "Model not found on the AI Gateway. Check that your ATLAS_MODEL uses the correct provider/model format (e.g., anthropic/claude-sonnet-4.6).",
        },
        { status: 400 }
      );
    }

    // LLM provider auth errors (invalid or expired API key)
    if (
      /401|403|unauthorized|authentication|invalid.*key/i.test(message)
    ) {
      console.error("[atlas] Provider auth error in /api/chat:", message);
      return Response.json(
        {
          error: "provider_auth_error",
          message:
            "LLM provider authentication failed. Check that your API key is valid and has not expired.",
        },
        { status: 503 }
      );
    }

    // LLM provider rate limit errors
    if (/429|rate.?limit|too many requests|overloaded/i.test(message)) {
      console.error("[atlas] Provider rate limit in /api/chat:", message);
      return Response.json(
        {
          error: "provider_rate_limit",
          message:
            "LLM provider rate limit reached. Wait a moment and try again.",
        },
        { status: 503 }
      );
    }

    // Provider network errors (e.g., network failure to LLM API)
    if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) {
      console.error("[atlas] Provider unreachable in /api/chat:", message);
      return Response.json(
        {
          error: "provider_unreachable",
          message:
            "Could not reach the LLM provider. Check your network connection and provider status.",
        },
        { status: 503 }
      );
    }

    // Fallback — safe 500 with correlation ID for debugging
    const errorId = crypto.randomUUID().slice(0, 8);
    console.error(`[atlas] Unexpected error in /api/chat [${errorId}]:`, err);
    return Response.json(
      {
        error: "internal_error",
        message: `An unexpected error occurred (ref: ${errorId}). If this persists, check the server logs.`,
      },
      { status: 500 }
    );
  }
}

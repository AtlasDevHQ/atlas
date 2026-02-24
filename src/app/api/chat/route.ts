import { type UIMessage } from "ai";
import { runAgent } from "@/lib/agent";

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = await runAgent({ messages });

  return result.toUIMessageStreamResponse();
}

import SUBPROCESSORS from "../../../../data/sub-processors.json";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(JSON.stringify(SUBPROCESSORS), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

// If the Hono app fails to initialise (e.g. missing env vars),
// every request to API routes will return a Next.js 500 until the issue is resolved.
import { app } from "@atlas/api/app";

// Default 60s. Increase based on your Vercel plan:
// https://vercel.com/docs/functions/configuring-functions/duration
export const maxDuration = 60;

async function handler(req: Request): Promise<Response> {
  try {
    return await app.fetch(req);
  } catch (err) {
    console.error("[atlas] Unhandled error in API route:", err);
    return Response.json(
      {
        error: "internal_error",
        message:
          "An unexpected server error occurred. Check the Vercel function logs for details.",
      },
      { status: 500 },
    );
  }
}

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as DELETE,
  handler as PATCH,
  handler as HEAD,
  handler as OPTIONS,
};

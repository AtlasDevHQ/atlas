/**
 * Single statement of the scheduled-delivery Slack sender-resolution rule
 * (#3379): per-team bot token from `chat_cache` (`getBotToken`) first, then
 * the `SLACK_BOT_TOKEN` env fallback. Shared by the delivery path
 * (`deliverToSlack`) and the create/update-time sender preflight so the two
 * can never disagree about whether a recipient has a sender — the same
 * one-chain discipline `resolveEmailSender` provides for the email channel.
 *
 * The Slack store stays dynamically imported here so neither consumer pulls
 * it into its module graph at load time.
 */
export async function resolveSlackBotToken(
  teamId: string | undefined,
  getBotTokenImpl?: (teamId: string) => Promise<string | null>,
): Promise<string | null> {
  let token: string | null = null;
  if (teamId) {
    const getBotToken =
      getBotTokenImpl ?? (await import("@atlas/api/lib/slack/store")).getBotToken;
    token = await getBotToken(teamId);
  }
  if (token) return token;
  const envToken = process.env.SLACK_BOT_TOKEN;
  return typeof envToken === "string" && envToken.length > 0 ? envToken : null;
}

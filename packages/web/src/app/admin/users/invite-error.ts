/**
 * Error-message resolution for the invite dialog (#5436 follow-up).
 *
 * Both invite paths previously collapsed a message-less failure into the
 * bare string "Failed to send invitation." — which reads as "the email
 * didn't go out". When `afterCreateInvitation` threw a `TypeError` in
 * prod, that string was the ONLY thing the admin saw for a 500 that had
 * already committed the invitation row AND already sent the email. The
 * message pointed at the one part of the flow that had worked, and it
 * invited exactly the wrong recovery: retrying, which stacks duplicate
 * pending rows against the seat cap.
 *
 * Better Auth's client hands back `{ message?, status, statusText }`
 * (`client/vanilla.d.mts`) — `message` is optional and was absent here,
 * but `status` was not. So the status is always available to say
 * *something* truthful when the server gave us no message.
 *
 * There is no request ID to surface: these 500s come out of Better
 * Auth's own handler, not Atlas's `runHandler`, so they carry neither the
 * `requestId` body field nor a correlating response header. Naming the
 * status and the ambiguity is the honest ceiling here.
 */

export interface InviteErrorLike {
  readonly message?: string | null;
  readonly status?: number | null;
  readonly statusText?: string | null;
}

export function inviteErrorMessage(error: InviteErrorLike | null | undefined): string {
  const message = error?.message?.trim();
  if (message) return message;

  const status = typeof error?.status === "number" ? error.status : null;
  if (status === null) {
    // No status at all — the request never got a response (offline, DNS,
    // CORS preflight). Nothing was created, so retrying is safe.
    return "Failed to send invitation — the request didn't reach the server. Check your connection and retry.";
  }

  const statusText = error?.statusText?.trim();
  const label = `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;

  if (status >= 500) {
    // The server received the request and failed partway. The invitation
    // may already exist and the email may already have been sent — that is
    // precisely what #5436 was. Send the admin to the pending list, not to
    // the retry button.
    return (
      `Failed to send invitation (${label}). The server errored after receiving the request, `
      + "so the invitation may already have been created and emailed — check the pending "
      + "invitations below before retrying, and check the API logs."
    );
  }

  return `Failed to send invitation (${label}).`;
}

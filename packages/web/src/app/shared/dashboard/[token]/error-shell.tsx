// The standalone shared-dashboard error state. The shell itself (layout + the
// #4690 CTA policy: `login-required` and only it produces the login redirect
// back to the shared view) is shared with the conversation surface via
// `../../error-shell.tsx` (#4719); this wrapper binds it to the dashboard
// share path. Copy + which actions to show come from `resolveErrorContent`
// (`error-content.ts`).

import { ErrorShell as SharedErrorShell } from "../../error-shell";
import type { ErrorContent } from "./error-content";

export function ErrorShell({ token, content }: { token: string; content: ErrorContent }) {
  return <SharedErrorShell sharePath={`/shared/dashboard/${token}`} content={content} />;
}

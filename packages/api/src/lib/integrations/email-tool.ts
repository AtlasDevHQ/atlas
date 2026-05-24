/**
 * Email LazyPluginLoader builder + agent-loop `sendEmail` tool.
 *
 * First per-Workspace lazy-plugin tool. The wiring pattern this module
 * establishes is the seam Salesforce / Jira / future form-installed
 * integrations will use to expose actions to the agent loop:
 *
 *   1. {@link createEmailLazyBuilder} reads `workspace_plugins.config`
 *      via {@link lazyPluginLoader}, decrypts secret-marked fields via
 *      {@link decryptSecretFields} keyed on the shared
 *      {@link EMAIL_SECRET_FIELDS_SCHEMA}, and constructs a cached
 *      nodemailer transport per Workspace.
 *   2. {@link sendEmailTool} (registered globally with `defaultRegistry`)
 *      resolves the active `workspaceId` at execute time from
 *      {@link getRequestContext}, dispatches through
 *      {@link lazyPluginLoader.getOrInstantiate}, and surfaces five
 *      distinct status discriminants to the agent so the model can
 *      self-correct or stop looping:
 *
 *        - **`sent`** — happy path; carries `messageId`.
 *        - **`no_workspace`** — request had no `activeOrganizationId`.
 *          The user can't fix this by installing — they need to open a
 *          workspace-scoped session. Distinct from `no_install` because
 *          the remediation differs (workspace selection vs admin install).
 *        - **`no_install`** — actionable "install at /admin/integrations"
 *          message. Triggered when the Workspace has no `enabled` row in
 *          `workspace_plugins` for `catalog:email`.
 *        - **`decrypt_failure`** — surfaces `requestId` so ops can
 *          correlate. Triggered when {@link decryptSecretFields} throws
 *          (e.g. a dropped key version after a rotation that didn't
 *          cycle through this Workspace's stored config). Terminal —
 *          retry won't help until the keyset is fixed.
 *        - **`misconfigured`** — `LazyPluginBuilderMissingError` from the
 *          loader. The catalog row is installed but the boot DAG never
 *          registered the builder — an operator-side bug. Distinct from
 *          `send_failure` because retrying won't recover; an operator
 *          must investigate.
 *        - **`send_failure`** — wraps the underlying nodemailer error
 *          (scrubbed via `errorMessage()` so connection strings or
 *          credentials embedded in upstream error text don't leak to
 *          the agent). The agent can retry or surface to the user.
 *
 * Workspace context resolution: read from {@link getRequestContext}'s
 * `user.activeOrganizationId`. Tool registration happens at boot;
 * workspace presence is NOT checked at registration time — the tool is
 * always discoverable, and the per-Workspace "is it installed" gate
 * runs at execute time. This means the agent's tool-list stays stable
 * across Workspaces and the install-state check is at-most-one DB
 * round-trip (the loader caches).
 *
 * Transport caching: nodemailer SMTP transports hold a connection
 * pool. {@link lazyPluginLoader} caches the `PluginLike` we return
 * per `(workspaceId, catalogId)`, so a hot Workspace doesn't rebuild
 * its transport on every tool call. The {@link instance.teardown}
 * hook calls `transport.close()` so cache eviction (from a disconnect
 * or a config update) actually closes the underlying TCP / TLS
 * sockets.
 *
 * Coexistence with `sendEmailReport`: the existing operator-env-
 * configured Resend plugin (`plugins/email/`) keeps its global
 * `sendEmailReport` tool. The new lazy-built per-Workspace tool is
 * named `sendEmail` so both can register without collision. Multi-
 * tenant Workspaces that install their own SMTP server reach for
 * `sendEmail`; single-tenant operators that pre-wire Resend keep
 * `sendEmailReport`.
 *
 * @see ./install/email-secret-schema.ts — shared form + secret schema
 * @see ./install/email-form-handler.ts — write path (encrypts the same fields)
 * @see ../plugins/lazy-loader.ts — per-Workspace caching seam
 * @see ../tools/registry.ts — `defaultRegistry` registration site
 */

import nodemailer, {
  type SendMailOptions,
  type Transporter,
} from "nodemailer";
import { tool } from "ai";
import { z } from "zod";

import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { decryptSecretFields } from "@atlas/api/lib/plugins/secrets";
import {
  lazyPluginLoader,
  LazyPluginBuilderMissingError,
  LazyPluginInstallNotFoundError,
  type LazyPluginBuilder,
  type LazyPluginBuilderArgs,
  type LazyPluginLoader,
} from "@atlas/api/lib/plugins/lazy-loader";
import type { PluginLike } from "@atlas/api/lib/plugins/registry";
import {
  EMAIL_CATALOG_ID,
  EMAIL_SECRET_FIELDS_SCHEMA,
} from "./install/email-secret-schema";

const log = createLogger("integrations.email.tool");

// ---------------------------------------------------------------------------
// Decrypt-failure error — distinct from the loader's
// {@link LazyPluginInstallNotFoundError} so the tool's execute path can
// surface a requestId in the agent-visible payload.
// ---------------------------------------------------------------------------

export class EmailDecryptFailureError extends Error {
  readonly _tag = "EmailDecryptFailureError" as const;
  readonly workspaceId: string;
  constructor(workspaceId: string, cause: unknown) {
    // Plain narrow rather than `errorMessage()` — the audit scrubber's
    // contract excludes `throw new Error(...)` constructors (see
    // `audit/error-scrub.ts` JSDoc) so the original throw stays
    // inspectable. The agent-visible surface in the tool path below
    // does scrub via `errorMessage()` separately.
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Email install decrypt failed for workspace ${workspaceId}: ${causeMessage}`);
    this.name = "EmailDecryptFailureError";
    this.workspaceId = workspaceId;
    if (cause instanceof Error) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Decrypted SMTP config — narrow shape the builder hands to nodemailer.
// ---------------------------------------------------------------------------

interface DecryptedSmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly fromAddress: string;
  readonly secure: boolean;
}

function readString(config: Record<string, unknown>, key: string): string | null {
  const v = config[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readNumber(config: Record<string, unknown>, key: string): number | null {
  const v = config[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(
  config: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const v = config[key];
  if (typeof v === "boolean") return v;
  return fallback;
}

/**
 * Parse the decrypted JSONB row into a strict SMTP config. We don't
 * re-run the full Zod form schema here because the row was already
 * validated at install time — re-validating with `.strict()` would
 * reject any field the form schema gains in a later release before
 * the migration backfills.
 *
 * Returns `null` when a required field is missing, so the builder can
 * raise a clear "install row is malformed" error rather than throwing
 * a deep-stack Zod exception out of the tool path.
 */
function parseDecryptedConfig(
  config: Record<string, unknown>,
): DecryptedSmtpConfig | null {
  const host = readString(config, "host");
  const port = readNumber(config, "port");
  const username = readString(config, "username");
  const password = readString(config, "password");
  const fromAddress = readString(config, "fromAddress");
  if (!host || port === null || !username || !password || !fromAddress) return null;
  return {
    host,
    port,
    username,
    password,
    fromAddress,
    secure: readBoolean(config, "secure", true),
  };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Public shape of the lazy-built Email plugin instance. */
export interface EmailPluginInstance extends PluginLike {
  /** Send a message via the cached transport. Returns nodemailer's `info` envelope. */
  sendEmail(args: {
    to: readonly string[];
    subject: string;
    body: string;
  }): Promise<{ messageId: string | undefined; envelope: unknown }>;
}

/**
 * Test seam — production wiring leaves this undefined and the builder
 * calls {@link nodemailer.createTransport} directly. Tests pass an
 * override that returns a buffered transport (`streamTransport`) or a
 * recording stub so the builder doesn't reach out to a real SMTP relay.
 */
export interface EmailLazyBuilderOptions {
  readonly createTransport?: typeof nodemailer.createTransport;
}

/**
 * Factory returning a {@link LazyPluginBuilder} for `catalog:email`.
 * Mirrors the Salesforce / Jira builder shape so the registration site
 * in {@link register.ts} treats every lazy-built integration uniformly.
 */
export function createEmailLazyBuilder(
  options: EmailLazyBuilderOptions = {},
): LazyPluginBuilder {
  const createTransport = options.createTransport ?? nodemailer.createTransport;

  return async (args: LazyPluginBuilderArgs): Promise<EmailPluginInstance> => {
    const { workspaceId, config } = args;

    let decrypted: Record<string, unknown>;
    try {
      decrypted = decryptSecretFields(config, EMAIL_SECRET_FIELDS_SCHEMA);
    } catch (err) {
      log.error(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "Failed to decrypt Email install config — refusing to instantiate transport",
      );
      throw new EmailDecryptFailureError(workspaceId, err);
    }

    const smtp = parseDecryptedConfig(decrypted);
    if (!smtp) {
      throw new Error(
        `LazyPluginLoader: Email install for workspace ${workspaceId} is missing required fields (host/port/username/password/fromAddress) — disconnect + reinstall`,
      );
    }

    const transport: Transporter = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.username, pass: smtp.password },
    });

    log.info(
      {
        workspaceId,
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        fromAddress: smtp.fromAddress,
      },
      "Email lazy plugin instantiated",
    );

    const instance: EmailPluginInstance = {
      id: `email:${workspaceId}`,
      types: ["action"] as const,
      version: "0.1.0",
      name: "Email",
      config: { host: smtp.host, port: smtp.port, fromAddress: smtp.fromAddress },

      async sendEmail({ to, subject, body }): Promise<{ messageId: string | undefined; envelope: unknown }> {
        const message: SendMailOptions = {
          from: smtp.fromAddress,
          to: Array.from(to),
          subject,
          html: body,
        };
        const info = await transport.sendMail(message);
        return {
          messageId: typeof info.messageId === "string" ? info.messageId : undefined,
          envelope: info.envelope,
        };
      },

      async teardown(): Promise<void> {
        // nodemailer SMTP transports own a TCP / TLS pool. Closing on
        // evict is what keeps long-running processes from leaking
        // sockets across config-update + reinstall cycles. Other
        // transports (jsonTransport, streamTransport) noop on close —
        // the typed signature is `() => void` either way.
        try {
          transport.close();
        } catch (err) {
          log.warn(
            { workspaceId, err: err instanceof Error ? err.message : String(err) },
            "Email transport.close() threw during teardown — instance dropped anyway",
          );
        }
      },
    };

    return instance;
  };
}

// ---------------------------------------------------------------------------
// `sendEmail` agent tool
// ---------------------------------------------------------------------------

export const SEND_EMAIL_DESCRIPTION = `### Send Email
Use sendEmail to deliver a message via the workspace's installed SMTP transport:
- Provide one or more recipient email addresses
- Include a clear subject line
- Format the body as HTML for rich formatting
- The Email integration must be installed for the workspace at /admin/integrations
- Distinct from sendEmailReport (operator-configured Resend); pick whichever the workspace has set up`;

/**
 * Test seam — production calls go through the singleton
 * `lazyPluginLoader`. Tests inject a fake loader (and a fake context
 * source) so the tool's execute path can be exercised without booting
 * the loader.
 */
export interface SendEmailToolDeps {
  readonly loader?: Pick<LazyPluginLoader, "getOrInstantiate">;
  readonly resolveWorkspaceId?: () => string | undefined;
  readonly resolveRequestId?: () => string | undefined;
}

const SendEmailInput = z.object({
  to: z
    .array(z.string().email())
    .min(1, "to must contain at least one recipient"),
  subject: z.string().min(1, "subject must not be empty"),
  body: z.string().min(1, "body must not be empty"),
});

type SendEmailExecuteResult =
  | {
      status: "sent";
      messageId: string | undefined;
      envelope: unknown;
    }
  | {
      // Request had no `activeOrganizationId`. The user can't install
      // their way out — they need a workspace-scoped session. Kept
      // distinct from `no_install` so the agent's remediation copy
      // doesn't mislead a user who already has the integration.
      status: "no_workspace";
      message: string;
    }
  | {
      status: "no_install";
      message: string;
    }
  | {
      status: "decrypt_failure";
      message: string;
      requestId: string | undefined;
    }
  | {
      // Catalog row + workspace install both present, but the boot DAG
      // didn't register a builder for `catalog:email`. Distinct from
      // `send_failure` because retry won't help — operator-side fix
      // (re-deploy, check `register.ts`).
      status: "misconfigured";
      message: string;
      requestId: string | undefined;
    }
  | {
      status: "send_failure";
      message: string;
      requestId: string | undefined;
    };

function defaultResolveWorkspaceId(): string | undefined {
  return getRequestContext()?.user?.activeOrganizationId;
}

function defaultResolveRequestId(): string | undefined {
  return getRequestContext()?.requestId;
}

export function createSendEmailTool(deps: SendEmailToolDeps = {}) {
  const loader = deps.loader ?? lazyPluginLoader;
  const resolveWorkspaceId = deps.resolveWorkspaceId ?? defaultResolveWorkspaceId;
  const resolveRequestId = deps.resolveRequestId ?? defaultResolveRequestId;

  return tool({
    description:
      "Send an email via the workspace's installed SMTP transport (Email integration).",
    inputSchema: SendEmailInput,
    execute: async ({ to, subject, body }): Promise<SendEmailExecuteResult> => {
      const workspaceId = resolveWorkspaceId();
      if (!workspaceId) {
        // No active workspace — auth wiring problem or a request that
        // never stamped `activeOrganizationId` (unauthenticated chat,
        // pre-org-pick session). The user can't fix this by installing
        // the integration; pointing them at /admin/integrations would
        // be a dead end. Kept as a distinct status so the agent's
        // remediation copy stays correct.
        log.warn(
          { requestId: resolveRequestId() },
          "sendEmail invoked with no active workspaceId",
        );
        return {
          status: "no_workspace",
          message:
            "No workspace is selected for this request. Open a workspace-scoped session before sending email.",
        };
      }

      let instance: EmailPluginInstance;
      try {
        const raw = await loader.getOrInstantiate(workspaceId, EMAIL_CATALOG_ID);
        instance = raw as EmailPluginInstance;
      } catch (err) {
        if (err instanceof LazyPluginInstallNotFoundError) {
          log.info(
            { workspaceId },
            "sendEmail rejected — workspace has no Email install",
          );
          return {
            status: "no_install",
            message:
              "Install the Email integration at /admin/integrations before sending. No workspace_plugins row is enabled for catalog:email.",
          };
        }
        if (err instanceof EmailDecryptFailureError) {
          const requestId = resolveRequestId();
          log.error(
            { workspaceId, requestId, err: err.message },
            "sendEmail aborted — Email install decrypt failure",
          );
          return {
            status: "decrypt_failure",
            message: `Email install credentials could not be decrypted for this workspace. Verify the encryption keyset and retry; request id ${requestId ?? "<unset>"}.`,
            requestId,
          };
        }
        if (err instanceof LazyPluginBuilderMissingError) {
          // Catalog + workspace install present, but no builder. This
          // is the boot-DAG-misconfigured failure mode — `register.ts`
          // pairs the form handler with the builder, so the only way
          // this fires is if `registerBuiltinInstallHandlers` itself
          // didn't run. Distinct status so the agent stops looping and
          // surfaces an operator-actionable error.
          const requestId = resolveRequestId();
          log.error(
            { workspaceId, requestId, err: err.message },
            "sendEmail aborted — Email lazy builder not registered (boot DAG issue)",
          );
          return {
            status: "misconfigured",
            message: `Email integration is installed but no builder is registered for catalog:email. This is a deploy-side configuration issue; contact your operator. Request id ${requestId ?? "<unset>"}.`,
            requestId,
          };
        }
        // Anything else — config missing fields, builder throwing on
        // construction. Surfaces as send_failure so the agent has
        // something actionable. Messages are scrubbed via
        // `errorMessage()` so a connection string embedded in an
        // upstream error doesn't leak to the agent's tool-output.
        const requestId = resolveRequestId();
        log.error(
          { workspaceId, requestId, err: err instanceof Error ? err.message : String(err) },
          "sendEmail aborted — failed to instantiate Email plugin",
        );
        return {
          status: "send_failure",
          message: `Could not initialise the Email integration: ${errorMessage(err)}`,
          requestId,
        };
      }

      try {
        const { messageId, envelope } = await instance.sendEmail({ to, subject, body });
        log.info(
          { workspaceId, messageId, recipientCount: to.length },
          "sendEmail delivered",
        );
        return { status: "sent", messageId, envelope };
      } catch (err) {
        const requestId = resolveRequestId();
        log.error(
          { workspaceId, requestId, err: err instanceof Error ? err.message : String(err) },
          "sendEmail transport.sendMail failed",
        );
        return {
          status: "send_failure",
          // `errorMessage()` scrubs connection-string-shaped substrings
          // from the underlying error text (a stray SMTP proxy error
          // like "Cannot connect to socks5://user:pass@proxy:1080"
          // would leak creds otherwise) and truncates to 512 chars.
          message: `Email send failed: ${errorMessage(err)}`,
          requestId,
        };
      }
    },
  });
}

/** Production tool instance, registered with `defaultRegistry` in `tools/registry.ts`. */
export const sendEmailTool = createSendEmailTool();

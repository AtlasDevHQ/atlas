# PGP Key Procedure for security@useatlas.dev (Internal)

> This is an internal operations document. It is NOT published to the docs site.
>
> Tracking issue: [#1923](https://github.com/AtlasDevHQ/atlas/issues/1923).

## Why this exists

Per RFC 9116, `apps/www/public/.well-known/security.txt` advertises an
`Encryption:` field pointing at a PGP public key. Researchers who want to send
sensitive vulnerability reports use that key to encrypt mail to
`security@useatlas.dev`. Atlas does not yet have a real keypair for that
mailbox — the URL is committed, the file at the URL still has to be generated
and dropped in by a human operator on a secure host.

A PGP key is only useful if **someone is actually checking the inbox and
reading encrypted reports**. Confirm the operational owner of `security@`
before generating. A fingerprint that rotates without notice is worse than no
key.

## Prerequisites

- Operator has root or admin access to a trusted host (workstation, NOT a
  shared CI runner, NOT a container, NOT a cloud shell).
- Operator owns or controls the `security@useatlas.dev` mailbox.
- A password manager / secret manager (1Password, Bitwarden, GCP Secret
  Manager, AWS Secrets Manager) is available for storing the **private** key
  and the revocation certificate.
- `gpg` 2.2+ installed (`gpg --version`).

## Step 1 — Generate the keypair

Run this on the secure host. **The private key never enters this repo and
never enters CI.**

```bash
gpg --full-generate-key
```

Recommended choices:

| Prompt | Answer | Why |
| --- | --- | --- |
| Key type | `(9) ECC and ECC` | Modern curve-based key; smaller, faster, same security as 4096 RSA. If your version of gpg doesn't offer ECC, fall back to `(1) RSA and RSA` with `4096` bits. |
| Curve | `(1) Curve 25519` | Default Ed25519 / Cv25519; widely supported by mail clients. |
| Expiration | `2y` (two years) | Long enough to be useful, short enough that rotation is forced regularly. Annual rotation is finer; pick one and stick to it. |
| Real name | `Atlas Security` | Identifies the role, not a person. |
| Email | `security@useatlas.dev` | Must match the mailbox advertised in `Contact:`. |
| Comment | _empty_ | Don't put a year or environment in the UID; rotation should not break consumers' verification. |
| Passphrase | strong, randomly-generated, stored in 1Password | gpg requires one. The mailbox owner needs it to decrypt incoming mail. |

After generation, list to confirm and capture the long fingerprint:

```bash
gpg --list-keys --keyid-format=long security@useatlas.dev
gpg --fingerprint security@useatlas.dev
```

Copy the **40-character fingerprint** (e.g. `ABCD 1234 5678 …`). You will
publish this in two places: `security.txt` (as a comment) and the team's
Notion / 1Password entry (so future operators can verify they have the right
key after rotation).

## Step 2 — Generate a revocation certificate

If the key is ever compromised or the mailbox owner loses the passphrase, you
need a pre-built revocation certificate to publish a tombstone. Generate it
**now**, while you still have the private key:

```bash
gpg --output atlas-security-revocation.asc --gen-revoke security@useatlas.dev
```

Pick a generic reason ("0 = No reason specified") so the certificate is usable
later regardless of the actual rotation cause. **Store this revocation cert in
the password manager next to the private key.** Do not commit it to the repo.

## Step 3 — Export the public key as ASCII-armored .asc

```bash
gpg --armor --export security@useatlas.dev > atlas-security.asc
```

Sanity-check the output:

```bash
head -1 atlas-security.asc   # should print: -----BEGIN PGP PUBLIC KEY BLOCK-----
tail -1 atlas-security.asc   # should print: -----END PGP PUBLIC KEY BLOCK-----
```

## Step 4 — Drop the public key into the repo

The `Encryption:` URL in `apps/www/public/.well-known/security.txt` already
points at:

```
https://www.useatlas.dev/.well-known/atlas-security.asc
```

Place the exported file at:

```
apps/www/public/.well-known/atlas-security.asc
```

`apps/www` serves the `public/` tree as static assets, so the file is reachable
at the URL above as soon as the next www deploy lands. No code changes needed.

## Step 5 — Update legal copy

Edit `apps/www/src/app/privacy/page.tsx`, Section 9 (Security). The file has a
comment block right above the current "PGP key on request" line that contains
the exact replacement strings — swap the legal sentence and the plain-english
sentence as instructed there.

After the edit, both occurrences of `PGP key on request` should be gone (run
`grep -rn "PGP key on request" apps/www/src/` to confirm).

## Step 6 — Publish the fingerprint somewhere users can find it

In addition to the .asc file, publish the 40-character fingerprint as plain
text on a page users can verify against. Two reasonable spots:

- A code comment at the top of `security.txt` (so a curl is enough to verify).
- An update to `/security` or `/privacy#security` mentioning "PGP fingerprint:
  ABCD 1234 …".

This is what defeats man-in-the-middle attacks against the .asc download — a
researcher who pulled the key over hostile DNS can compare the fingerprint
against the value the company publishes elsewhere (Twitter bio, employee
emails, signed git commits, etc.).

## Step 7 — Verify end-to-end

From any machine **other than** the one that generated the key:

```bash
curl -fsSL https://www.useatlas.dev/.well-known/atlas-security.asc | gpg --import
gpg --fingerprint security@useatlas.dev
```

Compare the printed fingerprint against the value you published in Step 6.
They must match exactly.

Send a test encrypted email to `security@useatlas.dev` from a non-Atlas
account, confirm the mailbox owner can decrypt it.

## Rotation cadence

- **Renew the expiration before it lapses.** A few weeks before the
  `Expires:` date in `security.txt` (currently 2027-04-26), generate a new
  keypair via the same steps and replace `atlas-security.asc`. Old senders
  will still see the old fingerprint cached; that's fine — gpg handles
  fingerprint rotation cleanly as long as the new key has the same UID.
- **Rotate immediately on suspected compromise.** Use the revocation
  certificate from Step 2, publish the new key, and announce the new
  fingerprint on the same channels you used in Step 6.
- **Tracking issue.** Keep a calendar reminder (or open a `chore` issue) ~30
  days before the `Expires:` date and ~30 days before key expiration,
  whichever is sooner. The `Expires:` reminder is also called out in the
  scope notes on issue #1923.

## What never enters the repo

- The private key (`secring.gpg`, exported `.asc` of the secret half, anything
  produced by `gpg --export-secret-keys`).
- The passphrase.
- The revocation certificate (`atlas-security-revocation.asc`).

If any of those land in the repo accidentally, treat the key as compromised:
revoke immediately, generate a new one, force-push the bad commit out of
history (or, better, keep history and trust that revocation works as
designed), and update everything.

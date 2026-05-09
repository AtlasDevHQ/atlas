/**
 * Branded `string` for OAuth bearer credentials shared by both
 * consumers. The brand carries no runtime cost; its purpose is to
 * surface bearer-handling code in code review (`accessToken: Bearer`
 * next to a `console.log` is a smell) and to keep the secret-vs-non-
 * secret distinction visible in the type, not just in trailing
 * comments.
 */
export type Bearer = string & { readonly __brand: "Bearer" };

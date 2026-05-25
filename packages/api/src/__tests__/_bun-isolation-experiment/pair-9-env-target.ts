// Sibling of pair-8-env-target with a pair-9-scoped env key so the two
// fixtures don't share state when running in the same suite.
export const envAtLoad: string | undefined =
  process.env._PAIR_9_PROBE_VAR;

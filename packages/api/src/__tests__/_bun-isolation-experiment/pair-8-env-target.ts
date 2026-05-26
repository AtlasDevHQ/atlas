// Module-load-time env reader. Mirrors the production
// src/api/index.ts:251 pattern where a top-level env check decides
// whether to mount a route. The export is captured at module load and
// frozen — tests can only observe the value the env had AT load time.
export const envAtLoad: string | undefined =
  process.env._PAIR_8_PROBE_VAR;

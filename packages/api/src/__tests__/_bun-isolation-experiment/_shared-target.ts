// Real module that pair 1's leaker mocks and pair 1's observer re-imports
// to check if the mock survived. Kept trivial — the value of `truth()` is
// what the assertion hinges on.
export function truth(): string {
  return "real";
}

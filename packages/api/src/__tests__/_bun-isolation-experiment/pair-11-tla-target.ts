// Module with its own top-level await. Under spec, importers that
// top-level-await this module observe `ready === "DONE"`.
console.error("[TLA-TARGET] top reached");
await new Promise<void>((resolve) => setTimeout(resolve, 50));
console.error("[TLA-TARGET] after await");
export const ready = "DONE";
console.error("[TLA-TARGET] export assigned");

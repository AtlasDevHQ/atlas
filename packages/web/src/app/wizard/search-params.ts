import { parseAsInteger, parseAsString } from "nuqs";

// Wizard is 4 steps after the 1.3.0 design pass: Datasource (1) → Tables (2) →
// Review (3) → Done (4). Step 4 from the old 5-step flow (Preview) was
// dropped — it duplicated what the chat surface already does on Done.
export const wizardSearchParams = {
  step: parseAsInteger.withDefault(1),
  connectionId: parseAsString.withDefault(""),
};

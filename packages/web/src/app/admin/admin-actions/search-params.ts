import { parseAsInteger } from "nuqs";

export const adminActionsSearchParams = {
  page: parseAsInteger.withDefault(1),
};

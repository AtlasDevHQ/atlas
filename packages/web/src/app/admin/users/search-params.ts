import { parseAsString, parseAsInteger } from "nuqs";

export const usersSearchParams = {
  search: parseAsString.withDefault(""),
  role: parseAsString.withDefault(""),
  page: parseAsInteger.withDefault(1),
};

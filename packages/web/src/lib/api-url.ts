export const API_URL = (process.env.NEXT_PUBLIC_ATLAS_API_URL ?? "").replace(/\/+$/, "");
export const IS_CROSS_ORIGIN = !!API_URL;

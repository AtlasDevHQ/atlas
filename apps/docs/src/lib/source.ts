import { docs } from "@/../.source/server";
import { loader } from "fumadocs-core/source";
import { openapiPlugin } from "fumadocs-openapi/server";

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  plugins: [openapiPlugin()],
});

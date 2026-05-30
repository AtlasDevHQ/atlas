/**
 * `openapi-spec` — the single parse boundary for OpenAPI 3.x documents.
 *
 * `buildOperationGraph` is a PURE function (no I/O, no mocks, no agent logic):
 * it takes an already-parsed OpenAPI 3.x JSON document and emits the normalized
 * {@link OperationGraph} every downstream consumer reads. Past this boundary,
 * nobody walks a `$ref` string or a raw `paths.*` object again.
 *
 * Fail-loud contract (PRD #2868 risk R1): a structurally malformed document, a
 * missing `operationId`, or an unresolvable / unsupported `$ref` throws
 * {@link OpenApiSpecError} — the function never returns a half-built graph.
 *
 * Deliberately NOT fail-loud on:
 *  - Vendor extensions (`x-*` keys). Object-internal `x-*` keys are ignored
 *    because every walker reads only a known set of keys; the one place an
 *    `x-*` *sibling entry* legally appears (the `paths` object) is explicitly
 *    skipped. Real specs (Stripe, Twenty) are full of extensions — rejecting
 *    them would make "normalize Stripe's spec" impossible. The ONE extension this
 *    builder reads is `x-atlas-side-effecting` on an operation (#3008), surfaced
 *    as {@link Operation.sideEffecting}; all other `x-*` keys are still ignored.
 *  - Circular `$ref`s through named components (Twenty's Person ↔ NoteTarget).
 *    These are REQUIRED to resolve (acceptance criterion). We resolve a named
 *    `$ref` to a pointer node (`{ ref: "Name" }`) rather than inlining, so the
 *    graph stays finite while the relationship remains traversable.
 *
 * Scope (slice 0): walks `paths.*`, `components.schemas.*`,
 * `components.parameters.*`, `components.securitySchemes.*` (plus `requestBodies`
 * / `responses` when referenced). Deferred to later slices: semantic-YAML
 * generation (1b), pagination (4), `validateRestOperation` (5).
 */
import {
  HTTP_METHODS,
  OpenApiSpecError,
  type HttpMethod,
  type Operation,
  type OperationGraph,
  type OperationParameter,
  type OperationRequestBody,
  type OperationResponse,
  type OpenApiSchema,
  type OpenApiSchemaInline,
  type ParameterLocation,
  type SecurityScheme,
  type ServerInfo,
  type SpecInfo,
} from "./types";

// ─────────────────────────────────────────────────────────────────────
//  Unknown-navigation helpers (no `any`)
// ─────────────────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  $ref resolution
// ─────────────────────────────────────────────────────────────────────

/** A parsed local component reference, e.g. `#/components/schemas/Person`. */
interface ParsedRef {
  readonly section: string;
  readonly name: string;
}

/**
 * Parse a `$ref` string. Only local component refs of the form
 * `#/components/<section>/<name>` are supported; external files
 * (`other.json#/...`) and non-component pointers throw `unsupported-ref` so a
 * consumer never receives a node we silently failed to resolve.
 */
function parseRef(ref: string, location: string): ParsedRef {
  const match = /^#\/components\/([^/]+)\/(.+)$/.exec(ref);
  if (!match) {
    throw new OpenApiSpecError({
      reason: "unsupported-ref",
      location,
      message:
        `Unsupported $ref "${ref}" at ${location}. Only local component refs of the form ` +
        `"#/components/<section>/<name>" are supported (external files and non-component ` +
        `pointers are not resolved in this slice).`,
    });
  }
  // A `$ref` name may itself contain `~1`-escaped slashes; decode per RFC 6901.
  const name = match[2].replace(/~1/g, "/").replace(/~0/g, "~");
  return { section: match[1], name };
}

// ─────────────────────────────────────────────────────────────────────
//  Builder (closes over the document's component registries)
// ─────────────────────────────────────────────────────────────────────

class GraphBuilder {
  private readonly components: JsonObject;
  private readonly schemaNames: ReadonlySet<string>;
  private readonly securityNames: ReadonlySet<string>;

  constructor(
    components: JsonObject,
    private readonly security: ReadonlyMap<string, SecurityScheme>,
  ) {
    this.components = components;
    this.schemaNames = new Set(
      isObject(components.schemas) ? Object.keys(components.schemas) : [],
    );
    this.securityNames = new Set(security.keys());
  }

  /** Look up a raw component object by section + name, resolving one `$ref` hop. */
  private rawComponent(section: string, name: string, location: string): JsonObject {
    const bucket = this.components[section];
    const node = isObject(bucket) ? bucket[name] : undefined;
    if (!isObject(node)) {
      throw new OpenApiSpecError({
        reason: "unresolved-ref",
        location,
        message: `$ref target "#/components/${section}/${name}" referenced at ${location} does not exist.`,
      });
    }
    return node;
  }

  // ── Schemas ────────────────────────────────────────────────────────

  /**
   * Normalize a raw schema node. A `$ref` to a named component schema collapses
   * to a pointer (`{ ref }`) — no recursion into the target, which keeps cycles
   * finite. Inline schemas are walked in full (they cannot be circular).
   */
  walkSchema(raw: unknown, location: string): OpenApiSchema {
    if (!isObject(raw)) {
      throw new OpenApiSpecError({
        reason: "invalid-structure",
        location,
        message: `Expected a schema object at ${location}, got ${describe(raw)}.`,
      });
    }

    const refStr = asString(raw.$ref);
    if (refStr !== undefined) {
      const { section, name } = parseRef(refStr, location);
      if (section !== "schemas") {
        throw new OpenApiSpecError({
          reason: "unsupported-ref",
          location,
          message: `Schema position at ${location} references "#/components/${section}/${name}"; only schema refs are valid here.`,
        });
      }
      if (!this.schemaNames.has(name)) {
        throw new OpenApiSpecError({
          reason: "unresolved-ref",
          location,
          message: `Schema $ref "#/components/schemas/${name}" at ${location} has no matching component.`,
        });
      }
      return { ref: name };
    }

    const node: Mutable<OpenApiSchemaInline> = {};
    // `type` is a string in 3.0; in 3.1 it may be an array (e.g.
    // ["string", "null"]). Normalize the array form: strip the "null" member
    // into `nullable` and keep the single remaining type. A multi-type union
    // (rare) leaves `type` absent rather than guessing.
    const rawType = raw.type;
    if (typeof rawType === "string") {
      node.type = rawType;
    } else if (Array.isArray(rawType)) {
      const members = rawType.filter((t): t is string => typeof t === "string");
      if (members.includes("null")) node.nullable = true;
      const nonNull = members.filter((t) => t !== "null");
      if (nonNull.length === 1) node.type = nonNull[0];
    }
    const format = asString(raw.format);
    if (format !== undefined) node.format = format;
    const description = asString(raw.description);
    if (description !== undefined) node.description = description;
    if (Array.isArray(raw.enum)) node.enum = raw.enum as ReadonlyArray<unknown>;
    // Explicit 3.0 `nullable` wins over the 3.1 array-derived value if both appear.
    const nullable = asBoolean(raw.nullable);
    if (nullable !== undefined) node.nullable = nullable;
    const required = asStringArray(raw.required);
    if (required !== undefined) node.required = required;

    if (isObject(raw.properties)) {
      const props = new Map<string, OpenApiSchema>();
      for (const [key, value] of Object.entries(raw.properties)) {
        props.set(key, this.walkSchema(value, `${location}.properties.${key}`));
      }
      node.properties = props;
    }

    if (raw.items !== undefined) {
      node.items = this.walkSchema(raw.items, `${location}.items`);
    }

    for (const keyword of ["allOf", "oneOf", "anyOf"] as const) {
      const branch = raw[keyword];
      if (Array.isArray(branch)) {
        node[keyword] = branch.map((sub, i) =>
          this.walkSchema(sub, `${location}.${keyword}[${i}]`),
        );
      }
    }

    return node;
  }

  buildSchemas(): Map<string, OpenApiSchema> {
    const out = new Map<string, OpenApiSchema>();
    const raw = this.components.schemas;
    if (!isObject(raw)) return out;
    for (const name of this.schemaNames) {
      const walked = this.walkSchema(raw[name], `components.schemas.${name}`);
      out.set(name, { ...walked, name });
    }
    return out;
  }

  // ── Parameters ─────────────────────────────────────────────────────

  private normalizeParameter(raw: unknown, location: string): OperationParameter {
    let node = raw;
    if (isObject(raw)) {
      const refStr = asString(raw.$ref);
      if (refStr !== undefined) {
        const { section, name } = parseRef(refStr, location);
        if (section !== "parameters") {
          throw new OpenApiSpecError({
            reason: "unsupported-ref",
            location,
            message: `Parameter position at ${location} references "#/components/${section}/${name}".`,
          });
        }
        node = this.rawComponent("parameters", name, location);
      }
    }

    if (!isObject(node)) {
      throw new OpenApiSpecError({
        reason: "invalid-parameter",
        location,
        message: `Expected a parameter object at ${location}, got ${describe(node)}.`,
      });
    }

    const name = asString(node.name);
    const location_ = asString(node.in);
    if (name === undefined || location_ === undefined) {
      throw new OpenApiSpecError({
        reason: "invalid-parameter",
        location,
        message: `Parameter at ${location} is missing required "name" or "in".`,
      });
    }
    if (!isParameterLocation(location_)) {
      throw new OpenApiSpecError({
        reason: "invalid-parameter",
        location,
        message: `Parameter "${name}" at ${location} has unknown location "in: ${location_}".`,
      });
    }

    const param: Mutable<OperationParameter> = {
      name,
      in: location_,
      // OpenAPI requires `required: true` for path params; coerce defensively.
      required: location_ === "path" ? true : asBoolean(node.required) ?? false,
    };
    const description = asString(node.description);
    if (description !== undefined) param.description = description;
    if (node.schema !== undefined) {
      param.schema = this.walkSchema(node.schema, `${location}.schema`);
    }
    return param;
  }

  /** Merge path-level and operation-level parameters; operation wins on (name, in). */
  private buildParameters(
    pathLevel: unknown,
    opLevel: unknown,
    location: string,
  ): OperationParameter[] {
    const byKey = new Map<string, OperationParameter>();
    const add = (list: unknown, scope: string) => {
      if (!Array.isArray(list)) return;
      list.forEach((raw, i) => {
        const param = this.normalizeParameter(raw, `${location}.${scope}[${i}]`);
        byKey.set(`${param.in}:${param.name}`, param);
      });
    };
    add(pathLevel, "parameters");
    add(opLevel, "parameters");
    return [...byKey.values()];
  }

  // ── Request body & responses (with media-type content maps) ──────────

  private buildContent(raw: unknown, location: string): Map<string, OpenApiSchema> {
    const out = new Map<string, OpenApiSchema>();
    if (!isObject(raw)) return out;
    for (const [mediaType, value] of Object.entries(raw)) {
      if (!isObject(value)) {
        // A present-but-malformed media-type entry must fail loud rather than
        // silently vanish from `content` (R1) — every sibling builder throws.
        throw new OpenApiSpecError({
          reason: "invalid-structure",
          location: `${location}.${mediaType}`,
          message: `Expected a media-type object at ${location}.${mediaType}, got ${describe(value)}.`,
        });
      }
      // A media type with no `schema` is legitimate ("schema not declared") —
      // record nothing rather than failing.
      if (value.schema !== undefined) {
        out.set(mediaType, this.walkSchema(value.schema, `${location}.${mediaType}.schema`));
      }
    }
    return out;
  }

  private buildRequestBody(raw: unknown, location: string): OperationRequestBody | undefined {
    if (raw === undefined) return undefined;
    let node = raw;
    if (isObject(raw)) {
      const refStr = asString(raw.$ref);
      if (refStr !== undefined) {
        const { section, name } = parseRef(refStr, location);
        if (section !== "requestBodies") {
          throw new OpenApiSpecError({
            reason: "unsupported-ref",
            location,
            message: `requestBody at ${location} references "#/components/${section}/${name}".`,
          });
        }
        node = this.rawComponent("requestBodies", name, location);
      }
    }
    if (!isObject(node)) {
      throw new OpenApiSpecError({
        reason: "invalid-structure",
        location,
        message: `Expected a requestBody object at ${location}, got ${describe(node)}.`,
      });
    }
    const body: Mutable<OperationRequestBody> = {
      required: asBoolean(node.required) ?? false,
      content: this.buildContent(node.content, `${location}.content`),
    };
    const description = asString(node.description);
    if (description !== undefined) body.description = description;
    return body;
  }

  private buildResponses(raw: unknown, location: string): Map<string, OperationResponse> {
    const out = new Map<string, OperationResponse>();
    if (!isObject(raw)) return out;
    for (const [status, value] of Object.entries(raw)) {
      let node = value;
      if (isObject(value)) {
        const refStr = asString(value.$ref);
        if (refStr !== undefined) {
          const { section, name } = parseRef(refStr, `${location}.${status}`);
          if (section !== "responses") {
            throw new OpenApiSpecError({
              reason: "unsupported-ref",
              location: `${location}.${status}`,
              message: `Response at ${location}.${status} references "#/components/${section}/${name}".`,
            });
          }
          node = this.rawComponent("responses", name, `${location}.${status}`);
        }
      }
      if (!isObject(node)) {
        // Present-but-malformed response → fail loud. A silent skip would tell a
        // downstream consumer "this operation has no <status> response" when the
        // author actually wrote a broken one (R1).
        throw new OpenApiSpecError({
          reason: "invalid-structure",
          location: `${location}.${status}`,
          message: `Expected a response object at ${location}.${status}, got ${describe(node)}.`,
        });
      }
      const response: Mutable<OperationResponse> = {
        content: this.buildContent(node.content, `${location}.${status}.content`),
      };
      const description = asString(node.description);
      if (description !== undefined) response.description = description;
      out.set(status, response);
    }
    return out;
  }

  // ── Security requirement resolution ─────────────────────────────────

  /**
   * Resolve a `security` requirement list (array of requirement objects) to a
   * deduped list of scheme names (OR-semantics). Every referenced name must be
   * a declared scheme, else `unknown-security-requirement`.
   *
   * A non-object requirement entry (e.g. the common `security: ["bearerAuth"]`
   * string-instead-of-object mistake) fails loud rather than being skipped:
   * silently dropping it could collapse the requirement set to `[]`, which the
   * `Operation.security` contract reads as "no auth" — a security false-negative.
   */
  resolveSecurity(raw: unknown, location: string): string[] {
    if (!Array.isArray(raw)) return [];
    const names: string[] = [];
    const seen = new Set<string>();
    for (const requirement of raw) {
      if (!isObject(requirement)) {
        throw new OpenApiSpecError({
          reason: "invalid-structure",
          location,
          message: `Security requirement at ${location} must be an object mapping scheme names to scopes, got ${describe(requirement)}.`,
        });
      }
      for (const name of Object.keys(requirement)) {
        if (!this.securityNames.has(name)) {
          throw new OpenApiSpecError({
            reason: "unknown-security-requirement",
            location,
            message: `Security requirement "${name}" at ${location} is not declared in components.securitySchemes.`,
          });
        }
        if (!seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
      }
    }
    return names;
  }

  // ── Operations ──────────────────────────────────────────────────────

  buildOperations(
    paths: JsonObject,
    docSecurity: string[],
    docHasSecurity: boolean,
  ): Map<string, Operation> {
    const out = new Map<string, Operation>();
    for (const [pathKey, pathItemRaw] of Object.entries(paths)) {
      if (pathKey.startsWith("x-")) continue; // vendor extension sibling at paths level
      if (!isObject(pathItemRaw)) {
        throw new OpenApiSpecError({
          reason: "invalid-structure",
          location: `paths.${pathKey}`,
          message: `Path item at paths.${pathKey} must be an object, got ${describe(pathItemRaw)}.`,
        });
      }
      // A path-item-level `$ref` (legal OpenAPI) is not supported in this slice —
      // fail loud rather than silently drop every operation under the path.
      if (asString(pathItemRaw.$ref) !== undefined) {
        throw new OpenApiSpecError({
          reason: "unsupported-ref",
          location: `paths.${pathKey}`,
          message: `Path item at paths.${pathKey} uses a $ref; path-item references are not resolved in this slice.`,
        });
      }
      const pathLevelParams = pathItemRaw.parameters;

      for (const method of HTTP_METHODS) {
        const opRaw = pathItemRaw[method];
        if (opRaw === undefined) continue;
        const opLocation = `paths.${pathKey}.${method}`;
        if (!isObject(opRaw)) {
          throw new OpenApiSpecError({
            reason: "invalid-structure",
            location: opLocation,
            message: `Expected an operation object at ${opLocation}, got ${describe(opRaw)}.`,
          });
        }

        const operationId = asString(opRaw.operationId);
        if (operationId === undefined || operationId.length === 0) {
          throw new OpenApiSpecError({
            reason: "missing-operation-id",
            location: opLocation,
            message:
              `Operation ${method.toUpperCase()} ${pathKey} is missing an "operationId". ` +
              `Every operation must declare one so it can be addressed, validated, and described.`,
          });
        }
        if (out.has(operationId)) {
          throw new OpenApiSpecError({
            reason: "duplicate-operation-id",
            location: opLocation,
            message: `Duplicate operationId "${operationId}" at ${opLocation}; operationIds must be unique across the document.`,
          });
        }

        const opHasSecurity = "security" in opRaw;
        const security = opHasSecurity
          ? this.resolveSecurity(opRaw.security, `${opLocation}.security`)
          : docHasSecurity
            ? docSecurity
            : [];

        const operation: Mutable<Operation> = {
          operationId,
          method: method.toUpperCase() as HttpMethod,
          path: pathKey,
          tags: asStringArray(opRaw.tags) ?? [],
          parameters: this.buildParameters(pathLevelParams, opRaw.parameters, opLocation),
          security,
          responses: this.buildResponses(opRaw.responses, `${opLocation}.responses`),
        };
        const summary = asString(opRaw.summary);
        if (summary !== undefined) operation.summary = summary;
        const description = asString(opRaw.description);
        if (description !== undefined) operation.description = description;
        // #3008: the `x-atlas-side-effecting: true` vendor extension escalates a
        // read-method operation (a mutating RPC-over-GET) to the write path. Only
        // an explicit `true` sets it — an explicit `false` (or a missing value)
        // leaves classification to the method, and the flag can never DOWNGRADE a
        // write method to a read. A present-but-non-boolean value (e.g. the string
        // "true" from a YAML/templating round-trip) is REJECTED, not silently
        // dropped: this is a security-load-bearing signal, so we fail loud here —
        // matching every other malformed scalar in this parser — rather than let a
        // mistyped flag leave a side-effecting GET classified as an unconfirmed
        // read (the write-safety false negative this feature exists to prevent).
        if ("x-atlas-side-effecting" in opRaw) {
          const sideEffecting = asBoolean(opRaw["x-atlas-side-effecting"]);
          if (sideEffecting === undefined) {
            throw new OpenApiSpecError({
              reason: "invalid-structure",
              location: `${opLocation}.x-atlas-side-effecting`,
              message:
                `x-atlas-side-effecting at ${opLocation} must be a boolean, got ` +
                `${describe(opRaw["x-atlas-side-effecting"])}. A mistyped value (e.g. the ` +
                `string "true") would silently leave a side-effecting GET ungated.`,
            });
          }
          if (sideEffecting) operation.sideEffecting = true;
        }
        const requestBody = this.buildRequestBody(opRaw.requestBody, `${opLocation}.requestBody`);
        if (requestBody !== undefined) operation.requestBody = requestBody;

        out.set(operationId, operation);
      }
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Security scheme normalization
// ─────────────────────────────────────────────────────────────────────

function buildSecuritySchemes(components: JsonObject): Map<string, SecurityScheme> {
  const out = new Map<string, SecurityScheme>();
  const raw = components.securitySchemes;
  if (!isObject(raw)) return out;

  for (const [name, value] of Object.entries(raw)) {
    const location = `components.securitySchemes.${name}`;
    if (!isObject(value)) {
      throw new OpenApiSpecError({
        reason: "invalid-security-scheme",
        location,
        message: `Security scheme "${name}" at ${location} is not an object.`,
      });
    }
    out.set(name, normalizeSecurityScheme(name, value, location));
  }
  return out;
}

function normalizeSecurityScheme(
  name: string,
  raw: JsonObject,
  location: string,
): SecurityScheme {
  const type = asString(raw.type);
  const description = asString(raw.description);
  const base = description !== undefined ? { name, description } : { name };

  switch (type) {
    case "http": {
      const scheme = asString(raw.scheme)?.toLowerCase();
      if (scheme === "bearer") {
        const bearerFormat = asString(raw.bearerFormat);
        return {
          ...base,
          kind: "bearer",
          ...(bearerFormat !== undefined ? { bearerFormat } : {}),
        };
      }
      if (scheme === "basic") {
        return { ...base, kind: "basic" };
      }
      throw new OpenApiSpecError({
        reason: "invalid-security-scheme",
        location,
        message: `HTTP security scheme "${name}" at ${location} uses unsupported scheme "${scheme ?? "(missing)"}" (expected "bearer" or "basic").`,
      });
    }
    case "apiKey": {
      const inLocation = asString(raw.in);
      const parameterName = asString(raw.name);
      if (parameterName === undefined) {
        throw new OpenApiSpecError({
          reason: "invalid-security-scheme",
          location,
          message: `apiKey security scheme "${name}" at ${location} is missing its "name".`,
        });
      }
      if (inLocation === "header") {
        return { ...base, kind: "apiKey-header", parameterName };
      }
      if (inLocation === "query") {
        return { ...base, kind: "apiKey-query", parameterName };
      }
      throw new OpenApiSpecError({
        reason: "invalid-security-scheme",
        location,
        message: `apiKey security scheme "${name}" at ${location} has unsupported "in: ${inLocation ?? "(missing)"}" (expected "header" or "query"; "cookie" is not supported).`,
      });
    }
    case "oauth2":
      return { ...base, kind: "oauth2" };
    case "openIdConnect":
      return { ...base, kind: "openIdConnect" };
    default:
      throw new OpenApiSpecError({
        reason: "invalid-security-scheme",
        location,
        message: `Security scheme "${name}" at ${location} has unknown type "${type ?? "(missing)"}".`,
      });
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Public entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Normalize an OpenAPI 3.x JSON document into an {@link OperationGraph}.
 *
 * @param doc An already-parsed OpenAPI 3.x document (the result of
 *   `JSON.parse`). This function performs no I/O and does not fetch `$ref`
 *   targets across files.
 * @throws {OpenApiSpecError} on any structural malformation — never returns a
 *   partially-built graph.
 */
export function buildOperationGraph(doc: unknown): OperationGraph {
  if (!isObject(doc)) {
    throw new OpenApiSpecError({
      reason: "not-an-object",
      message: `OpenAPI document must be a JSON object, got ${describe(doc)}.`,
    });
  }

  const version = asString(doc.openapi);
  if (version === undefined || !version.startsWith("3.")) {
    throw new OpenApiSpecError({
      reason: "unsupported-version",
      location: "openapi",
      message:
        `Unsupported OpenAPI version "${version ?? "(missing)"}". This primitive supports OpenAPI 3.x only ` +
        `(2.0 / Swagger documents must be converted at install time).`,
    });
  }

  if (!isObject(doc.paths)) {
    throw new OpenApiSpecError({
      reason: "missing-paths",
      location: "paths",
      message: `OpenAPI document is missing a "paths" object.`,
    });
  }

  const components = isObject(doc.components) ? doc.components : {};
  const security = buildSecuritySchemes(components);
  const builder = new GraphBuilder(components, security);

  const schemas = builder.buildSchemas();
  const docHasSecurity = "security" in doc;
  const docSecurity = docHasSecurity
    ? builder.resolveSecurity(doc.security, "security")
    : [];
  const operations = builder.buildOperations(doc.paths, docSecurity, docHasSecurity);

  return {
    operations,
    schemas,
    security,
    servers: buildServers(doc.servers),
    info: buildInfo(doc.info, version),
  };
}

function buildServers(raw: unknown): ServerInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: ServerInfo[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const url = asString(entry.url);
    if (url === undefined) continue;
    const description = asString(entry.description);
    out.push(description !== undefined ? { url, description } : { url });
  }
  return out;
}

function buildInfo(raw: unknown, openapiVersion: string): SpecInfo {
  const obj = isObject(raw) ? raw : {};
  return {
    title: asString(obj.title) ?? "(untitled)",
    version: asString(obj.version) ?? "",
    openapiVersion,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Local utilities
// ─────────────────────────────────────────────────────────────────────

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function isParameterLocation(v: string): v is ParameterLocation {
  return v === "query" || v === "header" || v === "path" || v === "cookie";
}

/** Human-readable type tag for error messages, never the value itself. */
function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

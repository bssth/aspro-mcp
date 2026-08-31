import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type HttpMethod = "get" | "post";

export interface ParameterSpec {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required: boolean;
  description?: string;
  type?: string;
  schema?: unknown;
}

export interface BodyPropSpec {
  name: string;
  required: boolean;
  description?: string;
  type?: string;
  schema?: unknown;
}

export interface ResponseFieldSpec {
  name: string;
  type?: string;
  description?: string;
}

export interface OperationSpec {
  module: string;
  entity: string;
  method: string;
  path: string;
  httpMethod: HttpMethod;
  description?: string;
  tags: string[];
  parameters: ParameterSpec[];
  bodyContentType?: string;
  bodyProperties: BodyPropSpec[];
  bodyRequired: string[];
  responses: Record<string, unknown>;
  /**
   * Whether the operation changes server state. Derived from the method
   * segment, NOT the HTTP verb: Aspro exposes `/delete/{id}` over GET, so
   * "GET is safe" does not hold here. Anything that is not a known read
   * method is treated as mutating (deny by default).
   */
  mutating: boolean;
  /** Fields of the returned entity, lifted out of the 200 response schema. */
  responseFields: ResponseFieldSpec[];
  /** True when the 200 response is a paginated `{ total, page, count, items }`. */
  paginated: boolean;
}

interface OpenAPIDoc {
  paths: Record<string, Record<string, any>>;
}

const READ_METHODS = new Set(["get", "list"]);

/** Words that carry no signal when searching a Russian-language spec. */
const STOP_WORDS = new Set(["и", "в", "на", "по", "для", "the", "a", "of", "to", "for"]);

/** Fractional search tie-break between the five CRUD methods of one entity. */
const METHOD_BIAS: Record<string, number> = {
  list: 0.4,
  get: 0.3,
  create: 0.2,
  update: 0.1,
  delete: 0,
};

/**
 * Domain terms that share no stem with the spec text they should find.
 * Aspro has no "subtask" endpoint — a subtask is an ordinary task/tasks
 * record with `parent_id` set — so "подзадача"/"subtask" score zero against
 * "задача"/"tasks": the extra material is a *prefix*, which the
 * suffix-trimming stemmer below cannot see through. Each entry retries the
 * query token with the listed forms in addition to its own.
 */
const QUERY_SYNONYMS: [prefix: string, forms: string[]][] = [
  ["подзадач", ["задача"]],
  ["subtask", ["task"]],
];

function synonymFormsOf(token: string): string[] {
  const forms: string[] = [];
  for (const [prefix, extra] of QUERY_SYNONYMS) {
    if (token.startsWith(prefix)) forms.push(...extra);
  }
  return forms;
}

export class SpecIndex {
  private readonly doc: OpenAPIDoc;
  private readonly operations: OperationSpec[] = [];
  // module/entity/method -> OperationSpec
  private readonly byKey = new Map<string, OperationSpec>();
  // module -> Set<entity>
  private readonly modules = new Map<string, Set<string>>();
  // module/entity -> Set<method>
  private readonly entityMethods = new Map<string, Set<string>>();
  // Precomputed lowercase haystacks, parallel to `operations`.
  private readonly haystacks: {
    phrase: string;
    fields: SearchField[];
  }[] = [];

  constructor(doc: OpenAPIDoc) {
    this.doc = doc;
    this.indexAll();
  }

  static loadDefault(): SpecIndex {
    const path = resolve(__dirname, "..", "spec", "openapi.json");
    const raw = readFileSync(path, "utf8");
    return new SpecIndex(JSON.parse(raw));
  }

  private indexAll(): void {
    for (const [path, methods] of Object.entries(this.doc.paths)) {
      const segments = path.replace(/^\/+/, "").split("/");
      // Expected shape: /{module}/{entity}/{method}[/{id}]
      if (segments.length < 3) continue;
      const [module, entity, method] = segments;
      if (!module || !entity || !method) continue;

      for (const [httpMethod, op] of Object.entries(methods as Record<string, any>)) {
        if (!op || typeof op !== "object") continue;
        if (httpMethod !== "get" && httpMethod !== "post") continue;

        const parameters: ParameterSpec[] = (op.parameters ?? []).map((p: any) => ({
          name: p.name,
          in: p.in,
          required: !!p.required,
          description: p.description,
          type: p?.schema?.type,
          schema: p.schema,
        }));

        let bodyContentType: string | undefined;
        const bodyProperties: BodyPropSpec[] = [];
        let bodyRequired: string[] = [];
        const rb = op.requestBody;
        if (rb && rb.content) {
          const contentEntries = Object.entries(rb.content as Record<string, any>);
          // Prefer x-www-form-urlencoded since that's what Aspro expects
          const preferred =
            contentEntries.find(([ct]) => ct.includes("x-www-form-urlencoded")) ??
            contentEntries.find(([ct]) => ct.includes("json")) ??
            contentEntries[0];
          if (preferred) {
            const [ct, body] = preferred;
            bodyContentType = ct;
            const schema = body?.schema ?? {};
            bodyRequired = Array.isArray(schema.required) ? schema.required : [];
            const props = (schema.properties ?? {}) as Record<string, any>;
            for (const [pname, pinfo] of Object.entries(props)) {
              bodyProperties.push({
                name: pname,
                required: bodyRequired.includes(pname),
                description: pinfo?.description,
                type: pinfo?.type,
                schema: pinfo,
              });
            }
          }
        }

        const { fields, paginated } = extractResponseFields(op.responses);

        const spec: OperationSpec = {
          module,
          entity,
          method,
          path,
          httpMethod: httpMethod as HttpMethod,
          description: op.description ?? op.summary,
          tags: Array.isArray(op.tags) ? op.tags : [],
          parameters,
          bodyContentType,
          bodyProperties,
          bodyRequired,
          responses: op.responses ?? {},
          mutating: !READ_METHODS.has(method.toLowerCase()),
          responseFields: fields,
          paginated,
        };

        const key = this.makeKey(module, entity, method);
        const existing = this.byKey.get(key);
        if (existing) {
          // Two spec paths collapse onto the same module/entity/method address,
          // so one of them is unreachable through describe/call. The bundled
          // spec has no such collisions; warn loudly if a future one appears.
          console.error(
            `aspro-mcp: spec collision on "${key}" — ${existing.httpMethod.toUpperCase()} ` +
              `${existing.path} is shadowed by ${httpMethod.toUpperCase()} ${path}`,
          );
        }

        this.operations.push(spec);
        this.byKey.set(key, spec);
        if (!this.modules.has(module)) this.modules.set(module, new Set());
        this.modules.get(module)!.add(entity);
        const ek = `${module}/${entity}`;
        if (!this.entityMethods.has(ek)) this.entityMethods.set(ek, new Set());
        this.entityMethods.get(ek)!.add(method);
      }
    }

    for (const op of this.operations) {
      // Identifiers rank above prose: an entity named "lead" is a stronger
      // signal than the word "lead" buried in a description.
      this.haystacks.push({
        phrase: normalize(
          [op.module, op.entity, op.method, op.path, op.description ?? "", op.tags.join(" ")].join(" "),
        ),
        fields: [
          makeField(`${op.module} ${op.entity} ${op.method}`, 3),
          makeField(op.tags.join(" "), 2),
          makeField(op.description ?? "", 2),
          makeField(op.path, 1),
        ],
      });
    }
  }

  private makeKey(module: string, entity: string, method: string): string {
    return `${module}/${entity}/${method}`;
  }

  listModules(): { module: string; entityCount: number; operationCount: number }[] {
    const counts = new Map<string, number>();
    for (const op of this.operations) {
      counts.set(op.module, (counts.get(op.module) ?? 0) + 1);
    }
    return [...this.modules.entries()]
      .map(([module, entities]) => ({
        module,
        entityCount: entities.size,
        operationCount: counts.get(module) ?? 0,
      }))
      .sort((a, b) => a.module.localeCompare(b.module));
  }

  listEntities(module: string): { entity: string; methods: string[] }[] {
    const ents = this.modules.get(module);
    if (!ents) return [];
    return [...ents]
      .sort()
      .map((entity) => ({
        entity,
        methods: [...(this.entityMethods.get(`${module}/${entity}`) ?? [])].sort(),
      }));
  }

  listMethods(module: string, entity?: string): OperationSpec[] {
    return this.operations
      .filter((o) => o.module === module && (entity ? o.entity === entity : true))
      .sort((a, b) =>
        a.entity.localeCompare(b.entity) || a.method.localeCompare(b.method),
      );
  }

  describe(module: string, entity: string, method: string): OperationSpec | undefined {
    return this.byKey.get(this.makeKey(module, entity, method));
  }

  /**
   * Token-based search. The bundled spec has near-empty descriptions ("Список",
   * "Создать") and carries its meaning in Russian tags ("Сделки", "Задачи"), so
   * plain substring matching misses the obvious queries — "сделка" would not
   * match "Сделки". Tokens are matched on a truncated stem to absorb Russian
   * inflection, and multi-word queries score by how many tokens hit.
   */
  search(query: string, limit = 30): OperationSpec[] {
    const phrase = normalize(query);
    if (!phrase) return [];
    const tokens = tokenize(phrase);
    if (tokens.length === 0) return [];
    // Each query token keeps its own synonym forms alongside the literal
    // word, so a hit on either still counts as one matched token below —
    // "подзадача" alone must not need "задача" to *also* be typed.
    const tokenForms = tokens.map((t) => [t, ...synonymFormsOf(t)]);

    const results: { score: number; index: number; op: OperationSpec }[] = [];
    for (let i = 0; i < this.operations.length; i++) {
      const hay = this.haystacks[i];
      let score = 0;
      let matched = 0;

      for (const forms of tokenForms) {
        let tokenScore = 0;
        for (const form of forms) {
          const s = scoreToken(hay.fields, form);
          if (s > tokenScore) tokenScore = s;
        }
        if (tokenScore === 0) continue;
        matched++;
        score += tokenScore;
      }

      if (matched === 0) continue;
      // Operations matching every token outrank partial matches outright, so
      // "создать задачу" cannot be topped by something that only matches
      // "создать"; partial hits stay available as a fallback.
      if (matched === tokens.length) score += 50;
      else score -= 1000;
      if (hay.phrase.includes(phrase)) score += 25;
      // Sub-point tie-break only: when an entity matches, all five of its CRUD
      // methods score identically, and surfacing `list` first is both the more
      // useful and the safer default.
      score += METHOD_BIAS[this.operations[i].method.toLowerCase()] ?? 0;

      results.push({ score, index: i, op: this.operations[i] });
    }

    results.sort((a, b) => b.score - a.score || a.index - b.index);
    return results.slice(0, limit).map((r) => r.op);
  }
}

/** Lowercase, fold ё→е, and collapse punctuation so tokens compare cleanly. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokenize(normalized: string): string[] {
  return normalized.split(/\s+/).filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

interface SearchField {
  words: string[];
  weight: number;
  /**
   * Length normalization, as in Lucene: a hit inside a short field is more
   * specific than the same hit inside a long one. Without it "Регулярный счет"
   * outranks "Счета" for the query "счёт", purely because it happens to use the
   * singular form the user typed.
   */
  norm: number;
}

function makeField(text: string, weight: number): SearchField {
  const n = normalize(text);
  const list = n ? n.split(/\s+/) : [];
  return { words: list, weight, norm: 1 / Math.sqrt(Math.max(1, list.length)) };
}

/**
 * Best score for one query token across an operation's fields. Matching is
 * per-word and graded by how much of the word the token actually shares, so
 * "сделка" ranks "Сделки" (5 chars in common) above "Источники сделок" (4).
 */
function scoreToken(fields: SearchField[], token: string): number {
  const stem = stemOf(token);
  let best = 0;
  for (const field of fields) {
    for (const word of field.words) {
      let score = 0;
      if (word === token) {
        score = field.weight * (token.length + 1);
      } else if (word.startsWith(stem)) {
        score = field.weight * commonPrefixLength(word, token);
      } else if (word.includes(stem)) {
        // Token buried mid-word — real but weak evidence.
        score = field.weight;
      }
      score *= field.norm;
      if (score > best) best = score;
    }
  }
  return best;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/**
 * Crude suffix trim standing in for a stemmer: "сделка"/"сделки"/"сделок" all
 * collapse to "сдел". Four characters is the floor — shorter stems match noise.
 */
function stemOf(token: string): string {
  if (token.length <= 4) return token;
  return token.slice(0, Math.max(4, token.length - 2));
}

/**
 * Lift entity field definitions out of an operation's 200 response schema.
 * Aspro wraps payloads in `response`: list endpoints nest the entity under
 * `response.items[]`, everything else puts the fields directly on `response`.
 */
function extractResponseFields(responses: any): { fields: ResponseFieldSpec[]; paginated: boolean } {
  const schema = responses?.["200"]?.content?.["application/json"]?.schema;
  const response = schema?.properties?.response;
  if (!response || typeof response !== "object") return { fields: [], paginated: false };

  const itemProps = response.properties?.items?.items?.properties;
  const paginated = !!itemProps && !!response.properties?.total;
  const props = itemProps ?? response.properties;
  if (!props || typeof props !== "object") return { fields: [], paginated: false };

  const fields: ResponseFieldSpec[] = [];
  for (const [name, info] of Object.entries(props as Record<string, any>)) {
    fields.push({ name, type: info?.type, description: info?.description });
  }
  return { fields, paginated };
}

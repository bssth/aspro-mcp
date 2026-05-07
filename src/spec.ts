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
}

interface OpenAPIDoc {
  paths: Record<string, Record<string, any>>;
}

export class SpecIndex {
  private readonly doc: OpenAPIDoc;
  private readonly operations: OperationSpec[] = [];
  // module -> entity -> method -> OperationSpec
  private readonly byKey = new Map<string, OperationSpec>();
  // module -> Set<entity>
  private readonly modules = new Map<string, Set<string>>();
  // module/entity -> Set<method>
  private readonly entityMethods = new Map<string, Set<string>>();

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
        };

        this.operations.push(spec);
        this.byKey.set(this.makeKey(module, entity, method), spec);
        if (!this.modules.has(module)) this.modules.set(module, new Set());
        this.modules.get(module)!.add(entity);
        const ek = `${module}/${entity}`;
        if (!this.entityMethods.has(ek)) this.entityMethods.set(ek, new Set());
        this.entityMethods.get(ek)!.add(method);
      }
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

  search(query: string, limit = 30): OperationSpec[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    const results: { score: number; op: OperationSpec }[] = [];
    for (const op of this.operations) {
      const haystack = [
        op.module,
        op.entity,
        op.method,
        op.path,
        op.description ?? "",
        op.tags.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      const idx = haystack.indexOf(q);
      if (idx >= 0) results.push({ score: idx, op });
    }
    results.sort((a, b) => a.score - b.score);
    return results.slice(0, limit).map((r) => r.op);
  }
}

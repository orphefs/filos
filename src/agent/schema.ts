// Turns the contract schema into the form we hand to the CLI's --json-schema.
// Structured-output backends support a subset of JSON Schema, so we inline local $refs and turn
// `const` into a one-value `enum`. We still re-validate the answer against the full contract.

import contractSchema from '../../schema/review-graph.schema.json';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (v: Json | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fields the provider fills itself, so the model is never asked for them. */
const PROVIDER_OWNED = ['generatedBy'];

export function toCliSchema(schema: object = contractSchema): JsonObject {
  const root = structuredClone(schema) as JsonObject;
  const defs: JsonObject = { ...(isObject(root.definitions) ? root.definitions : {}), ...(isObject(root.$defs) ? root.$defs : {}) };

  const resolve = (node: Json, stack: string[]): Json => {
    if (Array.isArray(node)) return node.map((n) => resolve(n, stack));
    if (!isObject(node)) return node;
    if (typeof node.$ref === 'string') {
      const m = /^#\/(?:definitions|\$defs)\/(.+)$/.exec(node.$ref);
      if (!m || !(m[1] in defs)) throw new Error(`cannot inline $ref ${node.$ref}`);
      if (stack.includes(m[1])) throw new Error(`recursive $ref ${node.$ref} cannot be inlined`);
      const { $ref: _ref, ...siblings } = node;
      return resolve({ ...(defs[m[1]] as JsonObject), ...siblings }, [...stack, m[1]]);
    }
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'const') out.enum = [v];
      else if (k === 'properties' && isObject(v)) out[k] = resolveNames(v, stack);
      else out[k] = resolve(v, stack);
    }
    return out;
  };
  // Keys of `properties` are field names, not keywords: a field called "const" stays a field.
  const resolveNames = (map: JsonObject, stack: string[]): JsonObject =>
    Object.fromEntries(Object.entries(map).map(([name, sub]) => [name, resolve(sub, stack)]));

  const out = resolve(root, []) as JsonObject;
  for (const k of ['$schema', '$id', 'definitions', '$defs']) delete out[k];
  if (isObject(out.properties)) for (const k of PROVIDER_OWNED) delete out.properties[k];
  if (Array.isArray(out.required)) out.required = out.required.filter((k) => !PROVIDER_OWNED.includes(k as string));
  return out;
}

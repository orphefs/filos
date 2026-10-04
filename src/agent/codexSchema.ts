// Turns a Filos output schema into one OpenAI structured outputs accept in strict mode, for
// `codex exec --output-schema`. Codex sends the file as `text.format = {type: "json_schema",
// strict: true}` (checked against codex-cli 0.160.0), and strict mode wants:
//   - every object to list all its properties in `required`, with `additionalProperties: false`;
//   - an optional field expressed as a required one that may be null;
//   - a subset of keywords (no $ref here, no const; minLength/maxLength aren't in the documented subset).
// A dropped maxLength goes into the field's description instead ("At most N characters."), so the
// model still knows it. The answer is turned back with fromCodexAnswer before the usual validators
// see it: nulls become absent fields again, and an optional string that breaks its length limits
// (the "" strict mode invites for a field that doesn't apply, say) is dropped rather than failing
// the whole answer.

import { toCliSchema } from './schema';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (v: Json | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Keywords strict mode documents (plus annotations). Anything else is dropped: the schema only steers
 * the model, and the Filos validators check what was dropped (lengths, for example) afterwards.
 */
const KEPT = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'anyOf',
  'description',
  'title',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'pattern',
  'format',
]);

/** Keywords that change what a schema accepts and can't be expressed in strict mode: refuse rather than loosen silently. */
const UNSUPPORTED = ['allOf', 'not', 'if', 'then', 'else', 'patternProperties', 'dependentSchemas', 'dependencies', 'prefixItems'];

/**
 * The strict-mode form of `schema` (a Filos contract schema or a task schema). $refs and const are
 * inlined first (toCliSchema), so the review-graph schema can go in as is. Throws for a construct
 * strict mode can't express.
 */
export function toCodexSchema(schema: object): JsonObject {
  const root = strict(toCliSchema(schema), false, '#');
  if (root.type !== 'object') throw new Error('the output schema must be an object at the root');
  return root;
}

function strict(node: Json, optional: boolean, at: string): JsonObject {
  if (!isObject(node)) throw new Error(`${at}: a schema must be an object`);
  for (const k of UNSUPPORTED) if (k in node) throw new Error(`${at}: "${k}" can't be expressed in a strict output schema`);

  const out: JsonObject = {};
  for (const [k, v] of Object.entries(node)) if (KEPT.has(k)) out[k] = v;
  if (Array.isArray(node.oneOf)) out.anyOf = node.oneOf; // exclusivity is the validator's job
  if (typeof node.maxLength === 'number') {
    // Strict mode has no maxLength: say it in words, or the model never hears of the limit.
    const limit = `At most ${node.maxLength} characters.`;
    out.description = typeof out.description === 'string' && out.description.trim() ? `${out.description.trim().replace(/([^.!?])$/, '$1.')} ${limit}` : limit;
  }

  if (Array.isArray(out.anyOf)) {
    out.anyOf = out.anyOf.map((s, i) => strict(s, false, `${at}/anyOf/${i}`));
  }
  if (out.type === undefined && Array.isArray(out.enum)) {
    out.type = enumType(out.enum, at);
  }
  if (isObject(out.properties) || out.type === 'object') {
    const props = isObject(out.properties) ? out.properties : {};
    const required = new Set(Array.isArray(node.required) ? node.required.filter((r): r is string => typeof r === 'string') : []);
    out.type = 'object';
    out.properties = Object.fromEntries(Object.entries(props).map(([name, sub]) => [name, strict(sub, !required.has(name), `${at}/properties/${name}`)]));
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  if (out.type === 'array' && out.items !== undefined) {
    if (Array.isArray(out.items)) throw new Error(`${at}: tuple "items" can't be expressed in a strict output schema`);
    out.items = strict(out.items, false, `${at}/items`);
  }
  return optional ? nullable(out) : out;
}

/** The schema, also accepting null: how strict mode spells "optional". */
function nullable(s: JsonObject): JsonObject {
  if (Array.isArray(s.anyOf)) {
    return s.anyOf.some((b) => isObject(b) && b.type === 'null') ? s : { ...s, anyOf: [...s.anyOf, { type: 'null' }] };
  }
  const types = Array.isArray(s.type) ? s.type : typeof s.type === 'string' ? [s.type] : [];
  if (types.includes('object') || types.includes('array') || !types.length) {
    // Containers (and anything untyped) become a union, which strict mode documents for objects.
    const { description, ...rest } = s;
    return { ...(description !== undefined ? { description } : {}), anyOf: [rest, { type: 'null' }] };
  }
  const out: JsonObject = { ...s, type: types.includes('null') ? types : [...types, 'null'] };
  if (Array.isArray(s.enum) && !s.enum.includes(null)) out.enum = [...s.enum, null];
  return out;
}

function enumType(values: Json[], at: string): Json {
  const kinds = [...new Set(values.map((v) => (v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v === 'number' ? 'number' : typeof v)))];
  for (const k of kinds) if (!['string', 'integer', 'number', 'boolean', 'null'].includes(k)) throw new Error(`${at}: enum values must be scalars`);
  return kinds.length === 1 ? kinds[0] : kinds;
}

/**
 * Removes every object property whose value is null, at any depth: the strict-mode spelling of an
 * absent optional field, turned back. Array elements are left alone (no Filos schema has a nullable
 * item). Filos schemas never accept null anywhere, so nothing a validator could accept is lost.
 * Returns a copy; the input is not changed.
 */
export function stripNulls(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(stripNulls);
  if (typeof raw !== 'object' || raw === null) return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v !== null) out[k] = stripNulls(v);
  }
  return out;
}

export interface CodexAnswer {
  value: unknown;
  /** What was dropped and why, for the result's warnings. */
  repairs: string[];
}

/**
 * A strict-mode answer turned back into what the Filos validators expect, using the Filos schema it
 * was asked for (`schema`, before toCodexSchema). As stripNulls, plus the string lengths strict mode
 * can't enforce:
 * - an optional string shorter than its minLength (the "" a strict-mode model writes for a field
 *   that doesn't apply) or longer than its maxLength is dropped, as if absent;
 * - a required string that breaks its limits inside an optional object (a comment seed's body, say)
 *   drops that object: it is never cut, since a cut comment could be posted half-finished.
 * Anything else is left for the validators, which report it. Returns a copy.
 */
export function fromCodexAnswer(raw: unknown, schema: object): CodexAnswer {
  const repairs: string[] = [];
  let source: Json;
  try {
    source = toCliSchema(schema);
  } catch {
    return { value: stripNulls(raw), repairs };
  }
  return { value: fit(stripNulls(raw), source, '', repairs).value, repairs };
}

/** Length problem of a string against its schema, or undefined. */
function lengthProblem(v: string, s: JsonObject): string | undefined {
  // Code points, as JSON Schema (and ajv) count them.
  const n = [...v].length;
  if (typeof s.minLength === 'number' && n < s.minLength) return v.trim() ? `shorter than ${s.minLength} characters` : 'empty';
  if (typeof s.maxLength === 'number' && n > s.maxLength) return `${n} characters, over the limit of ${s.maxLength}`;
  return undefined;
}

/**
 * `value` fitted to `s`. `broken`: a required string in it (at any depth through required fields)
 * breaks its length limits, so the optional property holding it should go. A broken array item
 * stays (the array's own rules may need it; the validators report or drop it).
 */
function fit(value: unknown, s: Json | undefined, at: string, repairs: string[]): { value: unknown; broken: boolean } {
  if (!isObject(s) || value === null || typeof value !== 'object') return { value, broken: false };
  if (Array.isArray(value)) {
    return { value: isObject(s.items) ? value.map((v, i) => fit(v, s.items, `${at}/${i}`, repairs).value) : value, broken: false };
  }
  if (!isObject(s.properties)) return { value, broken: false };
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  const out: Record<string, unknown> = {};
  let broken = false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const sub = s.properties[k];
    const where = `${at}/${k}`;
    if (typeof v === 'string' && isObject(sub)) {
      const problem = lengthProblem(v, sub);
      if (problem && !required.has(k)) {
        repairs.push(`dropped ${where} (${problem}): it is optional`);
        continue;
      }
      if (problem) broken = true;
      out[k] = v;
      continue;
    }
    const fitted = fit(v, sub, where, repairs);
    if (fitted.broken && !required.has(k)) {
      repairs.push(`dropped ${where}: a field it needs breaks its length limits`);
      continue;
    }
    if (fitted.broken) broken = true;
    out[k] = fitted.value;
  }
  return { value: out, broken };
}

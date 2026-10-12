'use strict';
// Minimal JSON Schema (2020-12 subset) validator: enough for our own schemas,
// with precise error paths so the repair loop can tell the model what to fix.
const path = require('node:path');
const { ROOT, readJson } = require('./util');

const SCHEMA_DIR = path.join(ROOT, 'config', 'schemas');
const cache = new Map();

function loadSchema(name) {
  if (!cache.has(name)) cache.set(name, readJson(path.join(SCHEMA_DIR, `${name}.schema.json`)));
  return cache.get(name);
}

function resolveRef(root, ref) {
  const m = ref.match(/^#\/\$defs\/([A-Za-z0-9_]+)$/);
  if (!m || !root.$defs || !root.$defs[m[1]]) throw new Error(`unresolvable $ref ${ref}`);
  return root.$defs[m[1]];
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(expected, value) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

function validate(root, schema, value, at = '$', errors = []) {
  if (schema.$ref) return validate(root, resolveRef(root, schema.$ref), value, at, errors);
  if (schema.anyOf) {
    const ok = schema.anyOf.some((sub) => validate(root, sub, value, at, []).length === 0);
    if (!ok) errors.push(`${at}: does not match any allowed shape`);
    return errors;
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join('|')}, got ${JSON.stringify(value)}`);
    return errors;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: must be at least ${schema.minLength} chars`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: must match /${schema.pattern}/`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: allows at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => validate(root, schema.items, item, `${at}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${at}: missing required field "${key}"`);
    }
    const props = schema.properties || {};
    for (const [key, child] of Object.entries(value)) {
      if (props[key]) validate(root, props[key], child, `${at}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}: unknown field "${key}"`);
    }
  }
  return errors;
}

// Validate `value` against `$defs/<def>` (or the root when def is omitted).
function validateAgainst(schemaName, value, def) {
  const root = loadSchema(schemaName);
  const schema = def ? resolveRef(root, `#/$defs/${def}`) : root;
  return validate(root, schema, value);
}

// Smallest self-contained schema for one definition: only the reachable $defs.
// The model sees the exact contract for its job and nothing else.
function prunedSchema(schemaName, def) {
  const root = loadSchema(schemaName);
  const needed = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.$ref === 'string') {
      const name = node.$ref.split('/').pop();
      if (!needed.has(name)) {
        needed.add(name);
        walk(root.$defs[name]);
      }
    }
    Object.values(node).forEach(walk);
  };
  needed.add(def);
  walk(root.$defs[def]);
  const $defs = {};
  for (const name of Object.keys(root.$defs)) if (needed.has(name)) $defs[name] = root.$defs[name];
  return { $ref: `#/$defs/${def}`, $defs };
}

// Strict structured-output variant (OpenAI strict mode, used by codex
// --output-schema): every property is required, so optional ones become
// nullable. Callers strip nulls (stripNulls) before validating against the
// real schema, which stays the only source of truth.
function strictSchema(schema) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, walk(s)])) : walk(v);
    // Strict mode wants an explicit type on every leaf, including const/enum.
    if (!out.type && !out.$ref && !out.anyOf) {
      const values = out.const !== undefined ? [out.const] : out.enum;
      if (values) {
        const types = [...new Set(values.map((v) => (v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v)))];
        out.type = types.length === 1 ? types[0] : types;
      }
    }
    if (out.type === 'object' && out.properties) {
      const required = new Set(out.required || []);
      for (const key of Object.keys(out.properties)) {
        if (!required.has(key)) out.properties[key] = { anyOf: [out.properties[key], { type: 'null' }] };
      }
      out.required = Object.keys(out.properties);
      out.additionalProperties = false;
    }
    return out;
  };
  return walk(schema);
}

// Strict output schema for one definition of a schema file (root inlined:
// structured outputs want an object at the root, not a bare $ref).
function outputSchema(schemaName, def) {
  if (!def) return strictSchema(loadSchema(schemaName));
  const pruned = prunedSchema(schemaName, def);
  const { $ref, ...rest } = pruned;
  return strictSchema({ ...pruned.$defs[def], $defs: rest.$defs });
}

function stripNulls(value) {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = stripNulls(v);
  return out;
}

module.exports = { loadSchema, validate, validateAgainst, prunedSchema, strictSchema, outputSchema, stripNulls };

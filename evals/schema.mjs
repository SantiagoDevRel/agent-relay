// Minimal JSON Schema (2020-12 subset) validator for the Relay Evals contracts.
// Supported: type, const, enum, required, properties, additionalProperties,
// propertyNames, items, minItems, maxItems, minimum, maximum, minLength,
// maxLength, pattern, oneOf and local $ref (#/$defs/...). No dependencies.
import fs from 'node:fs';

const NAMES = ['chat-record', 'chat-metrics', 'task', 'report'];
const cache = new Map();

export function loadSchema(name) {
  if (!NAMES.includes(name)) throw new Error(`Unknown evals schema: ${name}`);
  if (!cache.has(name)) cache.set(name, JSON.parse(fs.readFileSync(new URL(`./schema/${name}.schema.json`, import.meta.url), 'utf8')));
  return cache.get(name);
}

const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array'
  : Number.isInteger(value) ? 'integer' : typeof value;
const matchesType = (value, type) => type === typeOf(value) || (type === 'number' && typeof value === 'number' && Number.isFinite(value));

function resolve(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref: ${ref}`);
  return ref.slice(2).split('/').reduce((node, key) => node?.[key], root);
}

function check(root, schema, value, at, errors) {
  if (errors.length >= 50) return;
  if (schema.$ref) return check(root, resolve(root, schema.$ref), value, at, errors);
  if (schema.oneOf) {
    const passing = schema.oneOf.filter(option => { const e = []; check(root, option, value, at, e); return !e.length; }).length;
    if (passing !== 1) errors.push(`${at}: must match exactly one schema (matched ${passing})`);
  }
  if ('const' in schema && value !== schema.const) errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: must be one of ${schema.enum.join(', ')}`);
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some(type => matchesType(value, type))) { errors.push(`${at}: must be ${types.join(' or ')}`); return; }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => check(root, schema.items, item, `${at}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      const where = `${at}.${key}`;
      if (schema.propertyNames) check(root, schema.propertyNames, key, `${where}(name)`, errors);
      if (schema.properties && key in schema.properties) check(root, schema.properties[key], item, where, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(root, schema.additionalProperties, item, where, errors);
    }
  }
}

// Returns a list of readable errors; empty means valid.
export function validate(name, value) {
  const schema = loadSchema(name), errors = [];
  check(schema, schema, value, '$', errors);
  return errors;
}

export function assertValid(name, value) {
  const errors = validate(name, value);
  if (errors.length) throw new Error(`Invalid ${name}: ${errors.slice(0, 5).join('; ')}`);
  return value;
}

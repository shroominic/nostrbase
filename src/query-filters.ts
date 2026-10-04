import { NostrbaseError } from "./errors";

export type QueryOperator =
  | "eq"
  | "neq"
  | "in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "is"
  | "textSearch"
  | "contains"
  | "containedBy"
  | "overlaps"
  | "like"
  | "ilike";
export type FilterOperator = QueryOperator | "cs" | "cd" | "ov";
export type PredicateOperator = QueryOperator | "and" | "or" | "not";
export interface Predicate {
  field: string;
  op: PredicateOperator;
  value: unknown;
}
type Keys<T> = keyof T & string;
type JsonRoot<T> = { [K in Keys<T>]: NonNullable<T[K]> extends object ? K : never }[Keys<T>];
export type QueryField<T> = Keys<T> | `${JsonRoot<T>}->${string}`;
type Child<T, K extends string> = K extends keyof NonNullable<T>
  ? NonNullable<T>[K]
  : NonNullable<T> extends readonly (infer V)[]
    ? K extends `${number}`
      ? V
      : unknown
    : unknown;
export type QueryFieldValue<T, K extends string> = K extends keyof T
  ? T[K]
  : K extends `${infer Root}->${infer Rest}`
    ? Root extends keyof T
      ? Rest extends `>${string}`
        ? string | null | undefined
        : JsonPathValue<T[Root], Rest>
      : unknown
    : unknown;
type JsonPathValue<T, P extends string> = P extends `${infer K}->${infer Rest}`
  ? Rest extends `>${string}`
    ? string | null | undefined
    : JsonPathValue<Child<T, K>, Rest>
  : Child<T, P> | undefined;
export type DeepPartial<T> = T extends readonly (infer V)[]
  ? readonly DeepPartial<V>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
export type FilterValue<T, O extends FilterOperator> = O extends "in"
  ? readonly T[]
  : O extends "is"
    ? null | boolean
    : O extends "like" | "ilike" | "textSearch"
      ? string
      : O extends "contains" | "containedBy" | "cs" | "cd"
        ? DeepPartial<T>
        : O extends "overlaps" | "ov"
          ? NonNullable<T> extends readonly unknown[]
            ? NonNullable<T>
            : unknown extends T
              ? readonly unknown[]
              : never
          : T;
const operators = new Set<QueryOperator>([
  "eq",
  "neq",
  "in",
  "gt",
  "gte",
  "lt",
  "lte",
  "is",
  "textSearch",
  "contains",
  "containedBy",
  "overlaps",
  "like",
  "ilike",
]);
const aliases: Record<string, QueryOperator> = {
  cs: "contains",
  cd: "containedBy",
  ov: "overlaps",
};
function invalid(message: string): never {
  throw new NostrbaseError("INVALID_QUERY", message);
}
export function operator(value: string): QueryOperator {
  const normalized = Object.hasOwn(aliases, value) ? aliases[value] : value;
  if (typeof value !== "string" || !operators.has(normalized as QueryOperator))
    invalid("Filter operator is unsupported.");
  return normalized as QueryOperator;
}
export function fieldPath(
  field: string,
  strict = false,
): { root: string; keys: string[]; text: boolean } {
  if (typeof field !== "string" || field.length > 512) invalid("Filter field path is invalid.");
  if (
    !strict &&
    !field.includes("->") &&
    !/^_nostr\.(pubkey|eventId|createdAt|updatedAt)$/.test(field)
  )
    return { root: field, keys: [], text: false };
  if (field.startsWith("_nostr.")) {
    if (!/^_nostr\.(pubkey|eventId|createdAt|updatedAt)$/.test(field))
      invalid("Nostr metadata field is unsupported.");
    return { root: "_nostr", keys: [field.slice(7)], text: false };
  }
  const root = /^[A-Za-z_][A-Za-z0-9_]*/.exec(field)?.[0];
  if (!root) invalid("Filter field path is invalid.");
  let rest = field.slice(root.length);
  const keys: string[] = [];
  let text = false;
  while (rest) {
    const step = /^(->>?)([A-Za-z_][A-Za-z0-9_-]*|0|[1-9][0-9]*)(?=->|$)/.exec(rest);
    if (!step || text || keys.length >= 16)
      invalid("JSON paths use -> keys and a final ->> text key.");
    keys.push(step[2] ?? "");
    text = step[1] === "->>";
    rest = rest.slice(step[0].length);
  }
  return { root, keys, text };
}
export function fieldValue(row: object, field: string): unknown {
  if (!field.includes("->") && Object.hasOwn(row, field))
    return (row as Record<string, unknown>)[field];
  const path = fieldPath(field);
  let current: unknown = Object.hasOwn(row, path.root)
    ? (row as Record<string, unknown>)[path.root]
    : undefined;
  for (const key of path.keys) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key))
      return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  if (!path.text || current == null || typeof current === "string") return current;
  return JSON.stringify(current);
}
/** Copy caller values. Reject cycles, accessors and non-JSON objects before execution. */
export function snapshotValue(value: unknown): unknown {
  let nodes = 0;
  const active = new Set<object>();
  function copy(input: unknown, depth: number): unknown {
    if (++nodes > 10000 || depth > 32) invalid("Filter value is too large or too deeply nested.");
    if (
      input === null ||
      input === undefined ||
      typeof input === "string" ||
      typeof input === "boolean"
    )
      return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input !== "object") invalid("Filter values must use finite JSON data.");
    if (active.has(input)) invalid("Filter values must not contain cycles.");
    const prototype = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null)
      invalid("Filter values must use plain objects or arrays.");
    active.add(input);
    let output: unknown;
    if (Array.isArray(input)) {
      const entries: unknown[] = [];
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor && !("value" in descriptor))
          invalid("Filter values must not contain accessors.");
        entries.push(copy(descriptor?.value, depth + 1));
      }
      output = Object.freeze(entries);
    } else {
      const record: Record<string, unknown> = Object.create(null);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
        if (!descriptor.enumerable) continue;
        if (!("value" in descriptor)) invalid("Filter values must not contain accessors.");
        record[key] = copy(descriptor.value, depth + 1);
      }
      output = Object.freeze(record);
    }
    active.delete(input);
    return output;
  }
  return copy(value, 0);
}
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => equal(value, b[index]))
    );
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every(
        (key) =>
          Object.hasOwn(b, key) &&
          equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}
export function contains(actual: unknown, value: unknown): boolean {
  if (Array.isArray(actual) && Array.isArray(value))
    return value.every((entry) => actual.some((item) => contains(item, entry)));
  if (
    actual !== null &&
    value !== null &&
    typeof actual === "object" &&
    typeof value === "object" &&
    !Array.isArray(actual) &&
    !Array.isArray(value)
  ) {
    return Object.keys(value).every(
      (key) =>
        Object.hasOwn(actual, key) &&
        contains((actual as Record<string, unknown>)[key], (value as Record<string, unknown>)[key]),
    );
  }
  return equal(actual, value);
}
function patternTokens(pattern: string): string[] {
  if (typeof pattern !== "string" || pattern.length > 4096)
    invalid("LIKE patterns must be strings with at most 4096 characters.");
  const chars = Array.from(pattern);
  const tokens: string[] = [];
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] ?? "";
    if (char === "\\") {
      if (++index === chars.length) invalid("LIKE pattern has an incomplete escape.");
      tokens.push(`=${chars[index]}`);
    } else if (char !== "%" || tokens.at(-1) !== "%")
      tokens.push(char === "%" || char === "_" ? char : `=${char}`);
  }
  return tokens;
}
function like(actual: string, pattern: string, insensitive: boolean): boolean {
  const tokens = patternTokens(insensitive ? pattern.toLowerCase() : pattern);
  const text = Array.from(insensitive ? actual.toLowerCase() : actual);
  let ti = 0,
    pi = 0,
    wildcard = -1,
    restart = 0;
  while (ti < text.length) {
    if (tokens[pi] === "_" || tokens[pi] === `=${text[ti]}`) {
      ti++;
      pi++;
    } else if (tokens[pi] === "%") {
      wildcard = pi++;
      restart = ti;
    } else if (wildcard >= 0) {
      pi = wildcard + 1;
      ti = ++restart;
    } else return false;
  }
  while (tokens[pi] === "%") pi++;
  return pi === tokens.length;
}
export function makePredicate(
  field: string,
  op: string,
  value: unknown,
  strict = false,
): Predicate {
  fieldPath(field, strict);
  const canonical = operator(op);
  const copied = snapshotValue(value);
  if (canonical === "in" && !Array.isArray(copied)) invalid("The in filter requires an array.");
  if (canonical === "is" && copied !== null && typeof copied !== "boolean")
    invalid("The is filter accepts null or a boolean.");
  if (["like", "ilike", "textSearch"].includes(canonical) && typeof copied !== "string")
    invalid("Text filters require a string.");
  if (canonical === "like" || canonical === "ilike") patternTokens(copied as string);
  if (
    ["contains", "containedBy"].includes(canonical) &&
    (copied === null || typeof copied !== "object")
  )
    invalid("Containment requires an array or JSON object.");
  if (canonical === "overlaps" && !Array.isArray(copied))
    invalid("The overlaps filter requires an array.");
  return { field, op: canonical, value: copied };
}
/** Supabase raw filter values are parsed as one value, never as additional branches. */
export function makeFilterPredicate(field: string, op: string, value: unknown): Predicate {
  if (typeof value !== "string") return makePredicate(field, op, value);
  fieldPath(field);
  const canonical = operator(op);
  if (["like", "ilike", "textSearch"].includes(canonical) && !value.startsWith('"'))
    return makePredicate(field, canonical, value);
  const expression = parseOr(`value.${canonical}.${value}`);
  const terms = expression.value as Predicate[];
  const leaf = terms[0];
  if (terms.length !== 1 || !leaf || leaf.field !== "value" || leaf.op !== canonical)
    invalid("A raw filter must contain exactly one value; use or() for alternatives.");
  return makePredicate(field, canonical, leaf.value);
}
export function matches(row: object, predicates: Predicate[]): boolean {
  return predicates.every((predicate) => testPredicate(row, predicate));
}
function testPredicate(row: object, { field, op, value }: Predicate): boolean {
  if (op === "and") return matches(row, value as Predicate[]);
  if (op === "or") return (value as Predicate[]).some((predicate) => testPredicate(row, predicate));
  if (op === "not") return !testPredicate(row, value as Predicate);
  const actual = fieldValue(row, field);
  switch (op) {
    case "eq":
    case "is":
      return equal(actual, value);
    case "neq":
      return !equal(actual, value);
    case "in":
      return Array.isArray(value) && value.some((entry) => equal(actual, entry));
    case "contains":
      return actual !== undefined && contains(actual, value);
    case "containedBy":
      return actual !== undefined && contains(value, actual);
    case "overlaps":
      return (
        Array.isArray(actual) &&
        Array.isArray(value) &&
        value.some((entry) => actual.some((item) => equal(item, entry)))
      );
    case "like":
    case "ilike":
      return (
        typeof actual === "string" &&
        typeof value === "string" &&
        like(actual, value, op === "ilike")
      );
    case "textSearch": {
      if (typeof actual !== "string" || typeof value !== "string") return false;
      const normalize = (text: string) =>
        text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
      return normalize(value)
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .every((word) => normalize(actual).includes(word));
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (
        !(typeof actual === "number" && typeof value === "number") &&
        !(typeof actual === "string" && typeof value === "string")
      )
        return false;
      if (op === "gt") return actual > value;
      if (op === "gte") return actual >= value;
      if (op === "lt") return actual < value;
      return actual <= value;
    }
  }
}
/** Bounded PostgREST-style logical expressions; every leaf is validated before use. */
export function parseOr(input: string): Predicate {
  if (typeof input !== "string" || !input.trim() || input.length > 8192)
    invalid("Logical filter must contain 1 to 8192 characters.");
  let index = 0,
    nodes = 0;
  const whitespace = () => {
    while (/\s/.test(input[index] ?? "") && index < input.length) index++;
  };
  function token(delimiters: string): string {
    whitespace();
    const start = index;
    let quote = false,
      escaped = false;
    const stack: string[] = [];
    while (index < input.length) {
      const char = input[index] ?? "";
      if (escaped) {
        escaped = false;
        index++;
        continue;
      }
      if (char === "\\" && quote) {
        escaped = true;
        index++;
        continue;
      }
      if (char === '"') {
        quote = !quote;
        index++;
        continue;
      }
      if (!quote) {
        if (!stack.length && delimiters.includes(char)) break;
        if (char === "[" || char === "{") stack.push(char === "[" ? "]" : "}");
        else if (char === "]" || char === "}") {
          if (stack.pop() !== char) invalid("Logical filter has unbalanced JSON.");
        }
      }
      index++;
    }
    if (quote || escaped || stack.length) invalid("Logical filter contains an incomplete value.");
    const value = input.slice(start, index).trim();
    if (!value) invalid("Logical filter contains an empty term.");
    return value;
  }
  function scalar(raw: string, depth = 0): unknown {
    if (depth > 32) invalid("Logical filter value is too deeply nested.");
    if (raw.startsWith("{") && raw.endsWith("}") && !/^\{\s*"(?:[^"\\]|\\.)*"\s*:/.test(raw)) {
      // PostgREST array literals: braces, with quoted elements for reserved characters.
      const body = raw.slice(1, -1);
      if (!body) return [];
      const entries: unknown[] = [];
      let start = 0,
        quoted = false,
        escaped = false;
      for (let offset = 0; offset <= body.length; offset++) {
        const char = body[offset];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (quoted && char === "\\") {
          escaped = true;
          continue;
        }
        if (char === '"') quoted = !quoted;
        if ((char === "," && !quoted) || offset === body.length) {
          const item = body.slice(start, offset).trim();
          if (!item || entries.length >= 256)
            invalid("Logical array literal is invalid or too large.");
          entries.push(scalar(item, depth + 1));
          start = offset + 1;
        }
      }
      if (quoted || escaped) invalid("Logical array literal is incomplete.");
      return entries;
    }
    if (raw.startsWith('"') || raw.startsWith("[") || raw.startsWith("{")) {
      try {
        return JSON.parse(raw);
      } catch {
        invalid("Logical filter value is not valid JSON.");
      }
    }
    if (raw === "null") return null;
    if (raw === "true" || raw === "false") return raw === "true";
    if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(raw)) {
      const value = Number(raw);
      if (!Number.isFinite(value)) invalid("Logical filter number must be finite.");
      return value;
    }
    if (/[()[\]{}"]/.test(raw))
      invalid("Quote logical filter strings that contain reserved characters.");
    return raw;
  }
  function list(depth: number, closing: boolean): Predicate[] {
    const output: Predicate[] = [];
    for (;;) {
      output.push(term(depth));
      whitespace();
      if (input[index] === ",") {
        index++;
        continue;
      }
      if (closing) {
        if (input[index++] !== ")") invalid("Logical filter group is not closed.");
      }
      return output;
    }
  }
  function term(depth: number): Predicate {
    if (++nodes > 256 || depth > 16)
      invalid("Logical filter exceeds 256 terms or 16 nested groups.");
    whitespace();
    const logical = /^(not\.)?(and|or|not)\(/.exec(input.slice(index));
    if (logical) {
      index += logical[0].length;
      const children = list(depth + 1, true);
      if (logical[2] === "not" && children.length !== 1) invalid("A not group requires one term.");
      let branch: Predicate =
        logical[2] === "not"
          ? { field: "", op: "not", value: children[0] }
          : { field: "", op: logical[2] as "and" | "or", value: children };
      if (logical[1]) branch = { field: "", op: "not", value: branch };
      return branch;
    }
    const field = token(".");
    if (input[index++] !== ".") invalid("Logical filter requires field.operator.value.");
    // Metadata uses a single documented dot path.
    let actualField = field;
    if (field === "_nostr") {
      actualField += `.${token(".")}`;
      if (input[index++] !== ".") invalid("Metadata filter requires an operator.");
    }
    let op = token(".");
    let negate = false;
    if (input[index++] !== ".") invalid("Logical filter requires an operator and value.");
    if (op === "not") {
      negate = true;
      op = token(".");
      if (input[index++] !== ".") invalid("Negated filter requires an operator and value.");
    }
    let value: unknown;
    if (op === "in") {
      whitespace();
      if (input[index] !== "(") invalid("Logical in values require parentheses.");
      index++;
      const entries: unknown[] = [];
      whitespace();
      if (input[index] !== ")") {
        for (;;) {
          entries.push(scalar(token(",)")));
          if (entries.length > 256) invalid("Logical in accepts at most 256 values.");
          if (input[index] !== ",") break;
          index++;
        }
      }
      if (input[index++] !== ")") invalid("Logical in list is not closed.");
      value = entries;
    } else value = scalar(token(",)"));
    const leaf = makePredicate(actualField, op, value, true);
    return negate ? { field: "", op: "not", value: leaf } : leaf;
  }
  const branches = list(0, false);
  whitespace();
  if (index !== input.length) invalid("Logical filter has trailing input.");
  return { field: "", op: "or", value: branches };
}

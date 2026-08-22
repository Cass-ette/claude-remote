import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import {
  COMMAND_STATUSES,
  COMMAND_TYPES,
  EVENT_TYPES,
  PROTOCOL_VERSION,
  UINT64_STRING_PATTERN,
  type Command,
  type CommandType,
  type ProtocolEvent,
  type ProtocolResponse,
} from "./types.js";

export { PROTOCOL_VERSION } from "./types.js";

/** Maximum accepted JSON serialization size of an inbound command: 256 KiB. */
export const MAX_COMMAND_BYTES = 256 * 1024;
const MAX_EVENT_ID = 18446744073709551615n;

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export interface ValidatedEvent {
  readonly event: ProtocolEvent;
  /** eventId parsed from its decimal-string form to a bigint. */
  readonly eventId: bigint;
}

const require = createRequire(import.meta.url);
// ajv-formats ships CJS with an esModule default; NodeNext cannot express
// that callable default import cleanly, so require it like runtime ESM would.
const addFormats = require("ajv-formats").default as (ajv: Ajv2020) => Ajv2020;

// contracts/v1/*.schema.json are the cross-language source of truth. Load
// them relative to this module whether running from src (vitest/tsx) or
// dist/src (built output).
const schemaCandidates = [
  "../../../../contracts/v1", // bridge/src/protocol/v1
  "../../../../../contracts/v1", // bridge/dist/src/protocol/v1
];
function loadSchema(name: string): AnySchema {
  for (const dir of schemaCandidates) {
    const url = new URL(`${dir}/${name}`, import.meta.url);
    const path = fileURLToPath(url);
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8"));
    }
  }
  throw new Error(`cannot locate contracts/v1/${name}`);
}

const ajv = new Ajv2020({ strict: true, allErrors: false });
addFormats(ajv);

const validateCommandSchema = ajv.compile(loadSchema("command.schema.json")) as ValidateFunction;
const validateResponseSchema = ajv.compile(loadSchema("response.schema.json")) as ValidateFunction;
const validateEventSchema = ajv.compile(loadSchema("event.schema.json")) as ValidateFunction;

function failure(validate: ValidateFunction, label: string): never {
  const detail = validate.errors?.[0]
    ? `${validate.errors[0].instancePath} ${validate.errors[0].message ?? ""}`.trim()
    : "schema validation failed";
  return { ok: false, error: `${label}: ${detail}` } as never;
}

/**
 * Validate an inbound command. Checks the 256 KiB serialization cap first,
 * then the full command schema (envelope + per-commandType payload).
 */
export function validateCommand(input: unknown): ValidationResult<Command> {
  if (input === null || typeof input !== "object") {
    return { ok: false, error: "command: expected an object" };
  }
  const serialized = JSON.stringify(input) ?? "";
  const serializedLength = Buffer.byteLength(serialized, "utf8");
  if (serializedLength > MAX_COMMAND_BYTES) {
    return {
      ok: false,
      error: `command: serialized size ${serializedLength} bytes exceeds 256 KiB limit`,
    };
  }
  if (!validateCommandSchema(input)) {
    return failure(validateCommandSchema, "command");
  }
  return { ok: true, value: input as Command };
}

/** Validate a protocol response produced by (or sent to) the bridge. */
export function validateResponse(input: unknown): ValidationResult<ProtocolResponse> {
  if (input === null || typeof input !== "object") {
    return { ok: false, error: "response: expected an object" };
  }
  if (!validateResponseSchema(input)) {
    return failure(validateResponseSchema, "response");
  }
  return { ok: true, value: input as ProtocolResponse };
}

/**
 * Validate an inbound/outbound event. On success the decimal-string eventId
 * is also parsed to a bigint (available as `eventId` on the result).
 */
export function validateEvent(input: unknown): ValidationResult<ValidatedEvent> {
  if (input === null || typeof input !== "object") {
    return { ok: false, error: "event: expected an object" };
  }
  if (!validateEventSchema(input)) {
    return failure(validateEventSchema, "event");
  }
  const event = input as ProtocolEvent;
  // The schema allows up to 20 digits but uint64 tops out lower; catch that
  // here so validateEvent stays total (never throws).
  try {
    return { ok: true, value: { event, eventId: parseEventId(event.eventId) } };
  } catch (err) {
    return { ok: false, error: `event: ${(err as Error).message}` };
  }
}

/** Parse a decimal-stringified uint64 to bigint. Throws on invalid input. */
export function parseEventId(value: string): bigint {
  if (!new RegExp(UINT64_STRING_PATTERN).test(value)) {
    throw new Error(`eventId must be a decimal string of 1-20 digits, got: ${JSON.stringify(value)}`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_EVENT_ID) {
    throw new Error(`eventId exceeds uint64 range: ${value}`);
  }
  return parsed;
}

// Re-export the enums so callers can check membership without Ajv.
export { COMMAND_STATUSES, COMMAND_TYPES, EVENT_TYPES };
export type { Command, CommandType };

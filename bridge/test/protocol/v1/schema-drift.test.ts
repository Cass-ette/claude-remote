import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMMAND_STATUSES,
  COMMAND_TYPES,
  EVENT_TYPES,
  UINT64_STRING_PATTERN,
} from "../../../src/protocol/v1/types.js";

// tsconfig does not enable resolveJsonModule (and contracts/ sits outside
// rootDir), so read the schema files via fs using the same path-candidate
// resolution style as validator.ts.
const schemaCandidates = [
  "../../../../contracts/v1", // bridge/test/protocol/v1
];
function loadSchema(name: string): Record<string, unknown> {
  for (const dir of schemaCandidates) {
    const path = fileURLToPath(new URL(`${dir}/${name}`, import.meta.url));
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8"));
    }
  }
  throw new Error(`cannot locate contracts/v1/${name}`);
}

const commandSchema = loadSchema("command.schema.json") as {
  properties: { commandType: { enum: string[] } };
  $defs: { uint64String: { pattern: string } };
  allOf: Array<{ if: { properties: { commandType: { const: string } } } }>;
};
const eventSchema = loadSchema("event.schema.json") as {
  properties: { eventType: { enum: string[] }; eventId: { pattern: string } };
};
const responseSchema = loadSchema("response.schema.json") as {
  properties: { commandStatus: { enum: string[] } };
};

describe("schema drift guard", () => {
  it("command.schema.json commandType enum matches COMMAND_TYPES exactly", () => {
    expect(commandSchema.properties.commandType.enum).toEqual([...COMMAND_TYPES]);
  });

  it("event.schema.json eventType enum matches EVENT_TYPES exactly", () => {
    expect(eventSchema.properties.eventType.enum).toEqual([...EVENT_TYPES]);
  });

  it("response.schema.json commandStatus enum matches COMMAND_STATUSES exactly", () => {
    expect(responseSchema.properties.commandStatus.enum).toEqual([...COMMAND_STATUSES]);
  });

  it("uint64 pattern is identical everywhere it appears", () => {
    expect(commandSchema.$defs.uint64String.pattern).toBe(UINT64_STRING_PATTERN);
    expect(eventSchema.properties.eventId.pattern).toBe(UINT64_STRING_PATTERN);
  });

  it("command.schema.json if/then chain covers every COMMAND_TYPES value", () => {
    const consts = commandSchema.allOf.map((branch) => branch.if.properties.commandType.const);
    expect(new Set(consts)).toEqual(new Set(COMMAND_TYPES));
    // No duplicates either.
    expect(consts).toHaveLength([...COMMAND_TYPES].length);
  });
});

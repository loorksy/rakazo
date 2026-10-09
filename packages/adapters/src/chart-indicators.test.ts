import { calculateIndicator } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { builtins, testIndicatorDefinition } from "./chart-indicator-definitions.js";

describe("safe indicator activation", () => {
  it.each(Object.entries(builtins))(
    "validates deployed built-in %s without forcing it on charts",
    (_id, definition) => {
      expect(testIndicatorDefinition(definition)).toEqual(definition);
    },
  );
  it("rejects malicious uploaded JSON instead of interpreting source code", () => {
    expect(() =>
      testIndicatorDefinition({
        definitionVersion: 1,
        name: "Uploaded",
        description: "Fixture",
        parameters: [],
        nodes: [
          { id: "script", op: "javascript", source: "fetch('https://fixture.invalid/secret')" },
        ],
        outputs: [],
      }),
    ).toThrow();
  });
  it("does not accept an unbounded definition even when short fixture output is empty", () => {
    const definition = builtins["builtin:SMA"];
    if (!definition) throw new Error("Fixture definition");
    expect(() =>
      testIndicatorDefinition({
        ...definition,
        parameters: [{ name: "period", default: 2, min: 1, max: 100000, integer: true }],
      }),
    ).toThrow("bounded");
  });
  it("accepts useful indicators independently of profitability", () => {
    const definition = builtins["builtin:VOL"];
    if (!definition) throw new Error("Fixture definition");
    expect(testIndicatorDefinition(definition)).toEqual(definition);
    expect(calculateIndicator(definition, []).outputs[0]?.values).toEqual([]);
  });
});

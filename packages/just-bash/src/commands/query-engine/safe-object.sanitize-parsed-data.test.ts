import { describe, expect, it } from "vitest";
import {
  type SanitizeParsedDataLimits,
  sanitizeParsedData,
} from "./safe-object.js";

describe.each([false, true])("sanitizeParsedData (inPlace: %s)", (inPlace) => {
  const sanitize = (value: unknown, limits: SanitizeParsedDataLimits = {}) =>
    sanitizeParsedData(value, { ...limits, inPlace });
  it("converts nested parsed objects to null-prototype records", () => {
    const input = {
      a: 1,
      nested: {
        b: 2,
      },
      list: [{ c: 3 }],
    };

    const result = sanitize(input) as {
      a: number;
      nested: { b: number };
      list: Array<{ c: number }>;
    };

    expect(result).toEqual({
      a: 1,
      nested: { b: 2 },
      list: [{ c: 3 }],
    });
    expect(result === input).toBe(inPlace);
    expect(Object.getPrototypeOf(input)).toBe(
      inPlace ? null : Object.prototype,
    );
    expect(Object.getPrototypeOf(result)).toBe(null);
    expect(Object.getPrototypeOf(result.nested)).toBe(null);
    expect(Object.getPrototypeOf(result.list[0])).toBe(null);
  });

  it("preserves Date instances", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    const result = sanitize({ when: date }) as { when: Date };
    expect(result.when).toBe(date);
    expect(result.when instanceof Date).toBe(true);
  });

  it("handles cyclic arrays without stack overflow", () => {
    const loop: unknown[] = [];
    loop.push(loop);

    const sanitized = sanitize(loop) as unknown[];

    expect(Array.isArray(sanitized)).toBe(true);
    expect(sanitized[0]).toBe(sanitized);
  });

  it("preserves shared references while sanitizing", () => {
    const shared = { value: 42 };
    const input = { left: shared, right: shared };

    const result = sanitize(input) as {
      left: { value: number };
      right: { value: number };
    };

    expect(result.left).toBe(result.right);
    expect(Object.getPrototypeOf(result.left)).toBe(null);
  });

  it("iteratively rejects malicious pre-parsed data above the depth limit", () => {
    const root: unknown[] = [];
    let cursor = root;
    for (let depth = 0; depth < 20; depth++) {
      const child: unknown[] = [];
      cursor.push(child);
      cursor = child;
    }

    expect(() => sanitize(root, { maxDepth: 19 })).toThrow(
      "query depth limit exceeded (19)",
    );
    expect(() => sanitize(root, { maxDepth: 20 })).not.toThrow();
  });

  it("charges aggregate array and object members before cloning", () => {
    expect(() => sanitize({ a: [1, 2, 3] }, { maxElements: 3 })).toThrow(
      "query input element limit exceeded (3)",
    );
    expect(() => sanitize({ a: [1, 2, 3] }, { maxElements: 4 })).not.toThrow();
  });
  it("preserves dangerous own keys without changing Object.prototype", () => {
    const original = Object.getOwnPropertyDescriptors(Object.prototype);
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"name":"own"},"prototype":3,"hasOwnProperty":4,"toString":5,"valueOf":6}',
    );
    const result = sanitize(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(result)).toBe(null);
    expect(Object.keys(result)).toEqual([
      "__proto__",
      "constructor",
      "prototype",
      "hasOwnProperty",
      "toString",
      "valueOf",
    ]);
    expect(result).toEqual(
      JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":{"name":"own"},"prototype":3,"hasOwnProperty":4,"toString":5,"valueOf":6}',
      ),
    );
    expect(Object.getPrototypeOf(result.__proto__)).toBe(null);
    expect(Object.getPrototypeOf(result.constructor)).toBe(null);
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(
      original,
    );
  });

  it("retains the shared element budget across documents", () => {
    const elementBudget = { used: 0 };
    const limits = { maxElements: 2, elementBudget };
    sanitize(JSON.parse('{"a":1}'), limits);
    sanitize(JSON.parse("[2]"), limits);
    expect(() => sanitize(JSON.parse('{"b":3}'), limits)).toThrow(
      "query input element limit exceeded (2)",
    );
    expect(elementBudget.used).toBe(2);
  });
});

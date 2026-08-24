import { describe, expect, it } from "vitest";
import type { TreeNode } from "@mycelium/core";
import { deriveConceptDescription, seedInstructions } from "../../src/mcp/seed.js";

describe("seed", () => {
  describe("deriveConceptDescription", () => {
    const name = "foo";
    const title = "Foo";
    const description =
      "a main-belt asteroid that was discovered on September 2nd, 1983, by the Belgian astronomer Henri Debehogne";

    const cases: Record<string, { input: Pick<TreeNode, 'name'> & Partial<Pick<TreeNode, 'title' | 'description'>>; expected: string }> = {
      "name only": {
        input: { name },
        expected: `**${name}**`,
      },
      "name and title": {
        input: { name, title },
        expected: `**${title}**`,
      },
      "name and description": {
        input: { name, description },
        expected: `**${name}**, ${description}`,
      },
      "name and title and description": {
        input: { name, title, description },
        expected: `**${title}**, ${description}`,
      },
    };

    Object.entries(cases).forEach(([test_desc, test_case]) => {
      it(`provides a suitable description for concept tree nodes containing ${test_desc}`, () => {
        const { input, expected } = test_case;

        const actual = deriveConceptDescription(input as TreeNode);

        expect(actual).toEqual(expected);
      });
    });
  });

  describe("seedInstructions", () => {
    it("states the book-only shelf rule", () => {
      const text = seedInstructions("MEMORY OVERVIEW HERE");
      expect(text).toContain("book-only");
      expect(text).toContain("global store");
    });

    it("no longer tells clients to put topic detail in the matching shelf", () => {
      const text = seedInstructions("MEMORY OVERVIEW HERE");
      expect(text).not.toContain("topic detail in the matching shelf");
    });
  });
});

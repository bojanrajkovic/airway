import { describe, expect, it } from "vitest";
import { authorLabel, type Author } from "../src/author.ts";

const person = (name: string, channel: Author["channel"]): Author => ({
  email: "sam@example.test",
  name,
  channel,
});

describe("authorLabel", () => {
  it.each([
    ["Sam Rivera", "web", "Sam"],
    ["Sam Rivera", "mcp", "Agent for Sam"],
    ["  Sam  ", "web", "Sam"],
    ["sam", "mcp", "Agent for sam"],
  ] as const)("labels %j on %s as %j", (name, channel, label) => {
    expect(authorLabel(person(name, channel))).toBe(label);
  });
});

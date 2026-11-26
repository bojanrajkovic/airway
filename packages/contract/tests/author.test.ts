import { describe, expect, it } from "vitest";
import { authorLabel, Channel, type Author } from "../src/author.ts";

const person = (name: string, channel: Author["channel"]): Author => ({
  email: "sam@example.test",
  name,
  channel,
});

describe("authorLabel", () => {
  it.each([
    ["Sam Rivera", Channel.Web, "Sam"],
    ["Sam Rivera", Channel.Mcp, "Agent for Sam"],
    ["  Sam  ", Channel.Web, "Sam"],
    ["sam", Channel.Mcp, "Agent for sam"],
  ] as const)("labels %j on %s as %j", (name, channel, label) => {
    expect(authorLabel(person(name, channel))).toBe(label);
  });
});

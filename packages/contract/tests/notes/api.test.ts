import { describe, expect, test } from "vitest";
import { AddNote, findingNights, UpdateNote } from "../../src/notes/api.ts";
import { parseSpec, type QuerySpec } from "../../src/query/spec.ts";

const note = {
  firstNight: Temporal.PlainDate.from("2030-01-10"),
  category: "other",
  body: "Synthetic note.",
};

describe("AddNote", () => {
  test("accepts a note without an author", () => {
    expect(AddNote.safeParse(note).success).toBe(true);
  });

  test("rejects a note that names its author", () => {
    expect(AddNote.safeParse({ ...note, authorEmail: "a@example.com" }).success).toBe(false);
  });

  test("rejects a 32,001-character body and accepts 32,000", () => {
    expect(AddNote.safeParse({ ...note, body: "x".repeat(32_001) }).success).toBe(false);
    expect(AddNote.safeParse({ ...note, body: "x".repeat(32_000) }).success).toBe(true);
  });

  test("counts an emoji as one character, as Postgres does", () => {
    expect(AddNote.safeParse({ ...note, body: "🫁".repeat(32_000) }).success).toBe(true);
  });

  test("rejects a body of only spaces", () => {
    expect(AddNote.safeParse({ ...note, body: "  \n " }).success).toBe(false);
  });

  test("rejects the finding category, which only saving a finding sets", () => {
    expect(AddNote.safeParse({ ...note, category: "finding" }).success).toBe(false);
  });

  test("rejects a night given as text", () => {
    expect(AddNote.safeParse({ ...note, firstNight: "2030-01-10" }).success).toBe(false);
  });
});

test("UpdateNote takes an ID and only the fields that change", () => {
  expect(UpdateNote.safeParse({ id: 3, body: "Edited." }).success).toBe(true);
  expect(UpdateNote.safeParse({ body: "Edited." }).success).toBe(false);
  expect(UpdateNote.safeParse({ id: 3, authorName: "Alex" }).success).toBe(false);
});

describe("findingNights", () => {
  const spec = (nights: unknown): QuerySpec =>
    parseSpec({ v: 1, dataset: "nights", nights })._unsafeUnwrap();

  test("gives a fixed range's first and last night", () => {
    expect(findingNights(spec({ from: "2030-01-01", to: "2030-01-14" }))._unsafeUnwrap()).toEqual({
      firstNight: Temporal.PlainDate.from("2030-01-01"),
      lastNight: Temporal.PlainDate.from("2030-01-14"),
    });
  });

  test("rejects a range relative to today", () => {
    expect(findingNights(spec({ last: 14 }))._unsafeUnwrapErr()).toBe("relative_nights");
  });
});

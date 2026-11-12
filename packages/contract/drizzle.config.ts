import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` writes the notes migrations from the schema. It needs no database.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/notes/schema.ts",
  out: "./drizzle",
});

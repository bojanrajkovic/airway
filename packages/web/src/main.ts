// Some browsers don't ship Temporal yet. The polyfill loads only there, and before any module that
// uses Temporal at the top level, so the app imports after it.
if (!("Temporal" in globalThis)) {
  await import("temporal-polyfill/global");
}

const { start } = await import("./start.tsx");
const root = document.getElementById("root");

if (root === null) {
  throw new Error("index.html has no #root element");
}

start(root);

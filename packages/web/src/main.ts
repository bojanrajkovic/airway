// Some browsers don't ship Temporal yet. Those browsers load the polyfill before the app, because
// some of the app's modules use Temporal at the top level.
if (!("Temporal" in globalThis)) {
  await import("temporal-polyfill/global");
}

const { start } = await import("./start.tsx");
const root = document.getElementById("root");

if (root === null) {
  throw new Error("index.html has no #root element");
}

start(root);

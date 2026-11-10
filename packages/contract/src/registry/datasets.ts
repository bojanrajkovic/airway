import { breaths } from "./breaths.ts";
import { events } from "./events.ts";
import { nights } from "./nights.ts";
import { samples } from "./samples.ts";
import { sessions } from "./sessions.ts";

/** Every dataset the builder and the agent tools can query. */
export const DATASETS = [nights, sessions, events, samples, breaths] as const;

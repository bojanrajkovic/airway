import { breaths } from "./breaths.ts";
import { events } from "./events.ts";
import { nights } from "./nights.ts";
import { samples } from "./samples.ts";
import { sessions } from "./sessions.ts";

/** All queryable datasets. */
export const DATASETS = [nights, sessions, events, samples, breaths] as const;

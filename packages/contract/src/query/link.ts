import { err, ok, Result } from "neverthrow";
import { canonicalJson } from "./canonical.ts";
import { parseSpec, type QuerySpec, type SpecIssue } from "./spec.ts";

/**
 * The longest explorer link, in characters of path and query. It leaves room under the server's
 * header limit for cookies and the identity proxy's headers.
 */
export const LINK_LIMIT = 4000;

/**
 * The explorer link for a query: `/explore?q=` and its canonical JSON. A spec too long for a link
 * is an error, and its short link is the one to share.
 */
export function toExploreUrl(spec: QuerySpec): Result<string, "too_long"> {
  const url = `/explore?q=${encodeURIComponent(canonicalJson(spec))}`;

  return url.length > LINK_LIMIT ? err("too_long") : ok(url);
}

/** A link's `q` that isn't a valid spec, with its text kept so the error view can show it. */
export type BadExploreQuery = { raw: string; issues: SpecIssue[] };

const parseJson = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text),
  (): SpecIssue[] => [{ path: "", message: "the query isn't JSON" }],
);

/** Reads the decoded `q` of an explorer link. */
export function parseExploreQuery(q: string): Result<QuerySpec, BadExploreQuery> {
  return parseJson(q)
    .andThen(parseSpec)
    .mapErr((issues) => ({ raw: q, issues }));
}

import { err, ok, Result } from "neverthrow";
import { canonicalJson } from "./canonical.ts";
import { parseSpec, type QuerySpec, type SpecIssue } from "./spec.ts";

/**
 * The maximum length of an explorer link, in characters of path and query string. Node rejects a
 * request whose headers exceed 16 KB. Cookies and the identity proxy's headers also count toward
 * that 16 KB, so the limit is well below it.
 */
export const LINK_LIMIT = 4000;

/**
 * Builds the explorer link for a query, which is `/explore?q=` followed by the query's canonical
 * JSON, percent-encoded.
 * Returns `too_long` when the link is longer than `LINK_LIMIT`. A caller that gets `too_long` shares
 * the short link instead.
 */
export function toExploreUrl(spec: QuerySpec): Result<string, "too_long"> {
  const url = `/explore?q=${encodeURIComponent(canonicalJson(spec))}`;

  return url.length > LINK_LIMIT ? err("too_long") : ok(url);
}

/**
 * Describes why `parseExploreQuery` couldn't read a link's `q`. `raw` is the `q` text from the
 * link, which the error view shows.
 */
export type BadExploreQuery = { raw: string; issues: SpecIssue[] };

const parseJson = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text),
  (): SpecIssue[] => [{ path: "", message: "the query isn't JSON" }],
);

/**
 * Reads an explorer link's `q`, already percent-decoded, as a spec. Fails when the text isn't
 * JSON or isn't a valid spec.
 */
export function parseExploreQuery(q: string): Result<QuerySpec, BadExploreQuery> {
  return parseJson(q)
    .andThen(parseSpec)
    .mapErr((issues) => ({ raw: q, issues }));
}

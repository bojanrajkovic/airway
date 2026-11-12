import { err, ok, Result } from "neverthrow";
import { canonicalJson } from "./canonical.ts";
import { parseSpec, type QuerySpec, type SpecIssue } from "./spec.ts";

/**
 * The longest explorer link we make, counting the path and query string. Node rejects requests
 * whose headers pass 16 KB, and cookies and the identity proxy's headers count toward that, so
 * links stay well below it.
 */
export const LINK_LIMIT = 4000;

/**
 * Builds the explorer link for a query: `/explore?q=` followed by the canonical JSON, percent-encoded.
 * Returns `too_long` when the link would pass `LINK_LIMIT`; share the short link instead.
 */
export function toExploreUrl(spec: QuerySpec): Result<string, "too_long"> {
  const url = `/explore?q=${encodeURIComponent(canonicalJson(spec))}`;

  return url.length > LINK_LIMIT ? err("too_long") : ok(url);
}

/**
 * Why a link's `q` couldn't be read. `raw` is the text as the link had it, so the error view can
 * show it.
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

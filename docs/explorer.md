# Explorer

This doc describes the explorer page, its links, and the query history.

The links are built. The page is still to come.

## Links

A query has two links, both made from its [canonical form](query.md#canonical-form).

| Link | Form | Made by |
|---|---|---|
| Full | `/explore?q=<canonical JSON>`, percent-encoded | `toExploreUrl(spec)` in `@airway/contract/query/link` |
| Short | `/s/<code>` | `shortCode(target)` in `@airway/contract/query/short-code` |

The full link contains the whole query. A person or an agent can read and edit it. The page parses the query from the link without a database lookup. A full link is capped at 4,000 characters of path and query. Node rejects a request whose headers, request line included, exceed 16 KB in total. The 4,000-character cap reserves the rest of that 16 KB for cookies and the identity proxy's headers. When a spec's link would be longer than the cap, `toExploreUrl` returns `too_long`, and the short link is the link to share.

`parseExploreQuery(q)` reads a link's decoded `q`. When the text isn't JSON or isn't a valid spec, the error includes the raw text and the issues, so the page can show the text of the bad link.

## Short codes

A short code is ten characters of lower-case Crockford base32 (no `i`, `l`, `o`, or `u`), taken from the SHA-256 of its target. A target is a builder spec or a SQL statement.

- `shortCode` always returns the same code for the same query, because it hashes the canonical JSON.
- The hash covers the target's kind, so a spec and a SQL text never share a code.
- A SQL statement is hashed as written, apart from white space at its ends.

Ten characters are 50 bits. airway supports a single patient, so it stores few enough links that a collision is unlikely. `code` is the primary key of `notes.short_links`, so inserting a code that's already stored fails.

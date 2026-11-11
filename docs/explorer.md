# Explorer

The explorer page, its links, and the query history.

The page isn't built yet. Its links are.

## Links

A query has two links, both made from its [canonical form](query.md#canonical-form).

| Link | Form | Made by |
|---|---|---|
| Full | `/explore?q=<canonical JSON>`, percent-encoded | `toExploreUrl(spec)` in `@airway/contract/query/link` |
| Short | `/s/<code>` | `shortCode(target)` in `@airway/contract/query/short-code` |

The full link holds the whole query, so a person or an agent can read it and change it, and opening it needs no stored row. It's capped at 4,000 characters of path and query, which leaves room under the server's header limit for cookies and the identity proxy's headers. `toExploreUrl` returns `too_long` for a spec over the cap, and the short link is then the one to share.

`parseExploreQuery(q)` reads a link's decoded `q`. When the text isn't JSON or isn't a valid spec, the error carries the raw text beside the issues, so the page can show what the link said.

## Short codes

A short code is ten characters of lower-case Crockford base32 (no `i`, `l`, `o`, or `u`), taken from the SHA-256 of its target. A target is a builder spec or a SQL statement.

- The same query always gets the same code, because the hash is over the canonical JSON.
- The hash covers the target's kind, so a spec and a SQL text never share a code.
- A SQL statement is hashed as written, apart from white space at its ends.

Ten characters are 50 bits. Two different targets sharing a code is unlikely at any number of links a household makes, and whatever stores the links refuses a code that already holds something else.

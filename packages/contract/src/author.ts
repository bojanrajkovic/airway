/** Where a request came from: the web app, or an agent over MCP. */
export type Channel = "web" | "mcp";

/** Who made a request, from the identity proxy's verified token or the configured local person. */
export type Author = {
  email: string;
  /** Never empty: a token without a name falls back to the email's local part. */
  name: string;
  channel: Channel;
};

/** How the app shows an author: their first name, or "Agent for <first name>" for an agent. */
export function authorLabel(author: Author): string {
  const [first = author.name] = author.name.trim().split(/\s+/v);

  return author.channel === "mcp" ? `Agent for ${first}` : first;
}

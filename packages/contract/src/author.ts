/** A request comes from the web app or from an agent over MCP. */
export const CHANNELS = ["web", "mcp"] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Identifies who made a request. The server builds it from the identity proxy's verified token or
 * from the configured local person.
 */
export type Author = {
  email: string;
  /** A token without a name uses the local part of the email, so `name` is always set. */
  name: string;
  channel: Channel;
};

/**
 * Returns the label the app shows for an author. The label is the author's first name, or
 * "Agent for <first name>" when the author is an agent.
 */
export function authorLabel(author: Author): string {
  const [first = author.name] = author.name.trim().split(/\s+/v);

  return author.channel === "mcp" ? `Agent for ${first}` : first;
}

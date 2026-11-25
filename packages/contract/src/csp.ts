/**
 * The server sends this one Content-Security-Policy with every response.
 * The browser loads scripts, styles, images, and fonts only from airway's own origin.
 * The policy blocks inline scripts, inline styles, plugins, and framing.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

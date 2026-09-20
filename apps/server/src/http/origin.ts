/**
 * Decides whether a browser origin may use this server. The API is unauthenticated, and neither
 * CORS (which only hides responses) nor WebSockets (which ignore CORS) stop a hostile web page
 * from *sending* requests to a server its visitor can reach — so the Origin header is enforced
 * server-side. Requests without an Origin come from non-browser clients and are allowed.
 *
 * The origin is compared with configuration only, never with the request's Host header: both
 * are attacker-controlled under DNS rebinding. A same-origin deployment lists its own origin
 * in ALLOWED_ORIGINS.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === undefined) return true;
  return allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

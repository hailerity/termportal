/**
 * Decides whether a browser origin may use this server. The API is unauthenticated, and neither
 * CORS (which only hides responses) nor WebSockets (which ignore CORS) stop a hostile web page
 * from *sending* requests to a server its visitor can reach — so the Origin header is enforced
 * server-side. Requests without an Origin come from non-browser clients and are allowed.
 */
export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === undefined) return true;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return true;
  try {
    // Same-origin: the page was served by this very host.
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false;
  }
}

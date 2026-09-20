const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz';
const TOKEN_LENGTH = 22;

/** Generates an unguessable `term_…` id (~126 bits) from the platform CSPRNG. */
export function generateSessionId(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH * 2);
  let token = '';
  // Rejection sampling keeps the distribution over the alphabet uniform.
  const limit = 256 - (256 % ALPHABET.length);
  while (token.length < TOKEN_LENGTH) {
    globalThis.crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      token += ALPHABET[byte % ALPHABET.length];
      if (token.length === TOKEN_LENGTH) break;
    }
  }
  return `term_${token}`;
}

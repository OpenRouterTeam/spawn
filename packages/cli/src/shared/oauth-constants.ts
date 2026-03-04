/**
 * Regex for validating OAuth authorization codes from the callback.
 * Must accept alphanumeric, hyphens, and underscores — OAuth providers
 * (GitHub, Google, etc.) use all of these in their auth codes.
 *
 * Kept in a separate file so tests can import it without pulling in
 * the full oauth.ts dependency tree (valibot, Bun.serve, etc.).
 */
export const OAUTH_CODE_REGEX = /^[a-zA-Z0-9_-]{16,128}$/;

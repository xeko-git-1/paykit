/**
 * Canonical JWT claims for the admin (jwt) auth plane.
 *
 * The service mounts jwtAuthMiddleware with these issuer/audience values, and
 * any JWT minter (CLI `jwt mint`, future dashboard login) must sign matching
 * claims or verification fails. Single source of truth prevents drift between
 * signer and verifier.
 */
export const JWT_ISSUER = "paykit";
export const JWT_AUDIENCE = "paykit-dashboard";

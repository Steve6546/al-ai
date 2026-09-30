/**
 * Remote access is an instance-wide deployment setting, not a per-guild one:
 * it decides which origins this dashboard answers at all. Three modes, ordered
 * by how far the deployment reaches:
 *
 * - **off** — loopback only. The default for anyone who takes the project.
 * - **lan** — loopback plus the machine's own private addresses, which is the
 *   router's network.
 * - **tunnel** — lan plus one Cloudflare quick-tunnel hostname, which is how
 *   the dashboard becomes reachable from the open internet without forwarding
 *   a port on the router.
 */
export const REMOTE_ACCESS_MODES = ["off", "lan", "tunnel"] as const;
export type RemoteAccessMode = (typeof REMOTE_ACCESS_MODES)[number];

export function isRemoteAccessMode(value: unknown): value is RemoteAccessMode {
  return typeof value === "string" && (REMOTE_ACCESS_MODES as readonly string[]).includes(value);
}

/**
 * Anything unrecognised collapses to "off". A garbled row must never widen
 * access: the safe direction for a setting that governs reachability is the
 * most restrictive one, and `off` still leaves the local operator in control.
 */
export function normaliseRemoteAccessMode(value: unknown): RemoteAccessMode {
  return isRemoteAccessMode(value) ? value : "off";
}

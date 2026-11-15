/**
 * Remote access is an instance-wide deployment setting, not a per-guild one:
 * it decides which origins this dashboard answers at all. Three modes, ordered
 * by how far the deployment reaches:
 *
 * - **off** — loopback only. The default for anyone who takes the project.
 * - **lan** — loopback plus the machine's own private addresses, which is the
 *   router's network.
 * - **tunnel** — lan plus one stable ngrok hostname, which is how
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

/**
 * Which of the machine's addresses can genuinely be advertised to another
 * device on the same router.
 *
 * `os.networkInterfaces()` reports every adapter, including ones that are not
 * doors onto this machine: a VPN's tunnel interface, a VirtualBox/WSL/Docker
 * host-only NIC, Bluetooth PAN, and the loopback. Their addresses are real but
 * a phone on the Wi-Fi cannot open a single one of them. APIPA (169.254/16)
 * means DHCP failed, and 192.168.56.0/24 is the VirtualBox host-only default.
 * IPv6 link-local (fe80::) needs a scope id a URL cannot carry, and the BFF
 * binds IPv4 in any case.
 *
 * Filtering here — once, in the shared layer — keeps the API that builds the
 * URLs and the screen that prints them from drifting into two different ideas
 * of "reachable". This is a *display* filter only. The host gate deliberately
 * still uses the unfiltered list: an address the machine really owns must be
 * accepted even when it is a poor thing to put in front of the operator.
 */
/**
 * Adapters that are not a door onto the router's LAN.
 *
 * `os.networkInterfaces()` reports every adapter, including ones a phone on the
 * Wi-Fi cannot open: a VPN's tunnel NIC (`wg`, `tun`, `utun`, `ppp`, Tailscale,
 * ZeroTier, HotspotShield), a VirtualBox/WSL/Docker host-only NIC, Bluetooth
 * PAN, and the loopback. Their addresses are real, but advertising one of them
 * is how a QR code ends up pointing at `10.234.0.9` — reachable only from
 * inside the VPN — instead of the Wi-Fi address the router actually routes.
 *
 * `tun\d*` and `tap[-_]` are anchored to the adapter-name spelling on purpose:
 * an unanchored `tun` would also match words like "Fortune", and `tap` alone
 * would match "Tapioca". `Ethernet N` is NOT filtered: it is often the real
 * wired NIC; the VirtualBox default address is excluded by range instead.
 */
export const VPN_ADAPTER_PATTERN =
  /wireguard|vpn|openvpn|hotspotshield|nordlynx|proton|tailscale|zerotier|tun\d*|utun|ppp|tap[-_]/i;
const VIRTUAL_ADAPTER_PATTERN = /virtual|vmware|virtualbox|hyper-?v|vethernet|wsl|docker|loopback|bluetooth/i;
const UNUSABLE_ADAPTER = new RegExp(
  `${VPN_ADAPTER_PATTERN.source}|${VIRTUAL_ADAPTER_PATTERN.source}`,
  "i"
);

/** True when the adapter name is a VPN/tunnel NIC rather than a LAN NIC. */
export function isVpnAdapter(name: string): boolean {
  return VPN_ADAPTER_PATTERN.test(name);
}

export type LanHostEntry = { host: string; label: string };

/**
 * RFC 1918 private IPv4. The tunnel's loopback peer arrives as
 * `::ffff:127.0.0.1`, so the IPv4-mapped prefix is stripped first.
 */
export function isPrivateLanAddress(host: string | undefined | null): boolean {
  if (!host) return false;
  const value = host.trim().replace(/^::ffff:/i, "");
  if (value.includes(":")) return false;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function isReachableLanHost(host: string): boolean {
  return (
    isPrivateLanAddress(host) &&
    !host.startsWith("169.254.") &&
    !host.startsWith("192.168.56.")
  );
}

export function reachableLanEntries(entries: readonly LanHostEntry[]): LanHostEntry[] {
  return entries.filter(
    ({ host, label }) => isReachableLanHost(host) && !UNUSABLE_ADAPTER.test(label)
  );
}

/** The URL a device on the router would type. Never a placeholder: both parts
 * come from the live socket and the live interface table. */
export function lanUrlFor(host: string, port: number): string {
  return `http://${host}:${port}`;
}

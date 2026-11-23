import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';

/**
 * IPv4/IPv6 address helpers.
 *
 * The link uses a dual-stack socket so a single socket can both offer and reach
 * IPv6 candidates. Node needs IPv4 destinations written in mapped form
 * (`::ffff:1.2.3.4`) on such a socket, and reports inbound IPv4 peers the same
 * way, so every address crossing the boundary is normalised here.
 */

const MAPPED_PREFIX = '::ffff:';

export function isIpv6(address: string): boolean {
  return address.includes(':') && !address.startsWith(MAPPED_PREFIX);
}

/** IPv4 address suitable for a dual-stack (udp6) socket. */
export function toMapped(address: string): string {
  if (address.includes(':')) return address;
  return MAPPED_PREFIX + address;
}

/** Strip the IPv4-mapped prefix so callers always see plain dotted quads. */
export function toCanonical(address: string): string {
  if (address.startsWith(MAPPED_PREFIX)) return address.slice(MAPPED_PREFIX.length);
  return address;
}

export interface GatheredCandidate {
  kind: 'host';
  address: string;
  port: number;
  priority: number;
}

/**
 * Local addresses a peer could plausibly reach.
 *
 * IPv6 global unicast ranks above IPv4: a global v6 address is directly
 * routable with no NAT to traverse, which is the cheapest possible P2P path.
 * Link-local v6 (`fe80::`) is skipped because it needs a zone index that cannot
 * be expressed in a candidate.
 */
export function localCandidates(port: number): GatheredCandidate[] {
  const out: GatheredCandidate[] = [];
  const ifaces = networkInterfaces();
  const seen = new Set<string>();

  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list ?? []) {
      if (info.internal) continue;
      const address = info.address;
      if (seen.has(address)) continue;

      if (info.family === 'IPv6') {
        const lower = address.toLowerCase();
        if (lower.startsWith('fe80')) continue; // link-local, needs a zone id
        if (lower.startsWith('fd') || lower.startsWith('fc')) {
          // Unique-local v6 is reachable only inside the site; keep it below global.
          out.push({ kind: 'host', address, port, priority: 70 });
        } else {
          out.push({ kind: 'host', address, port, priority: 300 });
        }
        seen.add(address);
      } else if (info.family === 'IPv4') {
        // VMware/Hyper-V/WSL virtual adapters are reachable from the host only;
        // ranking them last stops them from delaying a real candidate.
        const virtual = /vmware|virtualbox|hyper-v|vethernet|wsl|loopback|docker/i.test(name);
        out.push({ kind: 'host', address, port, priority: virtual ? 20 : 100 });
        seen.add(address);
      }
    }
  }

  out.push({ kind: 'host', address: '127.0.0.1', port, priority: 10 });
  return out.sort((a, b) => b.priority - a.priority);
}

/** Best-effort probe of whether this host has a globally routable IPv6 address. */
export function hasGlobalIpv6(): boolean {
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv6' || info.internal) continue;
      const lower = info.address.toLowerCase();
      if (lower.startsWith('fe80') || lower.startsWith('fd') || lower.startsWith('fc')) continue;
      return true;
    }
  }
  return false;
}

/**
 * Addresses a phone on the same network can actually reach.
 *
 * Virtual adapters (VMware, Hyper-V, WSL, Docker) are filtered out: they look
 * like LAN addresses but only work from the host itself, so showing them would
 * send users chasing an address that never answers. APIPA addresses
 * (`169.254.x.x`) mean DHCP failed and are equally useless. What remains is
 * ordered so the most typical home/office subnet comes first.
 */
export function lanAddresses(): string[] {
  const entries: Array<{ name: string; address: string }> = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.internal) continue;
      if (info.family !== 'IPv4') continue;
      entries.push({ name, address: info.address });
    }
  }
  return rankLanAddresses(entries);
}

const VIRTUAL_ADAPTER = /vmware|vmnet|virtualbox|hyper-v|vethernet|wsl|docker|loopback/i;

/**
 * Filter and order candidate LAN addresses. Kept pure so the selection rules can
 * be tested without depending on the network adapters of the machine running
 * the test.
 */
export function rankLanAddresses(entries: Array<{ name: string; address: string }>): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (VIRTUAL_ADAPTER.test(entry.name)) continue;
    if (entry.address.startsWith('169.254.')) continue;
    if (!out.includes(entry.address)) out.push(entry.address);
  }
  return out.sort((a, b) => privateRank(a) - privateRank(b));
}

/** Lower sorts first: RFC1918 home/office ranges beat anything else. */
function privateRank(address: string): number {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  const second = Number(address.split('.')[1]);
  if (address.startsWith('172.') && second >= 16 && second <= 31) return 2;
  return 3;
}

/** One shared dgram socket factory so both udp4 and udp6 bind the same way. */
export function createSocket(dualStack: boolean): dgram.Socket {
  // `ipv6Only: false` is what makes one socket serve both families.
  return dualStack ? dgram.createSocket({ type: 'udp6', ipv6Only: false }) : dgram.createSocket('udp4');
}

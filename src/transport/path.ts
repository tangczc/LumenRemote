import type { Candidate } from '../signaling/protocol.ts';
import type { Endpoint } from './link.ts';
import type { UdpLink } from './link.ts';
import type { Session } from './session.ts';

export interface PathResult {
  route: 'p2p' | 'relay';
  endpoint: Endpoint;
  kind?: Candidate['kind'];
  /**
   * Present when the relay was chosen: keeps retrying the peer candidates in the
   * background and resolves true once one of them answers. Hole punching can fail
   * on timing alone, so giving up for the whole session is wasteful.
   */
  upgrade?: (onUpgraded: (endpoint: Endpoint) => void) => void;
  /** Stops any background upgrade attempt. */
  cancelUpgrade?: () => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Addresses that cannot be a reachable relay for the other side. */
function unreachableAsRelay(address: string): boolean {
  const dotted = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (dotted === '::1' || dotted === '127.0.0.1' || dotted.startsWith('127.')) return true;
  if (dotted.startsWith('169.254.') || dotted.startsWith('fe80:')) return true;
  // RFC1918 and the CGNAT range: a cloud VM's NIC usually only has one of these,
  // with the public address arriving through 1:1 NAT.
  if (/^10\./.test(dotted) || /^192\.168\./.test(dotted)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(dotted)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(dotted)) return true;
  return false;
}

/**
 * Pick the relay endpoint to actually send media to.
 *
 * The relay is the signalling server itself, so the address it advertises must be
 * the one this client dialled. Two server-side mistakes are repaired here:
 *
 * - a build that advertised the *host's* address (media went to the peer's WAN IP
 *   on the relay port, nothing arrived, both sides timed out after 8 s);
 * - a server behind 1:1 NAT that advertised its private NIC address (10.x), which
 *   no client can reach -- the public address is the one we already dialled.
 *
 * Both ends must agree, and they do: each client computes this from its own
 * signalling connection.
 */
export function pickRelayAddress(
  advertised: Endpoint,
  candidates: Candidate[],
  dialledAddress: string,
): Endpoint {
  if (dialledAddress.length === 0) return advertised;
  const looksLikePeer = candidates.some((c) => c.address === advertised.address);
  if (!looksLikePeer && !unreachableAsRelay(advertised.address)) return advertised;
  return { address: dialledAddress, port: advertised.port };
}

const sameEndpoint = (a: Endpoint | null, b: Endpoint): boolean =>
  a !== null && a.port === b.port && a.address === b.address;

const keyOf = (e: Endpoint): string => `${e.address}:${e.port}`;

/**
 * Pick the best path among everything that answered.
 *
 * Every candidate is probed at once, so several may reply; taking the first one
 * would often mean a hairpin-NAT detour when a direct LAN path also works.
 * Priority decides instead, falling back to the first responder when the reply
 * came from an address we never advertised (a NAT rewrote the port).
 */
function bestResponder(link: UdpLink, ordered: Candidate[]): Endpoint | null {
  const seen = link.seenSources();
  if (seen.length === 0) return link.remoteEndpoint;
  const byKey = new Map(ordered.map((c) => [`${c.address}:${c.port}`, c]));
  let best: Endpoint | null = null;
  let bestPriority = -1;
  for (const endpoint of seen) {
    const candidate = byKey.get(keyOf(endpoint));
    if (!candidate) continue;
    const priority = candidate.priority ?? 0;
    if (priority > bestPriority) {
      bestPriority = priority;
      best = endpoint;
    }
  }
  return best ?? seen[0]!;
}

/**
 * Punch every peer candidate at once, then settle for the relay when none of
 * them answers.
 *
 * Both sides call this concurrently. Because each endpoint fans out to all
 * candidates simultaneously and then latches onto the first inbound datagram,
 * one direction getting through is enough — which is exactly the condition a
 * NAT punch needs. Probing candidates serially would make the total cost scale
 * with the candidate count and let earlier bindings expire.
 */
export async function selectDataPath(opts: {
  link: UdpLink;
  session: Session;
  candidates: Candidate[];
  relay: Endpoint;
  probeMs?: number;
}): Promise<PathResult> {
  const { link, session, relay } = opts;
  const probeMs = opts.probeMs ?? 400;

  const ordered = [...opts.candidates]
    .filter((c) => c.address && c.port > 0)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  if (ordered.length > 0) {
    const before = session.stats.packetsReceived;
    link.setCandidates(ordered.map((c) => ({ address: c.address, port: c.port })));
    await sleep(probeMs);
    if (link.latched || session.stats.packetsReceived > before) {
      const chosen = bestResponder(link, ordered);
      if (chosen) {
        link.setRemote(chosen);
        const hit = ordered.find((c) => sameEndpoint(chosen, c));
        return { route: 'p2p', endpoint: chosen, kind: hit?.kind };
      }
    }
    link.setRemote(relay);
  }

  link.setRemote(relay);
  await sleep(Math.min(probeMs, 200));

  // The media keeps flowing over the relay while the upgrade runs, so a failed
  // punch never interrupts the user; success just swaps the destination.
  let cancelled = false;
  let upgrading = false;
  const upgrade = (onUpgraded: (endpoint: Endpoint) => void): void => {
    if (upgrading || ordered.length === 0) return;
    upgrading = true;
    void (async () => {
      const peers = ordered.map((c) => ({ address: c.address, port: c.port }));
      // NAT bindings from the initial attempt may have expired, so keep the
      // pinholes warm with an escalating cadence instead of a tight loop.
      for (const delayMs of [1500, 3000, 5000, 8000, 12000]) {
        if (cancelled) return;
        await sleep(delayMs);
        if (cancelled) return;
        const before = session.stats.packetsReceived;
        link.setCandidates(peers);
        const probeUntil = Date.now() + 900;
        while (Date.now() < probeUntil) {
          await sleep(150);
          if (cancelled) {
            link.setRemote(relay);
            return;
          }
          if (link.latched || session.stats.packetsReceived > before) {
            const chosen = bestResponder(link, ordered);
            if (chosen) {
              upgrading = false;
              // Pin the p2p endpoint explicitly: latching already did it, but the
              // packetsReceived heuristic may have fired without a latch.
              link.setRemote(chosen);
              onUpgraded(chosen);
              return;
            }
          }
        }
        if (cancelled) return;
        link.setRemote(relay);
      }
      upgrading = false;
    })();
  };
  const cancelUpgrade = (): void => {
    cancelled = true;
    // Restoring the relay matters: leaving no destination at all would black-hole
    // the media that is still flowing through it.
    link.setRemote(relay);
  };

  return { route: 'relay', endpoint: relay, upgrade, cancelUpgrade };
}

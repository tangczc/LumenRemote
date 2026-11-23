import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import dgram from 'node:dgram';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { hasGlobalIpv6, isIpv6, localCandidates, rankLanAddresses, toCanonical, toMapped } from '../src/net/address.ts';
import { attachWebSocketServer } from '../src/net/ws.ts';
import { UdpLink } from '../src/transport/link.ts';
import { selectDataPath } from '../src/transport/path.ts';

describe('address helpers', () => {
  test('maps IPv4 for a dual-stack socket and canonicalises it back', () => {
    assert.equal(toMapped('192.168.1.5'), '::ffff:192.168.1.5');
    assert.equal(toMapped('2001:db8::1'), '2001:db8::1', 'IPv6 must pass through unchanged');
    assert.equal(toCanonical('::ffff:192.168.1.5'), '192.168.1.5');
    assert.equal(toCanonical('2001:db8::1'), '2001:db8::1');
    // A mapped address must not be mistaken for a real IPv6 candidate.
    assert.equal(isIpv6('::ffff:10.0.0.1'), false);
    assert.equal(isIpv6('2001:db8::1'), true);
  });

  test('ranks candidates by priority and always offers loopback', () => {
    const list = localCandidates(40000);
    assert.ok(list.length > 0);
    const loopback = list.find((c) => c.address === '127.0.0.1');
    assert.ok(loopback, 'loopback candidate missing');
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1]!.priority >= list[i]!.priority, 'candidates must be sorted by priority');
    }
    // Global IPv6, when present, must outrank IPv4: it needs no NAT.
    const v6 = list.filter((c) => c.address.includes(':'));
    if (v6.length > 0) {
      const bestV6 = Math.max(...v6.map((c) => c.priority));
      const bestV4 = Math.max(...list.filter((c) => !c.address.includes(':')).map((c) => c.priority));
      assert.ok(bestV6 >= bestV4, 'IPv6 should rank at least as high as IPv4');
    }
    assert.equal(typeof hasGlobalIpv6(), 'boolean');
  });

  test('skips link-local IPv6, which cannot be expressed as a candidate', () => {
    const list = localCandidates(1);
    assert.equal(list.some((c) => c.address.toLowerCase().startsWith('fe80')), false);
  });

  test('LAN addresses drop virtual adapters and dead APIPA links, private ranges first', () => {
    const ranked = rankLanAddresses([
      { name: 'VMware Network Adapter VMnet8', address: '192.168.239.1' },
      { name: 'WLAN', address: '169.254.53.141' },
      { name: '以太网 2', address: '172.20.5.9' },
      { name: '以太网', address: '192.168.8.242' },
      { name: 'Tailscale', address: '100.101.102.103' },
      { name: '以太网', address: '192.168.8.242' },
    ]);
    assert.deepEqual(ranked, ['192.168.8.242', '172.20.5.9', '100.101.102.103']);
    assert.equal(rankLanAddresses([]).length, 0);
  });
});

describe('relay to P2P upgrade', () => {
  test('settles on relay, then upgrades once the peer answers', async () => {
    const link = await UdpLink.bind({ host: '127.0.0.1' });
    link.setLatch(true);

    // A peer that is not listening yet: the initial punch must fail.
    const peer = dgram.createSocket('udp4');
    const peerPort = await new Promise<number>((resolve) => {
      peer.bind(0, '127.0.0.1', () => resolve(peer.address().port));
    });

    const stub = { stats: { packetsReceived: 0, recoveredFrames: 0 } } as unknown as Parameters<
      typeof selectDataPath
    >[0]['session'];

    try {
      const path = await selectDataPath({
        link,
        session: stub,
        candidates: [{ kind: 'host', address: '127.0.0.1', port: peerPort, priority: 100 }],
        relay: { address: '127.0.0.1', port: 9 },
        probeMs: 80,
      });
      assert.equal(path.route, 'relay', 'peer is silent, so the relay is the fallback');
      assert.ok(path.upgrade, 'relay path must expose an upgrade attempt');

      const upgraded = new Promise<{ address: string; port: number }>((resolve) => {
        path.upgrade!((endpoint) => resolve(endpoint));
      });

      // The peer now wakes up and probes us, which is what a late punch looks like.
      const localPort = link.address!.port;
      await new Promise((r) => setTimeout(r, 1600));
      peer.send(Buffer.from('punch'), localPort, '127.0.0.1');

      const endpoint = await Promise.race([
        upgraded,
        new Promise<null>((r) => setTimeout(() => r(null), 4000)),
      ]);
      assert.deepEqual(endpoint, { address: '127.0.0.1', port: peerPort });
      assert.equal(link.remoteEndpoint?.port, peerPort, 'traffic must now follow the p2p endpoint');
    } finally {
      link.close();
      peer.close();
    }
  });

  test('cancelUpgrade stops the background probing', async () => {
    const link = await UdpLink.bind({ host: '127.0.0.1' });
    link.setLatch(true);
    const stub = { stats: { packetsReceived: 0, recoveredFrames: 0 } } as unknown as Parameters<
      typeof selectDataPath
    >[0]['session'];
    try {
      const path = await selectDataPath({
        link,
        session: stub,
        candidates: [{ kind: 'host', address: '127.0.0.1', port: 9, priority: 100 }],
        relay: { address: '127.0.0.1', port: 9 },
        probeMs: 60,
      });
      let fired = false;
      path.upgrade?.(() => {
        fired = true;
      });
      path.cancelUpgrade?.();
      await new Promise((r) => setTimeout(r, 2200));
      assert.equal(fired, false);
      assert.deepEqual(link.remoteEndpoint, { address: '127.0.0.1', port: 9 }, 'relay stays selected');
    } finally {
      link.close();
    }
  });
});

describe('IPv6 transport', () => {
  test('two dual-stack links exchange datagrams over ::1', async (t) => {
    let a: UdpLink;
    let b: UdpLink;
    try {
      a = await UdpLink.bind({ host: '::1' });
      b = await UdpLink.bind({ host: '::1' });
    } catch {
      t.skip('IPv6 loopback unavailable on this host');
      return;
    }
    try {
      const received: string[] = [];
      b.onMessage((data, from) => received.push(`${from?.address}|${data.toString('utf8')}`));
      a.setRemote({ address: '::1', port: b.address!.port });
      a.send(Buffer.from('hello-v6'));
      await waitFor(() => received.length > 0, 2000, 'ipv6 datagram');
      assert.equal(received[0], '::1|hello-v6');
    } finally {
      a.close();
      b.close();
    }
  });
});

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('candidate priority', () => {
  test('picks the highest-priority responder, not the first one to answer', async () => {
    const link = await UdpLink.bind({ host: '127.0.0.1' });
    link.setLatch(true);

    // Two peers that both answer; the slow one advertises the better priority.
    const makePeer = async (delayMs: number) =>
      new Promise<{ port: number; socket: dgram.Socket }>((resolve) => {
        const s = dgram.createSocket('udp4');
        s.on('message', (_m, from) => {
          setTimeout(() => s.send(Buffer.from('pong'), from.port, from.address), delayMs);
        });
        s.bind(0, '127.0.0.1', () => resolve({ port: s.address().port, socket: s }));
      });

    const fast = await makePeer(0);
    const better = await makePeer(120);
    try {
      const session = { stats: { packetsReceived: 0 } } as unknown as Parameters<
        typeof selectDataPath
      >[0]['session'];
      // selectDataPath only fans out; in the real app the session's pings produce
      // the traffic, so the test has to generate probes itself.
      const probe = setInterval(() => link.send(Buffer.from('probe')), 40);
      const path = await selectDataPath({
        link,
        session,
        candidates: [
          { kind: 'srflx', address: '127.0.0.1', port: fast.port, priority: 100 },
          { kind: 'host', address: '127.0.0.1', port: better.port, priority: 300 },
        ],
        relay: { address: '127.0.0.1', port: 9 },
        probeMs: 400,
      });
      clearInterval(probe);
      assert.equal(path.route, 'p2p');
      assert.equal(path.endpoint.port, better.port, 'the higher-priority path must win');
      assert.equal(path.kind, 'host');
    } finally {
      link.close();
      fast.socket.close();
      better.socket.close();
    }
  });
});

describe('UI websocket guard', () => {
  const key = Buffer.alloc(16, 7).toString('base64');

  async function startGuarded(): Promise<{ port: number; token: string; close: () => Promise<void> }> {
    const token = 'tok-' + Math.random().toString(36).slice(2);
    let port = 0;
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    attachWebSocketServer(server, () => {}, {
      token: () => token,
      allowedHosts: () => [`127.0.0.1:${port}`, `localhost:${port}`],
      allowedOrigins: () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
    return { port, token, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  /** Returns 'upgrade' for an accepted handshake, otherwise the HTTP status line. */
  function attempt(port: number, path: string, headers: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path,
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': key,
          'sec-websocket-version': '13',
          host: `127.0.0.1:${port}`,
          ...headers,
        },
      });
      req.setTimeout(3000, () => req.destroy(new Error('handshake timed out')));
      req.on('upgrade', (res) => {
        res.socket?.destroy();
        resolve('upgrade');
      });
      req.on('response', (res) => {
        res.resume();
        resolve(`HTTP ${res.statusCode}`);
      });
      req.on('error', reject);
      req.end();
    });
  }

  test('accepts the same-origin page and rejects every other caller', async () => {
    const g = await startGuarded();
    const origin = `http://127.0.0.1:${g.port}`;
    try {
      assert.equal(await attempt(g.port, `/ws?token=${g.token}`, { origin }), 'upgrade');
      // Any site the user visits can reach 127.0.0.1; the Origin header is what
      // stops it, and browsers always send one for WebSocket.
      assert.equal(await attempt(g.port, `/ws?token=${g.token}`, { origin: 'https://evil.example' }), 'HTTP 403');
      // DNS rebinding: the attacker's own hostname resolves to 127.0.0.1, so the
      // Origin matches the Host and only the Host allowlist catches it.
      assert.equal(
        await attempt(g.port, `/ws?token=${g.token}`, { origin: 'http://evil.example', host: 'evil.example' }),
        'HTTP 403',
      );
      assert.equal(await attempt(g.port, '/ws', { origin }), 'HTTP 403');
      assert.equal(await attempt(g.port, '/ws?token=wrong', { origin }), 'HTTP 403');
      assert.equal(await attempt(g.port, `/ws?token=${g.token}`, { origin: `http://127.0.0.1:${g.port + 1}` }), 'HTTP 403');
    } finally {
      await g.close();
    }
  });
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { relayAddress } from '../src/signaling/server.ts';
import { pickRelayAddress } from '../src/transport/path.ts';
import type { Candidate } from '../src/signaling/protocol.ts';

test('the relay address is the server itself, never the peer', () => {
  // Regression: this used to be the address the peer connected from, so both sides
  // sent media to each other's WAN IP on the relay port and every session that
  // needed a relay died with a timeout.
  assert.equal(relayAddress({ localAddress: '10.0.0.5' }), '10.0.0.5');
  assert.equal(relayAddress({ localAddress: '::ffff:10.0.0.5' }), '10.0.0.5');
  assert.equal(relayAddress({ publicAddress: '124.221.215.145', localAddress: '10.0.0.5' }), '124.221.215.145');
  assert.equal(relayAddress({ publicAddress: '   ', localAddress: '10.0.0.5' }), '10.0.0.5');
  assert.equal(relayAddress({}), '127.0.0.1');
});

test('a relay address that is really a peer candidate is replaced', () => {
  const peer: Candidate = { kind: 'srflx', address: '36.163.169.254', port: 40000, priority: 10 };
  const bogus = { address: '36.163.169.254', port: 7802 };
  assert.deepEqual(pickRelayAddress(bogus, [peer], '124.221.215.145'), {
    address: '124.221.215.145',
    port: 7802,
  });

  // A dedicated relay host that is not one of the peers must be left alone.
  const dedicated = { address: '203.0.113.9', port: 7802 };
  assert.deepEqual(pickRelayAddress(dedicated, [peer], '124.221.215.145'), dedicated);

  // Nothing to fall back to: keep what the server advertised.
  assert.deepEqual(pickRelayAddress(bogus, [peer], ''), bogus);

  // No candidates at all: nothing to compare against.
  assert.deepEqual(pickRelayAddress(bogus, [], '124.221.215.145'), bogus);
});

test('an unreachable relay address is replaced with the dialled server', () => {
  const cases = [
    '10.0.0.11', // private NIC of a cloud VM behind 1:1 NAT
    '192.168.8.242',
    '172.16.4.5',
    '100.64.1.2',
    '127.0.0.1',
    '::ffff:10.0.0.11',
    '169.254.10.1',
  ];
  for (const address of cases) {
    assert.deepEqual(
      pickRelayAddress({ address, port: 7802 }, [], '124.221.215.145'),
      { address: '124.221.215.145', port: 7802 },
      `${address} should not be used as a relay`,
    );
  }
  // Public addresses are trusted as-is.
  assert.deepEqual(pickRelayAddress({ address: '124.221.215.145', port: 7802 }, [], '124.221.215.145'), {
    address: '124.221.215.145',
    port: 7802,
  });
  // A LAN-only deployment dials the private address itself, so the override is a no-op.
  assert.deepEqual(pickRelayAddress({ address: '192.168.8.242', port: 7801 }, [], '192.168.8.242'), {
    address: '192.168.8.242',
    port: 7801,
  });
});

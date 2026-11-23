import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { SignalingServer } from '../src/signaling/server.ts';

/**
 * End-to-end check of the last-resort path: when hole punching fails the two peers
 * send their media to the signalling server's UDP port and it forwards datagrams
 * between them. The relay address the server advertises is what makes that work.
 */
test('relay forwards datagrams between the two peers', async () => {
  const server = new SignalingServer({ tcpPort: 0, udpPort: 0, bindAddress: '127.0.0.1', log: () => {} });
  const ports = await server.listen();

  interface Peer {
    socket: net.Socket;
    send: (msg: unknown) => void;
    next: () => Promise<any>;
    udp: dgram.Socket;
    token: string;
    code: string;
  }

  async function makePeer(name: string, hostable: boolean): Promise<Peer> {
    const udp = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', () => resolve()));
    const tokenReply = new Promise<any>((resolve) => udp.once('message', (msg) => resolve(JSON.parse(msg.toString('utf8')))));
    udp.send(Buffer.from([0x01]), ports.udpPort, '127.0.0.1');
    const { token } = await tokenReply;

    const socket = net.createConnection({ host: '127.0.0.1', port: ports.tcpPort });
    let buffer = '';
    const queue: any[] = [];
    const waiters: ((msg: any) => void)[] = [];
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) {
          const msg = JSON.parse(line);
          const waiter = waiters.shift();
          if (waiter) waiter(msg);
          else queue.push(msg);
        }
        idx = buffer.indexOf('\n');
      }
    });
    const send = (msg: unknown) => socket.write(JSON.stringify(msg) + '\n');
    const next = () =>
      new Promise<any>((resolve) => {
        const queued = queue.shift();
        if (queued) resolve(queued);
        else waiters.push(resolve);
      });
    await once(socket, 'connect');
    send({ t: 'hello', deviceId: name, name, os: hostable ? 'win32' : 'win32', hostable });
    const welcome = await next();
    return { socket, send, next, udp, token, code: welcome.code };
  }

  const host = await makePeer('host-1', true);
  const ctrl = await makePeer('ctrl-1', false);

  // Mirror the engines: each one registers its UDP endpoint *before* the session
  // exists (right before connect/accept), which is what used to leave the relay
  // index empty and drop every datagram.
  host.send({ t: 'udp-token', token: host.token, endpoint: { address: '127.0.0.1', port: host.udp.address().port } });
  ctrl.send({ t: 'udp-token', token: ctrl.token, endpoint: { address: '127.0.0.1', port: ctrl.udp.address().port } });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const sessionId = 'relay-session';
  // No candidates at all: hole punching cannot succeed, so this is the relay path.
  ctrl.send({
    t: 'connect',
    sessionId,
    targetCode: host.code,
    password: 'pw',
    eph: 'AAAA',
    candidates: [],
  });
  assert.equal((await host.next()).t, 'incoming');
  host.send({ t: 'accept', sessionId, password: 'pw', eph: 'BBBB', candidates: [] });

  const hostReady = await host.next();
  const ctrlReady = await ctrl.next();
  assert.equal(hostReady.relay.address, '127.0.0.1', 'relay must be the server itself');
  assert.equal(hostReady.relay.port, ports.udpPort);
  assert.deepEqual(ctrlReady.relay, hostReady.relay);

  await new Promise((resolve) => setTimeout(resolve, 150));

  const toCtrl = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('host -> ctrl datagram never arrived')), 2000);
    ctrl.udp.once('message', (m) => {
      clearTimeout(timer);
      resolve(m.toString('utf8'));
    });
  });
  host.udp.send(Buffer.from('hello-from-host'), ports.udpPort, '127.0.0.1');
  assert.equal(await toCtrl, 'hello-from-host');

  const toHost = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctrl -> host datagram never arrived')), 2000);
    host.udp.once('message', (m) => {
      clearTimeout(timer);
      resolve(m.toString('utf8'));
    });
  });
  ctrl.udp.send(Buffer.from('hello-from-ctrl'), ports.udpPort, '127.0.0.1');
  assert.equal(await toHost, 'hello-from-ctrl');

  host.socket.destroy();
  ctrl.socket.destroy();
  host.udp.close();
  ctrl.udp.close();
  server.close();
});

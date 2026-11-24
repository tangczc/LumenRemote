import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { SignalingClient } from '../src/signaling/client.ts';

const WELCOME = JSON.stringify({ t: 'welcome', deviceId: 'dev-1', code: '123 456 789', udpPort: 7802, name: 'Test' });

async function startServer(): Promise<{ port: number; server: net.Server; sockets: net.Socket[] }> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.setNoDelay(true);
    socket.write(`${WELCOME}\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { port: address.port, server, sockets };
}

function connectTo(port: number): SignalingClient {
  return new SignalingClient({
    host: '127.0.0.1',
    port,
    deviceId: 'dev-1',
    name: 'Test',
    os: 'test',
    hostable: true,
  });
}

test('onClose fires when the server drops the connection', async (t) => {
  const { port, server, sockets } = await startServer();
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });

  const client = connectTo(port);
  await client.connect(2000);
  assert.equal(client.connected, true);

  let closes = 0;
  client.onClose(() => {
    closes++;
  });

  sockets[0]?.destroy();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(closes, 1);
  assert.equal(client.connected, false);
});

test('our own close() does not look like a dropped connection', async (t) => {
  const { port, server, sockets } = await startServer();
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });

  const client = connectTo(port);
  await client.connect(2000);

  let closes = 0;
  client.onClose(() => {
    closes++;
  });

  client.close();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(closes, 0);
  assert.equal(client.connected, false);
});

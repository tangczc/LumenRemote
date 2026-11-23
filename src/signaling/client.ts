import net, { type Socket } from 'node:net';
import dgram from 'node:dgram';
import { LineDecoder, type ClientToServer, type EndpointInfo, type ServerToClient } from './protocol.ts';
import { toMapped } from '../net/address.ts';

export interface SignalingClientOptions {
  host: string;
  port: number;
  name: string;
  os: string;
  deviceId?: string;
  preferredCode?: string;
  /** False for controller-only builds (phones, tablets). */
  hostable?: boolean;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface Welcome {
  deviceId: string;
  code: string;
  udpPort: number;
  name: string;
}

/**
 * Thin TCP client for the signaling service. Keeps the socket alive, exposes an
 * event handler per message type, and offers a promise-based `hello()`.
 */
export class SignalingClient {
  private socket: Socket | null = null;
  private decoder: LineDecoder<ServerToClient>;
  private handlers = new Set<(msg: ServerToClient) => void>();
  private welcomeResolve: ((w: Welcome) => void) | null = null;
  private closed = false;
  welcome: Welcome | null = null;

  constructor(private readonly opts: SignalingClientOptions) {
    this.decoder = new LineDecoder<ServerToClient>((msg) => {
      if (msg.t === 'welcome') {
        this.welcome = { deviceId: msg.deviceId, code: msg.code, udpPort: msg.udpPort, name: msg.name };
        this.welcomeResolve?.(this.welcome);
      }
      if (msg.t === 'error' && msg.fatal) {
        this.opts.log?.('error', `signaling: ${msg.message}`);
      }
      for (const h of this.handlers) h(msg);
    });
  }

  get connected(): boolean {
    return this.socket !== null && !this.closed;
  }

  async connect(timeoutMs = 8000): Promise<Welcome> {
    const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
    socket.setNoDelay(true);
    this.socket = socket;

    socket.on('data', (chunk) => this.decoder.push(chunk));

    // A single promise owns the handshake. Creating a second promise for the
    // TCP connect phase leaves an unhandled rejection behind when the peer is
    // unreachable, which would take the whole process down.
    const welcome = await new Promise<Welcome>((resolve, reject) => {
      let settled = false;
      const finish = (err: Error | null, value?: Welcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('error', onError);
        socket.off('close', onClose);
        if (err) reject(err);
        else resolve(value!);
      };
      const onError = (err: Error) => finish(err);
      const onClose = () => finish(new Error('signaling connection closed'));
      const timer = setTimeout(() => finish(new Error('signaling handshake timeout')), timeoutMs);
      timer.unref?.();

      socket.once('error', onError);
      socket.once('close', onClose);
      this.welcomeResolve = (w) => finish(null, w);

      socket.once('connect', () => {
        this.send({
          t: 'hello',
          deviceId: this.opts.deviceId,
          preferredCode: this.opts.preferredCode,
          name: this.opts.name,
          os: this.opts.os,
          hostable: this.opts.hostable,
        });
      });
    });

    this.welcomeResolve = null;
    socket.on('close', () => {
      this.closed = true;
      this.opts.log?.('warn', 'signaling connection lost');
    });
    socket.on('error', (err) => this.opts.log?.('error', `signaling: ${err.message}`));
    return welcome;
  }

  send(msg: ClientToServer): void {
    if (!this.socket?.writable) return;
    this.socket.write(JSON.stringify(msg) + '\n');
  }

  onMessage(cb: (msg: ServerToClient) => void): void {
    this.handlers.add(cb);
  }

  offMessage(cb: (msg: ServerToClient) => void): void {
    this.handlers.delete(cb);
  }

  close(): void {
    this.closed = true;
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}

/**
 * Ask the signaling service for our public UDP endpoint (NAT mapping) and get
 * back a token the server can use to associate the mapping with a session.
 */
export function discoverUdpEndpoint(
  socket: dgram.Socket,
  host: string,
  port: number,
  timeoutMs = 2000,
): Promise<{ token: string; endpoint: EndpointInfo }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeListener('message', onMessage);
      reject(new Error('udp discovery timeout'));
    }, timeoutMs);
    timer.unref?.();

    const onMessage = (msg: Buffer) => {
      try {
        const parsed = JSON.parse(msg.toString('utf8')) as { token: string; endpoint: EndpointInfo };
        if (!parsed.token) return;
        clearTimeout(timer);
        socket.removeListener('message', onMessage);
        resolve(parsed);
      } catch {
        /* ignore non-discovery packets */
      }
    };
    socket.on('message', onMessage);

    // A dual-stack socket cannot send to a bare IPv4 literal, so the probe has to
    // be written in IPv4-mapped form or the server never hears it.
    let target = host;
    try {
      const family = socket.address()?.family;
      if (family === 'IPv6' && !host.includes(':')) target = toMapped(host);
    } catch {
      /* address() throws before bind; send the literal as provided */
    }
    socket.send(Buffer.from([0x01]), port, target);
  });
}

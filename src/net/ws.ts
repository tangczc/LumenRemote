import type { IncomingMessage, Server } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';

/**
 * Minimal RFC6455 server-side WebSocket.
 *
 * The project ships with zero runtime dependencies, and the UI only needs
 * text control messages plus binary video samples, so a compact implementation
 * is preferable to pulling in `ws`.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsConnection {
  readonly remote: string;
  sendText(text: string): void;
  sendBinary(data: Buffer): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (data: Buffer, isBinary: boolean) => void): void;
  onClose(cb: () => void): void;
  readonly isOpen: boolean;
}

class Connection implements WsConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private messageHandlers: ((data: Buffer, isBinary: boolean) => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private open = true;

  constructor(
    private readonly socket: Duplex,
    readonly remote: string,
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('end', () => this.cleanup());
    socket.on('close', () => this.cleanup());
    socket.on('error', () => this.cleanup());
  }

  get isOpen(): boolean {
    return this.open;
  }

  onMessage(cb: (data: Buffer, isBinary: boolean) => void): void {
    this.messageHandlers.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeHandlers.push(cb);
  }

  sendText(text: string): void {
    this.writeFrame(0x1, Buffer.from(text, 'utf8'));
  }

  sendBinary(data: Buffer): void {
    this.writeFrame(0x2, data);
  }

  close(code = 1000, reason = ''): void {
    if (!this.open) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, 'utf8');
    this.writeFrame(0x8, payload);
    this.open = false;
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    for (const h of this.closeHandlers) h();
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (!this.open) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.cleanup();
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.readFrame();
      if (!frame) return;
      const { opcode, payload } = frame;
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.writeFrame(0xa, payload);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        for (const h of this.messageHandlers) h(payload, opcode === 0x2);
      }
    }
  }

  private readFrame(): { opcode: number; payload: Buffer } | null {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const b0 = buf[0]!;
    const b1 = buf[1]!;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      len = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }
    let maskKey: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i & 3]!;
    }
    this.buffer = buf.subarray(offset + len);
    return { opcode, payload };
  }

  private cleanup(): void {
    if (!this.open) return;
    this.open = false;
    for (const h of this.closeHandlers) h();
    // The peer can vanish without a close frame, leaving an upgraded socket that
    // nobody owns; destroying it releases the descriptor so `server.close()` can
    // finish and the app can exit.
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
  }
}

export interface WebSocketGuard {
  /**
   * Exact `Origin` values a browser may present. Browsers always send this
   * header for WebSocket, so a page on another site can never match it.
   */
  allowedOrigins: () => string[];
  /** Exact `Host` values accepted; a rebinding attack sends the attacker's name. */
  allowedHosts: () => string[];
  /**
   * Per-launch secret that must appear in the request URL. Pages on other
   * origins cannot read it because the UI is same-origin only.
   */
  token: () => string;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function allowUpgrade(req: IncomingMessage, guard: WebSocketGuard): boolean {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!guard.allowedHosts().some((h) => h.toLowerCase() === host)) return false;

  const origin = req.headers.origin;
  if (typeof origin === 'string' && !guard.allowedOrigins().some((o) => o.toLowerCase() === origin.toLowerCase())) {
    return false;
  }

  const url = req.url ?? '';
  if (!url.startsWith('/ws')) return false;
  const queryAt = url.indexOf('?');
  const token = queryAt >= 0 ? new URLSearchParams(url.slice(queryAt + 1)).get('token') : null;
  if (!token) return false;
  const expected = guard.token();
  return expected.length > 0 && sameSecret(token, expected);
}

export function attachWebSocketServer(
  server: Server,
  onConnection: (ws: WsConnection, req: IncomingMessage) => void,
  guard?: WebSocketGuard,
): void {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const key = req.headers['sec-websocket-key'];
    // The control socket can accept sessions and inject input, so it is not
    // enough to bind it to loopback: any page the user visits can reach it.
    if (!guard || !allowUpgrade(req, guard)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    );
    const remote = `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? 0}`;
    onConnection(new Connection(socket, remote), req);
  });
}

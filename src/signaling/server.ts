import dgram from 'node:dgram';
import net, { type Server as TcpServer, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import {
  LineDecoder,
  type Candidate,
  type ClientToServer,
  type DeviceSummary,
  type EndpointInfo,
  type ServerToClient,
} from './protocol.ts';
import { safeEqual } from '../protocol/crypto.ts';
import { localCandidates, toCanonical } from '../net/address.ts';

interface DeviceConn {
  deviceId: string;
  code: string;
  name: string;
  os: string;
  socket: Socket;
  connectedAt: number;
  failedAttempts: number;
  lastAttemptMs: number;
  /** Only a hostable device can be the target of a connect request. */
  hostable: boolean;
  /** Public address observed by the server's UDP socket, used as a srflx candidate. */
  reflexive?: EndpointInfo;
}

interface RelaySession {
  sessionId: string;
  hostDevice: string;
  ctrlDevice: string;
  hostEndpoint?: EndpointInfo;
  ctrlEndpoint?: EndpointInfo;
  hostUdpToken?: string;
  ctrlUdpToken?: string;
  createdAt: number;
}

export interface SignalingOptions {
  tcpPort?: number;
  udpPort?: number;
  bindAddress?: string;
  /** Address peers should reach the relay on; default is the address they dialled. */
  publicAddress?: string;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** Devices that can be the controlled side. Phones and tablets cannot. */
export const HOSTABLE_OS = new Set(['win32', 'darwin', 'linux']);

const DISCOVER_PREFIX = 0x01;

/**
 * Signaling + NAT helper service.
 *
 * - TCP carries newline-delimited JSON: device registration, session brokering,
 *   candidate exchange.
 * - UDP serves two purposes: endpoint discovery (so each peer learns its own
 *   public address) and a last-resort relay for pairs that cannot punch through.
 */
export class SignalingServer {
  private tcp!: TcpServer;
  private udp!: dgram.Socket;
  private devices = new Map<string, DeviceConn>();
  private codeIndex = new Map<string, string>();
  /** deviceId -> code, kept across reconnects so a device keeps its ID. */
  private codeByDevice = new Map<string, string>();
  private sessions = new Map<string, RelaySession>();
  private udpTokens = new Map<string, EndpointInfo>();
  /** endpoint "ip:port" -> sessionId, for the relay path. */
  private relayIndex = new Map<string, string>();

  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;

  constructor(private readonly opts: SignalingOptions = {}) {
    this.log = opts.log ?? (() => {});
  }

  async listen(): Promise<{ tcpPort: number; udpPort: number }> {
    const host = this.opts.bindAddress ?? '0.0.0.0';

    this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise<void>((resolve, reject) => {
      this.udp.once('error', reject);
      this.udp.bind(this.opts.udpPort ?? 7802, host, () => resolve());
    });
    this.udp.on('message', (msg, rinfo) => this.onUdp(msg, { address: rinfo.address, port: rinfo.port }));
    this.udp.on('error', (err) => this.log('error', `udp: ${err.message}`));

    this.tcp = net.createServer((socket) => this.onSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.tcp.once('error', reject);
      this.tcp.listen(this.opts.tcpPort ?? 7801, host, () => resolve());
    });

    const tcpAddr = this.tcp.address();
    const udpAddr = this.udp.address();
    return {
      tcpPort: typeof tcpAddr === 'object' && tcpAddr ? tcpAddr.port : 0,
      udpPort: typeof udpAddr === 'object' && udpAddr ? udpAddr.port : 0,
    };
  }

  close(): void {
    for (const d of this.devices.values()) d.socket.destroy();
    this.devices.clear();
    this.codeIndex.clear();
    this.sessions.clear();
    this.udpTokens.clear();
    this.relayIndex.clear();
    try {
      this.tcp?.close();
    } catch {
      /* ignore */
    }
    try {
      this.udp?.close();
    } catch {
      /* ignore */
    }
  }

  get deviceCount(): number {
    return this.devices.size;
  }

  get udpPort(): number {
    const a = this.udp?.address();
    return typeof a === 'object' ? a.port : 0;
  }

  // ------------------------------------------------------------------ UDP

  private onUdp(msg: Buffer, from: EndpointInfo): void {
    const canonical = { address: toCanonical(from.address), port: from.port };
    if (msg.length >= 1 && msg[0] === DISCOVER_PREFIX) {
      const token = randomBytes(9).toString('base64url');
      this.udpTokens.set(token, canonical);
      // `tcpPort` lets a LAN client that only knows the UDP discovery port find
      // the signaling endpoint without hard-coding it. Older clients ignore it.
      const reply = Buffer.from(
        JSON.stringify({ token, endpoint: canonical, tcpPort: this.opts.tcpPort ?? 7801 }),
        'utf8',
      );
      this.udp.send(reply, from.port, from.address);
      return;
    }
    const key = endpointKey(canonical);
    const sessionId = this.relayIndex.get(key);
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const peerKey = key === endpointKey(session.hostEndpoint!) ? session.ctrlEndpoint : session.hostEndpoint;
    if (!peerKey) return;
    this.udp.send(msg, peerKey.port, peerKey.address);
  }

  /** Local IPv4/IPv6 addresses, offered to the peer as host candidates. */
  static localCandidates(port: number): Candidate[] {
    return localCandidates(port).map((c) => ({
      kind: c.kind,
      address: c.address,
      port: c.port,
      priority: c.priority,
    }));
  }

  // ---------------------------------------------------------------- TCP

  private onSocket(socket: Socket): void {
    let device: DeviceConn | null = null;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);

    const send = (msg: ServerToClient) => {
      if (socket.writable) socket.write(JSON.stringify(msg) + '\n');
    };

    const decoder = new LineDecoder<ClientToServer>((msg) => {
      switch (msg.t) {
        case 'hello':
          device = this.registerDevice(msg, socket, send);
          break;
        case 'udp-token':
          if (device) this.registerUdpToken(device, msg.token);
          break;
        case 'connect':
          if (device) this.onConnect(device, msg);
          break;
        case 'accept':
          if (device) this.onAccept(device, msg);
          break;
        case 'reject':
          if (device) this.onReject(device, msg.sessionId, msg.reason);
          break;
        case 'candidates':
          if (device) this.forwardCandidates(device, msg.sessionId, msg.candidates);
          break;
        case 'bye':
          if (device) this.onBye(device, msg.sessionId, msg.reason);
          break;
        case 'ping':
          send({ t: 'pong', n: msg.n });
          break;
        default:
          break;
      }
    });

    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('close', () => {
      if (!device) return;
      // A reconnect with the same deviceId replaces this entry; the older
      // socket closing must not evict the newer registration.
      if (this.devices.get(device.deviceId) !== device) return;
      this.devices.delete(device.deviceId);
      this.codeIndex.delete(device.code);
      this.log('info', `device offline: ${device.code} (${device.name})`);
      this.dropSessionsFor(device);
    });
    socket.on('error', () => socket.destroy());
  }

  /**
   * Tell the surviving peer that a session is gone. Without this a crashed or
   * disconnected client leaves the other side waiting until its own timeout.
   */
  private dropSessionsFor(device: DeviceConn): void {
    for (const session of [...this.sessions.values()]) {
      if (session.hostDevice !== device.deviceId && session.ctrlDevice !== device.deviceId) continue;
      const peerId = session.hostDevice === device.deviceId ? session.ctrlDevice : session.hostDevice;
      const peer = this.devices.get(peerId);
      if (peer) this.sendTo(peer, { t: 'bye', sessionId: session.sessionId, reason: '对方已断开连接' });
      this.sessions.delete(session.sessionId);
      this.pending.delete(session.sessionId);
      if (session.hostEndpoint) this.relayIndex.delete(endpointKey(session.hostEndpoint));
      if (session.ctrlEndpoint) this.relayIndex.delete(endpointKey(session.ctrlEndpoint));
    }
  }

  private registerDevice(
    msg: Extract<ClientToServer, { t: 'hello' }>,
    socket: Socket,
    send: (m: ServerToClient) => void,
  ): DeviceConn {
    const deviceId = msg.deviceId && msg.deviceId.length > 0 ? msg.deviceId : randomBytes(8).toString('hex');
    const existing = this.devices.get(deviceId);
    if (existing) {
      this.codeIndex.delete(existing.code);
      existing.socket.destroy();
    }
    // A device that reconnects keeps the code it was first given, so a user can
    // write the ID down once and dial it again after a restart. A client that
    // remembers its own code asks for it explicitly, which is what survives a
    // signalling-server restart.
    const wanted = msg.preferredCode ? normalizeCode(msg.preferredCode) : null;
    const wantedOwner = wanted ? this.codeIndex.get(wanted) : undefined;
    const code =
      wanted && (!wantedOwner || wantedOwner === deviceId)
        ? wanted
        : (this.codeByDevice.get(deviceId) ?? this.allocateCode());
    this.codeByDevice.set(deviceId, code);
    const device: DeviceConn = {
      deviceId,
      code,
      name: msg.name,
      os: msg.os,
      socket,
      connectedAt: Date.now(),
      failedAttempts: 0,
      lastAttemptMs: 0,
      // A client may declare itself controller-only; otherwise fall back to the
      // platform name so a new mobile build cannot silently become hostable.
      hostable: msg.hostable ?? HOSTABLE_OS.has(msg.os),
    };
    this.devices.set(deviceId, device);
    this.codeIndex.set(code, deviceId);
    this.log('info', `device online: ${code} (${msg.name}) from ${socket.remoteAddress}`);
    send({ t: 'welcome', deviceId, code, udpPort: this.udpPort, name: msg.name });
    return device;
  }

  private allocateCode(): string {
    const taken = new Set(this.codeByDevice.values());
    for (;;) {
      const n = 100_000_000 + Math.floor(Math.random() * 900_000_000);
      const code = `${String(n).slice(0, 3)} ${String(n).slice(3, 6)} ${String(n).slice(6)}`;
      if (!this.codeIndex.has(code) && !taken.has(code)) return code;
    }
  }

  private registerUdpToken(device: DeviceConn, token: string): void {
    const endpoint = this.udpTokens.get(token);
    if (!endpoint) return;
    // Remember the address the server observed so it can be handed to the peer
    // as a server-reflexive candidate; a device behind NAT does not know it.
    device.reflexive = endpoint;
    for (const s of this.sessions.values()) {
      // Re-registration must be able to MOVE an endpoint, not just fill an
      // empty one: clients re-discover periodically and whenever the path
      // looks dead, and on a mobile network the observed endpoint changes
      // (new NAT mapping, cell handover). Pinning the first endpoint ever
      // seen made the relay forward to a dead address for the rest of the
      // session — the fallback path failed exactly when it was needed.
      const stale =
        s.hostDevice === device.deviceId
          ? s.hostEndpoint
          : s.ctrlDevice === device.deviceId
            ? s.ctrlEndpoint
            : undefined;
      if (stale && (stale.address !== endpoint.address || stale.port !== endpoint.port)) {
        const oldKey = endpointKey(stale);
        if (this.relayIndex.get(oldKey) === s.sessionId) this.relayIndex.delete(oldKey);
      }
      if (s.hostDevice === device.deviceId && (!s.hostEndpoint || stale)) {
        s.hostEndpoint = endpoint;
        s.hostUdpToken = token;
      } else if (s.ctrlDevice === device.deviceId && (!s.ctrlEndpoint || stale)) {
        s.ctrlEndpoint = endpoint;
        s.ctrlUdpToken = token;
      }
      this.updateRelayIndex(s);
    }
  }

  private updateRelayIndex(session: RelaySession): void {
    if (session.hostEndpoint) this.relayIndex.set(endpointKey(session.hostEndpoint), session.sessionId);
    if (session.ctrlEndpoint) this.relayIndex.set(endpointKey(session.ctrlEndpoint), session.sessionId);
  }

  private onConnect(device: DeviceConn, msg: Extract<ClientToServer, { t: 'connect' }>): void {
    const now = Date.now();
    if (now - device.lastAttemptMs < 300) {
      this.sendTo(device, { t: 'error', message: 'too many attempts, slow down' });
      return;
    }
    device.lastAttemptMs = now;

    const targetId = this.codeIndex.get(msg.targetCode) ?? this.codeIndex.get(normalizeCode(msg.targetCode));
    const target = targetId ? this.devices.get(targetId) : undefined;
    if (!target) {
      this.sendTo(device, { t: 'rejected', sessionId: msg.sessionId, reason: 'device not found or offline' });
      return;
    }
    if (target.deviceId === device.deviceId) {
      this.sendTo(device, { t: 'rejected', sessionId: msg.sessionId, reason: 'cannot connect to yourself' });
      return;
    }
    // Android/iOS are controller-only builds; a Windows client must not be able
    // to dial them, otherwise the request would sit unanswered on the phone.
    if (!target.hostable) {
      this.sendTo(device, {
        t: 'rejected',
        sessionId: msg.sessionId,
        reason: `${target.name} 是控制端，不支持被控`,
      });
      return;
    }

    const session: RelaySession = {
      sessionId: msg.sessionId,
      hostDevice: target.deviceId,
      ctrlDevice: device.deviceId,
      createdAt: now,
    };
    this.sessions.set(msg.sessionId, session);
    // The controller registered its UDP endpoint before the session existed, so the
    // token loop could not attach it. Without it the relay index has no entry for
    // the controller and `onUdp` drops every datagram -- the session then dies with
    // "连接超时（对方已离线）" no matter how good the relay address is.
    if (device.reflexive) {
      session.ctrlEndpoint = device.reflexive;
      this.updateRelayIndex(session);
    }
    // The controller's observed endpoint arrives through udp-token; store the
    // candidate list so the host can start punching immediately.
    this.sendTo(target, {
      t: 'incoming',
      sessionId: msg.sessionId,
      from: { deviceId: device.deviceId, code: device.code, name: device.name, os: device.os },
      passwordRequired: true,
      display: msg.display,
    });
    // Stash controller data on the session for when the host accepts.
    this.pending.set(msg.sessionId, {
      ctrlEph: msg.eph,
      ctrlCandidates: this.withReflexive(msg.candidates, device),
      password: msg.password,
    });
  }

  /**
   * Append the address the server saw this device arrive from. Host candidates
   * only cover the LAN; across the internet the peer must be given the public
   * mapping or the punch has nothing to aim at.
   */
  private withReflexive(candidates: Candidate[], device: DeviceConn): Candidate[] {
    const out = [...candidates];
    const reflex = device.reflexive;
    if (reflex && !out.some((c) => c.address === reflex.address && c.port === reflex.port)) {
      out.unshift({ kind: 'srflx', address: reflex.address, port: reflex.port, priority: 200 });
    }
    return out;
  }

  private pending = new Map<string, { ctrlEph: string; ctrlCandidates: Candidate[]; password?: string }>();

  private onAccept(device: DeviceConn, msg: Extract<ClientToServer, { t: 'accept' }>): void {
    const session = this.sessions.get(msg.sessionId);
    if (!session || session.hostDevice !== device.deviceId) return;
    const pending = this.pending.get(msg.sessionId);
    const ctrl = this.devices.get(session.ctrlDevice);
    if (!pending || !ctrl) {
      this.sendTo(device, { t: 'error', message: 'session expired' });
      return;
    }
    // A device code is always required and never optional: if either side omits
    // it, the attempt is rejected instead of silently skipping the check.
    // Surrounding spaces are ignored (people paste codes with them) but the
    // characters themselves are compared exactly, including letter case.
    if (!pending.password || !msg.password || !safeEqual(pending.password.trim(), msg.password.trim())) {
      device.failedAttempts++;
      this.sendTo(device, { t: 'rejected', sessionId: msg.sessionId, reason: '验证码不正确' });
      this.sendTo(ctrl, { t: 'rejected', sessionId: msg.sessionId, reason: '验证码不正确' });
      this.log('warn', `verification failed for ${session.sessionId} (attempt ${device.failedAttempts})`);
      this.sessions.delete(msg.sessionId);
      this.pending.delete(msg.sessionId);
      return;
    }

    const relay: EndpointInfo = { address: this.relayAddressFor(device), port: this.udpPort };
    // Same reason as onConnect: the host's own UDP endpoint may have arrived before
    // the session was registered, and it is what the relay forwards to.
    if (device.reflexive && !session.hostEndpoint) {
      session.hostEndpoint = device.reflexive;
      this.updateRelayIndex(session);
    }
    this.sendTo(ctrl, {
      t: 'ready',
      sessionId: msg.sessionId,
      role: 'controller',
      peer: { deviceId: device.deviceId, code: device.code, name: device.name, os: device.os },
      peerEph: msg.eph,
      peerCandidates: this.withReflexive(msg.candidates, device),
      relay,
      password: pending.password,
    });
    this.sendTo(device, {
      t: 'ready',
      sessionId: msg.sessionId,
      role: 'host',
      peer: { deviceId: ctrl.deviceId, code: ctrl.code, name: ctrl.name, os: ctrl.os },
      peerEph: pending.ctrlEph,
      peerCandidates: pending.ctrlCandidates,
      relay,
      password: pending.password,
    });
    this.pending.delete(msg.sessionId);
  }

  private onReject(device: DeviceConn, sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const other = this.devices.get(session.ctrlDevice === device.deviceId ? session.hostDevice : session.ctrlDevice);
    if (other) this.sendTo(other, { t: 'rejected', sessionId, reason });
    this.sessions.delete(sessionId);
    this.pending.delete(sessionId);
  }

  private forwardCandidates(device: DeviceConn, sessionId: string, candidates: Candidate[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const peerId = session.hostDevice === device.deviceId ? session.ctrlDevice : session.hostDevice;
    const peer = this.devices.get(peerId);
    if (peer) this.sendTo(peer, { t: 'peer-candidates', sessionId, candidates });
  }

  private onBye(device: DeviceConn, sessionId: string, reason?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const peerId = session.hostDevice === device.deviceId ? session.ctrlDevice : session.hostDevice;
    const peer = this.devices.get(peerId);
    if (peer) this.sendTo(peer, { t: 'bye', sessionId, reason });
    this.sessions.delete(sessionId);
    this.pending.delete(sessionId);
    if (session.hostEndpoint) this.relayIndex.delete(endpointKey(session.hostEndpoint));
    if (session.ctrlEndpoint) this.relayIndex.delete(endpointKey(session.ctrlEndpoint));
  }

  private sendTo(device: DeviceConn, msg: ServerToClient): void {
    if (device.socket.writable) device.socket.write(JSON.stringify(msg) + '\n');
  }

  private relayAddressFor(device: DeviceConn): string {
    // Peers send relay traffic to *this* server, so advertise our own address.
    // Advertising the peer's address here (the old behaviour) pointed both sides at
    // each other's WAN IP on the relay port, so nothing ever arrived and every
    // session that needed a relay died with a timeout.
    return relayAddress({
      publicAddress: this.opts.publicAddress,
      localAddress: device.socket.localAddress,
    });
  }
}

function endpointKey(e: EndpointInfo): string {
  return `${e.address}:${e.port}`;
}

/**
 * Address peers should reach the relay on: this server, not the peer.
 *
 * `--public` covers machines that only have a private address on their NIC (cloud
 * VMs behind 1:1 NAT); otherwise the address the client dialled is already correct.
 */
export function relayAddress(opts: { publicAddress?: string; localAddress?: string }): string {
  const configured = opts.publicAddress?.trim();
  if (configured) return toCanonical(configured);
  const local = opts.localAddress?.trim();
  if (local) return toCanonical(local);
  return '127.0.0.1';
}

export function normalizeCode(code: string): string {
  const digits = code.replace(/\D/g, '');
  if (digits.length !== 9) return code;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

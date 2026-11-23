import { parseArgs } from 'node:util';
import { platform, hostname } from 'node:os';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SignalingClient, discoverUdpEndpoint } from '../signaling/client.ts';
import { SignalingServer, normalizeCode } from '../signaling/server.ts';
import { hasGlobalIpv6, lanAddresses, localCandidates, toCanonical } from '../net/address.ts';
import { requestPortMapping, type PortMapping } from '../net/nat.ts';
import { UdpLink } from '../transport/link.ts';
import { Session, type IncomingFrame } from '../transport/session.ts';
import { pickRelayAddress, selectDataPath } from '../transport/path.ts';
import { deriveSessionKeys, generateEphemeral, randomId, safeEqual, type EphemeralKeyPair } from '../protocol/crypto.ts';
import { randomBytes, createHmac } from 'node:crypto';
import { deriveAccessCode, generateAccessCode } from './access-code.ts';
import { Codec, FrameFlags } from '../protocol/constants.ts';
import type { InputEvent } from '../protocol/messages.ts';
import { splitAnnexB } from '../media/nal.ts';
import { annexBToAvcc, describeStream, type AvcStreamConfig } from '../media/avc.ts';
import { ScreenEncoder, resolveEncoder, type EncoderName } from '../media/encoder.ts';
import { negotiateSize, scaleBitrate, type SizeRequest } from '../media/target.ts';
import { InputInjector } from '../host/injector.ts';
import { queryDisplay } from '../host/display.ts';
import {
  handOverDisplay as takeOverDisplay,
  pickDisplayMode,
  readDisplayState,
  restoreDisplay,
  type DisplayLayout,
  type DisplayMode,
} from '../host/display-mode.ts';
import { startUiServer, type UiServer } from '../ui/server.ts';
import { openUi } from '../ui/open.ts';
import { ffmpegAvailable, ffmpegBinary } from '../util/resources.ts';
import {
  NET_OVERHEAD,
  QUALITY_PRESETS,
  encodeVideoPacket,
  type AppToUi,
  type QualityPreset,
  type SessionStatsDto,
  type UiToApp,
  type VerifyMode,
} from '../ui/bridge.ts';
import type { ServerToClient } from '../signaling/protocol.ts';

/**
 * Unified remote-control client.
 *
 * One process, one device identity: it can be controlled by a peer *and*
 * control a peer, matching how consumer remote-desktop apps present a single
 * "this device ID + connect to a partner" screen. Only one session runs at a
 * time because both directions share a single UDP socket.
 */

const VERSION = '0.2.0';

/**
 * Budget for sessions that had to fall back to the relay: media crosses two WAN
 * legs plus a shared server, so the LAN-sized presets (7.6-56 Mbps) turn into a
 * slideshow. The congestion controller still adapts below this ceiling.
 */
const RELAY_NET_KBPS = 4_000;
const RELAY_FPS = 30;

/**
 * Signalling server a fresh install talks to. Both clients default to the same
 * host so a new phone and a new PC meet without anyone typing an address.
 */
const DEFAULT_SIGNAL_HOST = '124.221.215.145';

const { values } = parseArgs({
  options: {
    signal: { type: 'string', default: DEFAULT_SIGNAL_HOST },
    port: { type: 'string', default: '7801' },
    name: { type: 'string', default: '' },
    ui: { type: 'string', default: '7800' },
    'no-open': { type: 'boolean', default: false },
    'auto-accept': { type: 'boolean', default: false },
    password: { type: 'string', default: '' },
    source: { type: 'string', default: 'screen' },
    encoder: { type: 'string', default: 'auto' },
    inject: { type: 'boolean', default: true },
    quality: { type: 'string', default: 'balanced' },
    display: { type: 'string', default: 'ui' },
    code: { type: 'string', default: '' },
    'no-signal-host': { type: 'boolean', default: false },
    'no-upnp': { type: 'boolean', default: false },
    'no-candidates': { type: 'boolean', default: false },
    'force-relay': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`
Lumen Remote — unified remote-control client

  --signal <host>     signalling server host (default ${DEFAULT_SIGNAL_HOST})
  --port <port>       signalling TCP port (default 7801)
  --ui <port>         local UI port (default 7800)
  --no-open           do not open a browser window
  --auto-accept       accept incoming control requests without a prompt
  --password <pwd>    use this fixed access code instead of a per-launch random one
  --code <digits>     connect to this device once signalling is up (needs --password)
  --quality office|balanced|game|uhd
  --source screen|test
  --inject true|false
  --no-signal-host    do not start a local signalling server
  --no-upnp           skip router port mapping (NAT-PMP / UPnP)
  --no-candidates     advertise no P2P candidates; forces the relay (debug)
  --force-relay       ignore the peer's candidates and use the relay (debug)
`);
  process.exit(0);
}

const DEVICE_NAME = values.name || hostname();
const STATE_DIR = process.env.RD_STATE_DIR || join(process.cwd(), '.rd-state');
const STATE_FILE = join(STATE_DIR, 'app-state.json');

interface AppState {
  deviceId: string;
  /** Last device code the signalling service assigned, so it can be reclaimed. */
  deviceCode?: string;
  verifyMode: VerifyMode;
  /** Fixed code, only used while verifyMode is 'long'. */
  longPassword: string;
  /** Per-device secret the daily code is derived from. */
  codeSecret: string;
  allowRemote: boolean;
  quality: QualityPreset;
  favorites: { code: string; name: string }[];
  signalHost: string;
  signalPort: number;
  /** Hand the panel to the controller: match its resolution. */
  handOverDisplay: boolean;
  /**
   * Black the local panel out while a session runs. Off by default: it needs a
   * monitor with DDC/CI, and a failed restore would leave the user staring at a
   * black screen with no way to reach the UI.
   */
  blackOutScreen: boolean;
  /**
   * Written before the panel is touched and cleared once it is back. A build that
   * dies mid-session must not leave the user on a foreign resolution, or worse,
   * a black screen.
   */
  pendingDisplayLayout?: DisplayLayout[];
  pendingBrightness?: number;
}

function defaultState(): AppState {
  const q = values.quality as QualityPreset;
  const cliPassword = values.password ?? '';
  return {
    // Generated once and kept in app-state.json so the server can hand back the
    // same 9-digit device ID on every launch, like a hardware ID.
    deviceId: randomBytes(8).toString('hex'),
    verifyMode: cliPassword ? 'long' : 'once',
    longPassword: cliPassword,
    codeSecret: randomBytes(16).toString('hex'),
    allowRemote: true,
    quality: q in QUALITY_PRESETS ? q : 'balanced',
    favorites: [],
    signalHost: values.signal ?? DEFAULT_SIGNAL_HOST,
    signalPort: Number(values.port ?? 7801),
    handOverDisplay: true,
    blackOutScreen: false,
  };
}

function loadState(): AppState {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<AppState> & {
      password?: string;
      customPassword?: string;
    };
    const merged = { ...defaultState(), ...raw };
    // Builds before verification modes existed stored a single optional password
    // where empty meant "no verification", which is no longer offered.
    if (raw.longPassword === undefined) {
      const legacy = raw.customPassword || raw.password || '';
      merged.longPassword = legacy;
      if (raw.verifyMode === undefined) merged.verifyMode = legacy ? 'long' : 'once';
    }
    // Map the retired two-mode names onto the current three.
    const legacyMode = raw.verifyMode as string | undefined;
    if (legacyMode === 'custom') merged.verifyMode = 'long';
    else if (legacyMode === 'random' || legacyMode === undefined) merged.verifyMode = 'once';
    return merged;
  } catch {
    return defaultState();
  }
}

function saveState(next: AppState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch {
    /* persistence is best effort */
  }
}

let state = loadState();
// Persist immediately so a first run (or an upgrade from a build without
// deviceId) writes the identity to disk before any signalling connects.
saveState(state);
let preset = QUALITY_PRESETS[state.quality] ?? QUALITY_PRESETS.balanced;

// ------------------------------------------------------------------ logging

let ui: UiServer | null = null;
const sendUi = (msg: AppToUi): void => {
  ui?.broadcastText(JSON.stringify(msg));
};

const log = (level: 'info' | 'warn' | 'error', message: string): void => {
  const stamp = new Date().toISOString().slice(11, 23);
  console.log(`${stamp} [${level}] ${message}`);
  sendUi({ type: 'log', level, message, ts: Date.now() });
};

// ------------------------------------------------------------ runtime state

// Reassigned while a host session owns the panel: the capture size follows the
// resolution the controller asked for instead of the one the user normally runs.
let display = await queryDisplay(preset.fps);
/** Panel state a host session took over, so ending it can put everything back. */
interface PanelHold {
  layout: DisplayLayout[];
  brightness: number;
  applied: DisplayMode | null;
}
let panelHold: PanelHold | null = null;
const injector = new InputInjector({ enabled: values.inject !== false, log });

interface ActiveSession {
  session: Session;
  role: 'host' | 'controller';
  peerName: string;
  peerCode: string;
  route: string;
  startedAt: number;
  sessionId: string;
  encoder?: ScreenEncoder;
  /** Frame size actually put on the wire, which may be smaller than the capture. */
  videoSize?: { width: number; height: number };
}

let active: ActiveSession | null = null;
let pendingIncoming:
  | {
      sessionId: string;
      from: { name: string; code: string; os: string };
      /** Viewport the controller asked for; drives the encode size. */
      display?: SizeRequest;
    }
  | null = null;
/** Requested viewport of the peer we are hosting for, if it told us. */
let peerDisplay: SizeRequest | undefined;
/**
 * Viewport this device asks hosts to encode for. The renderer reports it, so a
 * browser window on a 1080p laptop asks for 1920x1080 even when the engine runs
 * on a 4K machine.
 */
let controllerSize = { width: display.width, height: display.height };
let pendingEph: EphemeralKeyPair | null = null;
let pendingRole: 'host' | 'controller' = 'host';
let lastKeyframeRestart = 0;
/** Encoder bitrate ceiling learned from congestion feedback (kbps); 0 = use the preset. */
let adaptedBitrateKbps = 0;
let lastBitrateAdaptAt = 0;
/** Pending mid-session resize from the controller, debounced before the encoder restarts. */
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * True while the session runs over the relay: the encoder is capped because the
 * media has to cross two WAN legs plus a shared server.
 */
let relayBudget = false;
/** Encoder crashes absorbed in the current session, so a broken capture cannot loop. */
let autoRestarts = 0;
let avcConfig: AvcStreamConfig | null = null;
const decodeInUi = values.display === 'ui';

const link = await UdpLink.bind({});
link.setLatch(true);
log('info', `UDP 双栈=${link.isDualStack}${hasGlobalIpv6() ? ' · 检测到公网 IPv6 地址' : ' · 无公网 IPv6'}`);

/** Router port mapping, when the gateway supports NAT-PMP or UPnP. */
let portMapping: PortMapping | null = null;

let signaling: SignalingClient | null = null;
let discovery: { token: string; endpoint: { address: string; port: number } } | null = null;
let deviceCode = '';
let signalOnline = false;

function toDto(s: {
  fps: number;
  rttUs: number;
  oneWayUs: number;
  lossPct: number;
  targetBps: number;
  pacerRateBps: number;
  sendBps: number;
  recvBps: number;
  recoveredFrames: number;
  droppedFrames: number;
  queueBytes: number;
}): SessionStatsDto {
  return {
    fps: Math.round(s.fps),
    rttMs: Math.round(s.rttUs / 100) / 10,
    oneWayMs: Math.round(s.oneWayUs / 100) / 10,
    lossPct: s.lossPct,
    targetBps: s.targetBps,
    pacerRateBps: s.pacerRateBps,
    sendBps: s.sendBps,
    recvBps: s.recvBps,
    recoveredFrames: s.recoveredFrames,
    droppedFrames: s.droppedFrames,
    queueBytes: s.queueBytes,
  };
}

/**
 * Code a controller must present. There is no "no verification" state: every
 * mode yields a real code, they differ only in how long it stays the same.
 *
 * 单次 mode: one code per launch, replaced again once a session ends.
 */
let onceCode = generateAccessCode();

function todayStamp(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * 今日 mode: derived from the per-device secret and the calendar date, so it
 * survives restarts within a day and rolls over at midnight without a timer.
 */
function dailyAccessCode(now = new Date()): string {
  const mac = createHmac('sha256', Buffer.from(state.codeSecret, 'hex')).update(todayStamp(now)).digest();
  return deriveAccessCode(mac);
}

function currentAccessCode(): string {
  if (state.verifyMode === 'long') return state.longPassword || generateAccessCode();
  if (state.verifyMode === 'daily') return dailyAccessCode();
  return onceCode;
}

/** Called after a session ends so 单次 mode really is single-use. */
function rotateOnceCode(): void {
  if (state.verifyMode !== 'once') return;
  onceCode = generateAccessCode();
  emitDevice();
  emitSettings();
}

function emitDevice(): void {
  sendUi({
    type: 'device',
    code: deviceCode,
    name: DEVICE_NAME,
    online: signalOnline,
    allowRemote: state.allowRemote,
    verifyMode: state.verifyMode,
    accessCode: currentAccessCode(),
    lanAddresses: lanAddresses(),
  });
}

function emitSettings(): void {
  sendUi({
    type: 'settings',
    settings: {
      quality: state.quality,
      verifyMode: state.verifyMode,
      longPassword: state.longPassword,
      accessCode: currentAccessCode(),
      allowRemote: state.allowRemote,
      signalHost: state.signalHost,
      signalPort: state.signalPort,
      handOverDisplay: state.handOverDisplay,
      blackOutScreen: state.blackOutScreen,
    },
  });
}

/**
 * Resolves the signalling host this client uses into an IP the relay can use.
 */
async function dialledIpAddress(): Promise<string> {
  const host = state.signalHost.trim();
  if (host.length === 0) return '';
  if (isIP(host) !== 0) return host;
  try {
    return toCanonical((await lookup(host)).address);
  } catch {
    return '';
  }
}

// ------------------------------------------------------------ media pipeline

function startEncoder(target: ActiveSession): void {
  // Frames queued for the previous encoder belong to a reference chain that the
  // new keyframe replaces; sending them only delays the useful picture.
  target.session.discardPendingMedia();
  // A fresh encoder already emits an IDR, so an IDR request arriving right after
  // the session starts must not tear it down again.
  lastKeyframeRestart = Date.now();
  const { width, height, scaled } = negotiateSize(display, peerDisplay);
  const fps = relayBudget ? Math.min(preset.fps, RELAY_FPS) : preset.fps;
  const presetKbps = relayBudget ? Math.min(preset.bitrateKbps, RELAY_NET_KBPS) : preset.bitrateKbps;
  let bitrateKbps = scaled ? scaleBitrate(presetKbps, display, { width, height }) : presetKbps;
  // The congestion controller's verdict, learned from the wire: never let the
  // encoder produce faster than the path has proven it can carry. Without
  // this the encoder kept emitting the full preset rate into a saturated
  // pacer, which dropped frames, broke reference chains and forced an
  // encoder restart every second — the visible "卡得要死" death spiral.
  if (adaptedBitrateKbps > 0) bitrateKbps = Math.max(800, Math.min(bitrateKbps, adaptedBitrateKbps));
  let self: ScreenEncoder | null = null;
  const encoder: ScreenEncoder = new ScreenEncoder({
    source: values.source === 'test' ? { kind: 'test', size: `${display.width}x${display.height}` } : { kind: 'screen', mode: 'auto' },
    fps,
    bitrateKbps,
    targetSize: scaled ? { width, height } : undefined,
    encoder: values.encoder as EncoderName | 'auto',
    ffmpegPath: ffmpegBinary(),
    onAccessUnit: (au) => {
      if (!active || active.role !== 'host') return;
      // A stopped encoder can still flush its last access units; those belong to
      // a reference chain the replacement already superseded.
      if (active.encoder && active.encoder !== self) return;
      try {
        const sent = active.session.sendFrame(Codec.H264, au.isKey ? FrameFlags.Key : 0, au.payload);
        // A shed frame breaks the reference chain, so the decoder would show
        // corruption until the next IDR. Ask for one instead of waiting — but
        // at most every 5 s: restarting the whole capture pipeline is itself
        // hundreds of milliseconds of stall, and doing it every second made
        // congestion self-sustaining.
        if (sent < 0 && Date.now() - lastKeyframeRestart > 5000) {
          lastKeyframeRestart = Date.now();
          active.encoder?.stop();
          startEncoder(active);
        }
      } catch (err) {
        log('warn', `帧发送失败: ${(err as Error).message}`);
      }
    },
    onLog: (line) => log('warn', line.slice(0, 300)),
    onExit: (code) => {
      if (code === 0 || code === null) return;
      log('error', `编码器退出 (${code})`);
      // Keep the session alive: a dead encoder looks like a frozen desktop, and
      // the user has no way to revive it from the controller.
      const current = active;
      if (!current || current.role !== 'host') return;
      if (autoRestarts >= 3) {
        log('error', '编码器多次异常退出，已停止自动重启（检查显卡驱动或是否有其他远控软件占用桌面复制）');
        return;
      }
      autoRestarts++;
      setTimeout(() => {
        if (!active || active.role !== 'host') return;
        if (active.encoder && active.encoder !== self) return;
        log('warn', '编码器已停止，正在自动重启');
        startEncoder(active);
      }, 800);
    },
  });
  self = encoder;
  encoder.start();
  target.encoder = encoder;
  target.videoSize = { width, height };
  if (values.source !== 'test') {
    const mode = encoder.captureMode === 'dda' ? 'Desktop Duplication (GPU)' : 'GDI';
    const shape = scaled ? ` · 缩放输出 ${width}x${height} · ${bitrateKbps} kbps` : ` · ${bitrateKbps} kbps`;
    log('info', `屏幕采集 ${mode} ${display.width}x${display.height}@${fps}${shape}`);
  }
}

function onIncomingFrame(frame: IncomingFrame): void {
  if (!active || active.role !== 'controller') return;
  const units = splitAnnexB(frame.payload);
  if (!avcConfig) {
    const sps = units.find((u) => u.type === 7);
    const pps = units.find((u) => u.type === 8);
    if (sps && pps) {
      avcConfig = describeStream(Buffer.from(sps.data), Buffer.from(pps.data));
      sendUi({ type: 'config', codec: avcConfig.codec, avcC: avcConfig.avcC.toString('base64') });
    }
  }
  if (!avcConfig || !decodeInUi) return;
  ui?.broadcastBinary(
    encodeVideoPacket({
      frameId: frame.frameId,
      key: (frame.flags & FrameFlags.Key) !== 0,
      captureTsUs: frame.captureTsUs,
      oneWayUs: frame.oneWayUs,
      payload: annexBToAvcc(units),
    }),
  );
}

// ------------------------------------------------------------- signalling

async function connectSignaling(): Promise<void> {
  signaling?.close();
  signaling = null;
  signalOnline = false;
  deviceCode = '';
  emitDevice();

  const client = new SignalingClient({
    host: state.signalHost,
    port: state.signalPort,
    deviceId: state.deviceId,
    preferredCode: state.deviceCode,
    name: DEVICE_NAME,
    os: platform(),
    hostable: true,
    log,
  });
  signaling = client;

  try {
    const welcome = await client.connect();
    deviceCode = welcome.code;
    if (state.deviceCode !== welcome.code) {
      state = { ...state, deviceCode: welcome.code };
      saveState(state);
    }
    signalOnline = true;
    discovery = await discoverUdpEndpoint(link.raw, state.signalHost, welcome.udpPort);
    if (discovery) client.send({ t: 'udp-token', token: discovery.token, endpoint: discovery.endpoint });
    log('info', `设备 ID ${deviceCode} · 信令 ${state.signalHost}:${state.signalPort}`);
    emitDevice();
    client.onMessage((msg) => void onSignaling(msg));
  } catch (err) {
    log('error', `无法连接信令服务: ${(err as Error).message}`);
    emitDevice();
    sendUi({ type: 'notice', level: 'error', message: `信令服务不可达 (${state.signalHost}:${state.signalPort})` });
  }
}

function ourCandidates(): { kind: 'host'; address: string; port: number; priority: number }[] {
  const port = link.address?.port ?? 0;
  // Debug switch: forcing the relay is the only way to test the last-resort path
  // on a pair of machines that can punch through.
  if (values['no-candidates']) return [];
  const list = localCandidates(port).map((c) => ({
    kind: 'host' as const,
    address: c.address,
    port: c.port,
    priority: c.priority,
  }));
  // A router mapping turns "inbound blocked" into a plain dialable endpoint, so
  // it outranks every local address.
  if (portMapping) {
    list.unshift({
      kind: 'host' as const,
      address: portMapping.externalAddress ?? '',
      port: portMapping.externalPort,
      priority: 400,
    });
    // Some routers report no public IP; the peer still learns it from the
    // server-side reflexive candidate, so the port alone is useful.
    if (!portMapping.externalAddress) list.shift();
  }
  return list.filter((c) => c.address.length > 0);
}

async function onSignaling(msg: ServerToClient): Promise<void> {
  switch (msg.t) {
    case 'incoming': {
      if (!state.allowRemote) {
        signaling?.send({ t: 'reject', sessionId: msg.sessionId, reason: '本设备未开启远程协助' });
        return;
      }
      pendingIncoming = { sessionId: msg.sessionId, from: msg.from, display: msg.display };
      peerDisplay = msg.display;
      // A code is always required, so the prompt always asks for one.
      sendUi({ type: 'incoming', sessionId: msg.sessionId, from: msg.from, passwordRequired: true });
      log('info', `收到连接请求 ${msg.from.name} (${msg.from.code})`);
      if (msg.display) log('info', `对方视口 ${msg.display.width}x${msg.display.height}@${msg.display.fps}fps`);
      if (values['auto-accept']) acceptIncoming();
      break;
    }
    case 'ready':
      await startSession(msg, pendingEph, pendingRole);
      pendingEph = null;
      break;
    case 'rejected':
      log('warn', `连接失败: ${msg.reason}`);
      sendUi({ type: 'session-end', reason: msg.reason });
      pendingEph = null;
      break;
    case 'bye':
      endSession(msg.reason ?? '对方已断开');
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ session

/** Last time the peer proved it was alive (any control message, including pings). */
let lastPeerAt = Date.now();

/**
 * Take the panel for the duration of a host session.
 *
 * The panel switches to the controller's resolution so the encoder runs 1:1
 * instead of rescaling a 4K desktop, which is what makes a session feel like the
 * controller's own monitor is plugged in: Windows even re-derives the DPI scale
 * for the new mode (measured 175% at 4K -> 125% at 1440p -> 175% on restore).
 *
 * Blacking the panel out is optional and off by default. When asked for, it goes
 * through DDC/CI rather than DPMS because Desktop Duplication stops producing
 * frames once the output really powers down (measured: 0 fps), while a dark panel
 * keeps the capture pipeline at full rate.
 */
async function takeOverPanel(video: { width: number; height: number }): Promise<void> {
  if (values.source === 'test') return;
  // A second takeover would forget the original mode and strand the panel.
  if (panelHold) return;
  const snapshot = await readDisplayState();
  if (!snapshot) return;
  const target = pickDisplayMode(snapshot.modes, { width: video.width, height: video.height, fps: preset.fps });
  const changed =
    target !== null &&
    (target.width !== snapshot.current?.width ||
      target.height !== snapshot.current?.height ||
      Math.abs(target.refreshRate - (snapshot.current?.refreshRate ?? 0)) > 2);
  const canDim = state.blackOutScreen && snapshot.brightness > 0;
  if (!changed && !canDim) return;

  // Persist the way back before touching anything, so a crash is recoverable.
  state = {
    ...state,
    pendingDisplayLayout: snapshot.layout,
    pendingBrightness: snapshot.brightness,
  };
  saveState(state);

  const result = await takeOverDisplay(changed ? target : null, canDim, 0, snapshot.layout);
  panelHold = { layout: result.layout, brightness: snapshot.brightness, applied: result.mode };
  if (result.mode) {
    display = { width: result.mode.width, height: result.mode.height, fps: preset.fps };
    log('info', `已将本机分辨率切换为 ${result.mode.width}x${result.mode.height}@${result.mode.refreshRate}`);
  } else if (changed) {
    log('warn', `本机显示器不支持 ${video.width}x${video.height}，保持原分辨率并缩放输出`);
  }
  if (result.dimmed) log('info', '本机屏幕已黑屏（会话结束自动恢复）');
}

/** Undo `takeOverPanel`; safe to call when nothing was taken over. */
async function releasePanel(reason: string): Promise<void> {
  const hold = panelHold;
  panelHold = null;
  if (!hold) return;
  const ok = await restoreDisplay(hold.layout, hold.brightness);
  const primary = hold.layout.find((entry) => entry.primary);
  if (ok && primary) {
    display = { width: primary.width, height: primary.height, fps: preset.fps };
  }
  state = { ...state, pendingDisplayLayout: undefined, pendingBrightness: undefined };
  saveState(state);
  log(ok ? 'info' : 'warn', ok ? `已恢复本机显示${reason}` : '恢复本机显示失败，请手动检查分辨率、排列与亮度');
}

/** Recover a panel left behind by a previous run that died mid-session. */
async function restoreLeftoverPanel(): Promise<void> {
  const layout = state.pendingDisplayLayout ?? [];
  const brightness = typeof state.pendingBrightness === 'number' ? state.pendingBrightness : -1;
  if (layout.length === 0 && brightness < 0) return;
  const ok = await restoreDisplay(layout, brightness);
  state = { ...state, pendingDisplayLayout: undefined, pendingBrightness: undefined };
  saveState(state);
  log(ok ? 'info' : 'warn', ok ? '已恢复上次异常退出留下的显示设置' : '上次遗留的显示设置恢复失败');
}

function endSession(reason: string): void {
  const current = active;
  // Both the signalling `bye` and the data-channel `bye` arrive for one teardown,
  // so the second call must not repeat the log line or rotate a code twice.
  if (!current) return;
  active = null;
  avcConfig = null;
  relayBudget = false;
  if (current) {
    current.encoder?.stop();
    current.session.close(reason);
    if (current.role === 'host') injector.stop();
  }
  if (current.role === 'host') void releasePanel(reason);
  sendUi({ type: 'session-end', reason });
  log('info', `会话结束 ${reason}`);
  rotateOnceCode();
}

/**
 * Both peers ping every 250 ms, so silence means the other side is gone — most
 * often a phone that was killed or lost Wi-Fi without a chance to say bye. The
 * host must not stay in its "being controlled" card forever.
 */
setInterval(() => {
  if (!active) return;
  if (Date.now() - lastPeerAt > 8000) endSession('连接超时（对方已离线）');
}, 3000).unref?.();

async function startSession(
  msg: Extract<ServerToClient, { t: 'ready' }>,
  eph: EphemeralKeyPair | null,
  role: 'host' | 'controller',
): Promise<void> {
  if (!eph) {
    log('warn', '收到 ready 但缺少临时密钥');
    return;
  }
  // The code lives only on this device, so the host re-checks it here instead of
  // trusting the server's verdict: a patched server (or a UI that answers the
  // prompt on the user's behalf) must not be able to open a session. The check
  // runs before the encoder starts or the injector is wired up.
  if (role === 'host') {
    const expected = currentAccessCode().trim();
    const presented = (msg.password ?? '').trim();
    if (!expected || !presented || !safeEqual(presented, expected)) {
      signaling?.send({ t: 'reject', sessionId: msg.sessionId, reason: '验证码不正确' });
      log('warn', '拒绝建立会话：验证码不匹配');
      sendUi({ type: 'session-end', reason: '验证码不正确' });
      pendingEph = null;
      pendingIncoming = null;
      return;
    }
  }
  // A repeated or superseded `ready` must not stack a second encoder, injector or
  // panel takeover on top of the running session.
  if (active) {
    if (active.sessionId === msg.sessionId) {
      log('warn', '收到重复的 ready，已忽略');
      return;
    }
    endSession('被新的连接取代');
  }
  // Hand the panel over before anything is captured, so the encoder, the injector
  // and the geometry advertised to the peer all see the final screen.
  if (role === 'host' && state.handOverDisplay) {
    await takeOverPanel(negotiateSize(display, peerDisplay));
  }
  // The host resizes its output to the controller's viewport; the controller
  // reports its own screen so the host knows what to aim for.
  const video =
    role === 'host'
      ? negotiateSize(display, peerDisplay)
      : { width: display.width, height: display.height, scaled: false };
  const keys = deriveSessionKeys({
    sessionId: msg.sessionId,
    localEphemeral: eph,
    peerPublicRaw: Buffer.from(msg.peerEph, 'base64'),
    role,
    password: msg.password,
  });
  autoRestarts = 0;
  adaptedBitrateKbps = 0;
  lastBitrateAdaptAt = 0;
  if (resizeTimer) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }

  const session = new Session({
    role,
    link,
    keys,
    sessionId: msg.sessionId,
    initialBitrateBps: preset.netKbps * 1000,
    maxBitrateBps: preset.netKbps * 1000,
    logger: (level, message) => log(level === 'debug' ? 'info' : level, message),
    onInput: (event) => injector.inject(event),
    onFrame: (frame) => onIncomingFrame(frame),
    onControl: (ctl) => {
      lastPeerAt = Date.now();
      if (ctl.t === 'bye') {
        endSession(ctl.reason ?? '对方已断开');
        return;
      }
      if (ctl.t === 'resize' && role === 'host' && active) {
        // The controller resized its window or entered/left fullscreen. The
        // encode size was previously fixed at connect time, so fullscreen
        // kept showing the small pre-fullscreen stream. Re-negotiate — but
        // debounce, because a window drag reports dozens of sizes, and do
        // NOT switch the physical panel mid-session: the flicker and DPI
        // reshuffle would move every window under the user's hand. Scaling
        // the encoder output is enough.
        const w = Math.round(ctl.width);
        const h = Math.round(ctl.height);
        if (w >= 160 && h >= 120 && w <= 7680 && h <= 4320) {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            resizeTimer = null;
            if (!active || active.role !== 'host') return;
            if (peerDisplay && Math.abs(peerDisplay.width - w) < 16 && Math.abs(peerDisplay.height - h) < 16) return;
            peerDisplay = { width: w, height: h, fps: ctl.fps };
            log('info', `对方视口变化 ${w}x${h}，调整编码尺寸`);
            active.encoder?.stop();
            startEncoder(active);
          }, 350);
        }
        return;
      }
      if (ctl.t !== 'idr' || role !== 'host' || !active) return;
      const now = Date.now();
      if (now - lastKeyframeRestart > 2000) {
        lastKeyframeRestart = now;
        active.encoder?.stop();
        startEncoder(active);
      }
    },
    onStats: (s) => sendUi({ type: 'stats', stats: toDto(s) }),
    onBitrateChange: (bps) => {
      log('info', `目标码率 ${(bps / 1000).toFixed(0)} kbps`);
      // Feed the congestion verdict back into the encoder (debounced, and
      // only on a material change): pacing alone cannot fix an encoder that
      // produces 12 Mbps into a 5 Mbps uplink — it can only drop the excess.
      if (!active || active.role !== 'host' || !active.encoder) return;
      const now = Date.now();
      if (now - lastBitrateAdaptAt < 4000) return;
      const kbps = Math.max(800, Math.floor(bps / NET_OVERHEAD / 1000));
      const current = adaptedBitrateKbps > 0 ? adaptedBitrateKbps : preset.bitrateKbps;
      const drop = kbps < current * 0.7;
      const recover = adaptedBitrateKbps > 0 && kbps > current * 1.4;
      if (!drop && !recover) return;
      lastBitrateAdaptAt = now;
      adaptedBitrateKbps = kbps;
      log('info', `按网络状况调整编码码率至 ${kbps} kbps`);
      active.encoder.stop();
      startEncoder(active);
    },
  });
  session.start();
  session.sendHello({
    t: 'hello',
    v: 1,
    sessionId: msg.sessionId,
    role,
    deviceId: '',
    eph: eph.publicKeyRaw.toString('base64'),
    caps: ['h264', 'webcodecs'],
    display: { width: video.width, height: video.height, fps: preset.fps },
  });

  const relay = pickRelayAddress(msg.relay, msg.peerCandidates, await dialledIpAddress());
  // Re-register the UDP endpoint now that the session exists: the token was sent
  // before connect/accept, and a stale NAT mapping (or a server restart) would
  // otherwise leave the relay forwarding to an address nobody listens on.
  if (discovery) signaling?.send({ t: 'udp-token', token: discovery.token, endpoint: discovery.endpoint });
  const path = await selectDataPath({
    link,
    session,
    candidates: values['force-relay'] ? [] : msg.peerCandidates,
    relay,
  });
  log('info', `数据通道 ${path.route === 'p2p' ? 'P2P 直连' : '中继转发'} ${path.endpoint.address}:${path.endpoint.port}`);
  // Relaying costs two WAN legs and a shared server, so the preset's LAN-sized
  // budget does not fit: pin the session to a relay-friendly ceiling and let the
  // congestion controller work below it. Restored if punching succeeds later.
  relayBudget = path.route === 'relay';
  if (path.route === 'relay' && path.upgrade) {
    path.upgrade((endpoint) => {
      log('info', `数据通道升级为 P2P 直连 ${endpoint.address}:${endpoint.port}`);
      if (active) active.route = 'p2p';
      sendUi({ type: 'session-route', route: 'p2p' });
      if (relayBudget) {
        relayBudget = false;
        log('info', `恢复 P2P 画质：码率上限 ${preset.netKbps} kbps · ${preset.fps} fps`);
        active?.session.setMaxBudget(preset.netKbps * 1000);
        if (active?.role === 'host') startEncoder(active);
      }
    });
  }

  active = {
    session,
    role,
    peerName: msg.peer.name,
    peerCode: msg.peer.code,
    route: path.route,
    startedAt: Date.now(),
    sessionId: msg.sessionId,
  };
  lastPeerAt = Date.now();

  if (role === 'host') {
    if (relayBudget) {
      const cap = Math.min(preset.netKbps, RELAY_NET_KBPS);
      session.setMaxBudget(cap * 1000);
      log('info', `中继模式：码率上限 ${cap} kbps · 帧率上限 ${RELAY_FPS} fps（打通 P2P 后自动恢复）`);
    }
    startEncoder(active);
    injector.start();
  }

  sendUi({
    type: 'session-start',
    role,
    sas: keys.sas,
    peerName: msg.peer.name,
    peerCode: msg.peer.code,
    route: path.route,
    display: { width: video.width, height: video.height, fps: preset.fps },
  });
  pendingIncoming = null;
  log('info', `会话开始 ${role === 'host' ? '被控' : '主控'} · ${msg.peer.name} · SAS ${keys.sas}`);
}

function acceptIncoming(): void {
  if (!pendingIncoming || !signaling) return;
  const eph = generateEphemeral();
  pendingEph = eph;
  pendingRole = 'host';
  if (discovery) signaling.send({ t: 'udp-token', token: discovery.token, endpoint: discovery.endpoint });
  signaling.send({
    t: 'accept',
    sessionId: pendingIncoming.sessionId,
    eph: eph.publicKeyRaw.toString('base64'),
    candidates: ourCandidates(),
    password: currentAccessCode(),
  });
  sendUi({ type: 'session-state', state: 'connecting', role: 'host' });
  log('info', '已接受连接，正在建立加密通道');
}

function connectToPeer(codeRaw: string, password?: string): void {
  if (!signaling || !signalOnline) {
    sendUi({ type: 'session-end', reason: '尚未连接信令服务器' });
    return;
  }
  const target = normalizeCode(codeRaw);
  const sessionId = randomId(8);
  const eph = generateEphemeral();
  pendingEph = eph;
  pendingRole = 'controller';
  if (discovery) signaling.send({ t: 'udp-token', token: discovery.token, endpoint: discovery.endpoint });
  signaling.send({
    t: 'connect',
    sessionId,
    targetCode: target,
    password: password || undefined,
    eph: eph.publicKeyRaw.toString('base64'),
    candidates: ourCandidates(),
    // This device is the controller, so the host should encode for *our* viewport
    // rather than its own screen; that is what makes a same-sized PC feel local.
    display: { width: controllerSize.width, height: controllerSize.height, fps: preset.fps },
  });
  sendUi({ type: 'session-state', state: 'waiting', role: 'controller', message: `正在请求 ${target}` });
  log('info', `请求连接 ${target}`);
}

// ----------------------------------------------------------------------- UI

function isInputEvent(value: unknown): value is InputEvent {
  if (!value || typeof value !== 'object') return false;
  const k = (value as { k?: unknown }).k;
  return k === 'mm' || k === 'ma' || k === 'mb' || k === 'mw' || k === 'kd' || k === 'ku' || k === 'kr';
}

function applyQuality(next: QualityPreset): void {
  const p = QUALITY_PRESETS[next];
  if (!p) return;
  state = { ...state, quality: next };
  saveState(state);
  preset = p;
  active?.session.setMaxBitrate(p.netKbps * 1000);
  if (active?.role === 'host' && active.encoder) {
    active.encoder.stop();
    startEncoder(active);
  }
  emitSettings();
  log('info', `画质 ${p.label} · ${p.bitrateKbps} kbps`);
}

function handleUi(msg: UiToApp): void {
  switch (msg.type) {
    case 'accept':
      // The code echoed to the controller is always the local one; letting the
      // renderer supply it would turn the check into a no-op.
      acceptIncoming();
      break;
    case 'decline':
      if (pendingIncoming) {
        signaling?.send({ t: 'reject', sessionId: pendingIncoming.sessionId, reason: '对方拒绝' });
        pendingIncoming = null;
      }
      break;
    case 'connect':
      connectToPeer(msg.code, msg.password);
      break;
    case 'disconnect':
      if (active) {
        signaling?.send({ t: 'bye', sessionId: active.sessionId, reason: 'local hangup' });
        endSession('已主动断开');
      }
      break;
    case 'quality':
      applyQuality(msg.preset);
      break;
    case 'keyframe':
      active?.session.requestKeyframe();
      break;
    case 'client-display':
      if (msg.width > 0 && msg.height > 0) {
        controllerSize = { width: Math.round(msg.width), height: Math.round(msg.height) };
        // Mid-session (window resize, entering/leaving fullscreen) the host
        // must hear about it, otherwise it keeps encoding for the size the
        // window had at connect time and fullscreen shows that small,
        // blurry picture. Previously this only updated a local variable
        // that nothing read until the NEXT connection.
        if (active?.role === 'controller') {
          active.session.sendControl({ t: 'resize', width: controllerSize.width, height: controllerSize.height, fps: preset.fps });
        }
      }
      break;
    case 'input':
      if (active?.role === 'controller' && isInputEvent(msg.event)) active.session.sendInput(msg.event);
      break;
    case 'set-allow':
      state = { ...state, allowRemote: msg.enabled };
      saveState(state);
      emitDevice();
      emitSettings();
      break;
    case 'set-handover':
      state = { ...state, handOverDisplay: msg.enabled };
      saveState(state);
      emitSettings();
      log('info', msg.enabled ? '已开启「让出显示器」' : '已关闭「让出显示器」（本机分辨率保持不变）');
      break;
    case 'set-blackout':
      state = { ...state, blackOutScreen: msg.enabled };
      saveState(state);
      emitSettings();
      log('info', msg.enabled ? '已开启「会话时黑屏」' : '已关闭「会话时黑屏」');
      break;
    case 'set-verify': {
      const provided = msg.password !== undefined ? msg.password.trim() : undefined;
      const nextPassword = provided !== undefined ? provided : state.longPassword;
      if (msg.mode === 'long' && !nextPassword) {
        log('warn', '长期验证码不能为空');
        emitDevice();
        emitSettings();
        break;
      }
      // Only a code being set now is validated; a stored one may predate the rule
      // and must not block switching modes.
      if (provided && !/^[A-Za-z0-9]{4,16}$/.test(provided)) {
        log('warn', '长期验证码需 4-16 位数字或字母');
        emitDevice();
        emitSettings();
        break;
      }
      state = { ...state, verifyMode: msg.mode, longPassword: nextPassword };
      // A new 单次 code is issued whenever the device leaves 单次 mode, so the
      // code shown before the switch stops working immediately.
      onceCode = generateAccessCode();
      saveState(state);
      emitDevice();
      emitSettings();
      log(
        'info',
        `验证方式：${{ once: '单次验证码', daily: '今日验证码', long: '长期验证码' }[msg.mode]}`,
      );
      break;
    }
    case 'set-signal':
      state = { ...state, signalHost: msg.host, signalPort: msg.port };
      saveState(state);
      emitSettings();
      void connectSignaling();
      break;
    case 'fav-add': {
      const code = normalizeCode(msg.code);
      if (code && !state.favorites.some((f) => f.code === code)) {
        state = { ...state, favorites: [...state.favorites, { code, name: msg.name || code }] };
        saveState(state);
      }
      sendUi({ type: 'favorites', favorites: state.favorites });
      break;
    }
    case 'fav-remove':
      state = { ...state, favorites: state.favorites.filter((f) => f.code !== normalizeCode(msg.code)) };
      saveState(state);
      sendUi({ type: 'favorites', favorites: state.favorites });
      break;
    default:
      break;
  }
}

ui = await startUiServer({
  port: Number(values.ui),
  onConnection: (ws) => {
    const push = (msg: AppToUi) => ws.sendText(JSON.stringify(msg));
    push({ type: 'hello', name: DEVICE_NAME, version: VERSION, platform: platform() });
    push({
      type: 'device',
      code: deviceCode,
      name: DEVICE_NAME,
      online: signalOnline,
      allowRemote: state.allowRemote,
      verifyMode: state.verifyMode,
      accessCode: currentAccessCode(),
      lanAddresses: lanAddresses(),
    });
    push({
      type: 'settings',
      settings: {
        quality: state.quality,
        verifyMode: state.verifyMode,
        longPassword: state.longPassword,
        accessCode: currentAccessCode(),
        allowRemote: state.allowRemote,
        signalHost: state.signalHost,
        signalPort: state.signalPort,
        handOverDisplay: state.handOverDisplay,
        blackOutScreen: state.blackOutScreen,
      },
    });
    push({ type: 'favorites', favorites: state.favorites });
    push({ type: 'display', display: { width: display.width, height: display.height, fps: display.fps } });
    // A request that arrived before this page connected would otherwise be
    // unanswerable: the prompt only exists as a push.
    if (pendingIncoming) {
      push({
        type: 'incoming',
        sessionId: pendingIncoming.sessionId,
        from: pendingIncoming.from,
        passwordRequired: true,
      });
    }
    if (active) {
      push({
        type: 'session-start',
        role: active.role,
        sas: active.session.sas,
        peerName: active.peerName,
        peerCode: active.peerCode,
        route: active.route,
        display: active.videoSize
          ? { width: active.videoSize.width, height: active.videoSize.height, fps: preset.fps }
          : { width: display.width, height: display.height, fps: preset.fps },
      });
      if (avcConfig) push({ type: 'config', codec: avcConfig.codec, avcC: avcConfig.avcC.toString('base64') });
      if (active.role === 'controller') active.session.requestKeyframe();
    }
    ws.onMessage((data, isBinary) => {
      if (isBinary) return;
      try {
        handleUi(JSON.parse(data.toString('utf8')) as UiToApp);
      } catch {
        /* ignore malformed */
      }
    });
  },
});

const FFMPEG = ffmpegBinary();
log(
  'info',
  `界面 ${ui.url} · 编码器 ${resolveEncoder((values.encoder as EncoderName | 'auto') ?? 'auto', FFMPEG)} · ffmpeg ${FFMPEG}`,
);
if (!ffmpegAvailable(FFMPEG)) {
  // Without this the first session would fail with an opaque "spawn ffmpeg ENOENT"
  // and the viewer would simply time out.
  log(
    'error',
    '未找到可用的 ffmpeg：请安装 ffmpeg，或把 ffmpeg.exe 放到程序目录的 ffmpeg/ 下，或用 RD_FFMPEG 指定路径',
  );
}
if (!values['no-open']) openUi(ui.url);

// A previous run may have died while it owned the panel; put the user's screen
// back before anything else waits on a black display.
await restoreLeftoverPanel();

if (!values['no-signal-host']) {
  const server = new SignalingServer({
    tcpPort: state.signalPort,
    udpPort: state.signalPort + 1,
    log: (level, message) => log(level, message),
  });
  try {
    const ports = await server.listen();
    log('info', `本地信令服务 tcp=${ports.tcpPort} udp=${ports.udpPort}`);
    // The phone has to be told which address to dial; the loopback address in the
    // UI is useless from another device on the LAN.
    const reachable = lanAddresses();
    if (reachable.length > 0) {
      log('info', `局域网地址 ${reachable.join(' / ')} · 手机端在「信令服务器」填这个地址`);
    }
  } catch {
    log('info', '本地信令端口被占用，复用现有服务');
  }
  process.on('SIGINT', () => {
    server.close();
    process.exit(0);
  });
}

// Ask the router to forward our UDP port. Nothing depends on it succeeding, but
// a successful mapping is the difference between "relay only" and a plain
// dialable endpoint for peers behind symmetric NAT.
const udpPort = link.address?.port ?? 0;
if (udpPort > 0 && !values['no-upnp']) {
  void requestPortMapping(udpPort).then((mapping) => {
    portMapping = mapping;
    if (mapping) {
      log(
        'info',
        `路由器端口映射成功 (${mapping.via}) 外部 ${mapping.externalAddress ?? '?'}:${mapping.externalPort} → ${mapping.internalAddress}:${mapping.internalPort}`,
      );
    } else {
      log('info', '路由器不支持 NAT-PMP/UPnP，依赖打洞');
    }
  });
}

await connectSignaling();

if (values.code) {
  if (!values.password) {
    log('error', '--code 需要同时提供 --password <对方验证码>');
  } else {
    setTimeout(() => connectToPeer(values.code!, values.password || undefined), 400);
  }
}

process.on('SIGINT', () => {
  endSession('应用退出');
  signaling?.close();
  ui?.close();
  link.close();
  // Give the panel restore a chance to run before the process goes away.
  void releasePanel('').finally(() => process.exit(0));
});

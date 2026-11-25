import { parseArgs } from 'node:util';
import { platform, hostname, arch } from 'node:os';
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
import { pickRelayAddress, selectDataPath, type PathResult } from '../transport/path.ts';
import { deriveSessionKeys, generateEphemeral, randomId, safeEqual, type EphemeralKeyPair } from '../protocol/crypto.ts';
import { randomBytes, createHmac } from 'node:crypto';
import { deriveAccessCode, generateAccessCode } from './access-code.ts';
import { Codec, FrameFlags } from '../protocol/constants.ts';
import type { InputEvent } from '../protocol/messages.ts';
import { splitAnnexB, type VideoCodecKind } from '../media/nal.ts';
import { annexBToAvcc, streamConfigChanged } from '../media/avc.ts';
import { extractHevcParameterSets, hevcStreamConfigChanged } from '../media/hevc.ts';
import { ScreenEncoder, hevcHardwareEncoder, resolveEncoder, type EncoderName } from '../media/encoder.ts';
import { fitGeometryForBitrate, negotiateSize, scaleBitrate, type SizeRequest } from '../media/target.ts';
import { InputInjector } from '../host/injector.ts';
import { SecureDesktopMonitor } from '../host/secure-desktop.ts';
import { ForegroundMonitor } from '../host/foreground.ts';
import {
  listDisplays,
  primaryDisplayIndex,
  queryDisplay,
  virtualBounds,
  type HostDisplay,
} from '../host/display.ts';
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
import { AppLogger, installCrashHandlers, parseLogLevel } from '../util/log.ts';
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
import type { Candidate, ServerToClient } from '../signaling/protocol.ts';
import type { DisplayDescriptor } from '../protocol/messages.ts';

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
 * Sessions start at this rate and let the congestion controller probe up to
 * the preset. Starting at the full preset (10 Mbps for balanced) instantly
 * saturated a slower home uplink: the router queued seconds of video
 * before the first receiver report could come back, and the session never
 * recovered its latency. The ramp (x1.25 every ~120 ms on a clean path)
 * reaches the preset in about a second when the bandwidth is really there.
 */
const START_NET_BPS = 3_000_000;

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
    'log-level': { type: 'string', default: '' },
    'log-dir': { type: 'string', default: '' },
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
  --log-level <lvl>   debug|info|warn|error (default info; env RD_LOG_LEVEL)
  --log-dir <path>    log directory (default <state>/logs; env RD_LOG_DIR)
`);
  process.exit(0);
}

const DEVICE_NAME = values.name || hostname();
const STATE_DIR = process.env.RD_STATE_DIR || join(process.cwd(), '.rd-state');
const STATE_FILE = join(STATE_DIR, 'app-state.json');

// Full-fidelity logging: structured lines to <state>/logs/lumen.log (5 MB x 5
// rotation) plus the console and UI mirrors below. When something goes wrong
// the user exports this from the UI log card and sends the file over as-is.
const LOG_DIR = values['log-dir'] || process.env.RD_LOG_DIR || join(STATE_DIR, 'logs');
const logger = new AppLogger({
  dir: LOG_DIR,
  name: 'lumen',
  level: parseLogLevel(values['log-level'] || process.env.RD_LOG_LEVEL),
  consoleEcho: true,
});
installCrashHandlers(logger);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.warn('app', `收到 ${signal}，进程退出`);
    process.exit(0);
  });
}

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
let presetKey: QualityPreset = QUALITY_PRESETS[state.quality] ? state.quality : 'balanced';

// ------------------------------------------------------------------ logging

let ui: UiServer | null = null;
const sendUi = (msg: AppToUi): void => {
  ui?.broadcastText(JSON.stringify(msg));
};

const log = (level: 'info' | 'warn' | 'error', message: string): void => {
  logger.log(level, 'app', message);
  sendUi({ type: 'log', level, message, ts: Date.now() });
};

// ------------------------------------------------------------ runtime state

// Reassigned while a host session owns the panel: the capture size follows the
// resolution the controller asked for instead of the one the user normally runs.
let display = await queryDisplay(preset.fps);
/** Every display attached to this host; refreshed when a host session starts. */
let hostDisplays: HostDisplay[] = await listDisplays(preset.fps);
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
  /** Peer candidates from session setup, kept so a dead path can be re-probed mid-session. */
  peerCandidates: Candidate[];
  /** Relay endpoint from session setup, the re-probe's fallback target. */
  relayEndpoint: { address: string; port: number };
  /** Cancels a background relay->P2P upgrade loop belonging to this session. */
  cancelUpgrade?: () => void;
  /** Which host display is captured/controlled (host role; index into hostDisplays). */
  displayIndex: number;
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
/** Quality the controller asked for in its connect request, if it said. */
let peerQuality: string | undefined;
/**
 * Viewport this device asks hosts to encode for. The renderer reports it, so a
 * browser window on a 1080p laptop asks for 1920x1080 even when the engine runs
 * on a 4K machine.
 */
let controllerSize = { width: display.width, height: display.height };
let pendingEph: EphemeralKeyPair | null = null;
let pendingRole: 'host' | 'controller' = 'host';
let lastKeyframeRestart = 0;
/** Last stats snapshot written to the log file, and when (10 s cadence). */
let lastStatsLoggedAt = 0;
let lastStatsLine = '';
/** Encoder bitrate ceiling learned from congestion feedback (kbps); 0 = use the preset. */
let adaptedBitrateKbps = 0;
/**
 * True once a measured congestion verdict (drop OR recovery step) has
 * been applied this session. Geometry fitting keys on this — not on
 * adaptedBitrateKbps alone (it is seeded with the slow-start value, so
 * the first seconds of a healthy session would shrink), and not on
 * drops alone: a session that only ever climbed from its seed in
 * recovery steps still ended up encoding 2196x1236@60 at 3600 kbps
 * (0.02 bits/px, pure smear) because the drop-only flag never opened
 * the fitting gate.
 */
let verdictApplied = false;
/** Geometry the running encoder was started with (for fit stickiness). */
let lastEncoderGeom: { width: number; height: number; fps: number; context: string } | null = null;
let lastGeomChangeAt = 0;
/** Link-probe deadline (ms epoch); while in the future, adaptation is off. */
let probeUntil = 0;
let probeTimer: ReturnType<typeof setTimeout> | null = null;

function probing(): boolean {
  return Date.now() < probeUntil;
}
let lastBitrateAdaptAt = 0;
/** Since when the congestion verdict has continuously justified a recovery. */
let pendingRecoverAt = 0;
/** Last congestion verdict seen (bps), re-run by the stats heartbeat. */
let lastVerdictBps = 0;
/**
 * Input-path counters for the stats heartbeat. Three checkpoints —
 * controller UI sent / host received / host injected — let one log
 * export say exactly where a dead click stopped travelling.
 */
let inputReceived = 0;
let inputClicksReceived = 0;
let inputForwarded = 0;
let inputClicksForwarded = 0;
/** Pending mid-session resize from the controller, debounced before the encoder restarts. */
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * True while the session runs over the relay: the encoder is capped because the
 * media has to cross two WAN legs plus a shared server.
 */
let relayBudget = false;
/**
 * Bake the host cursor into the video. Only while the controller is in
 * pointer-lock mode, where its own cursor is hidden by the browser.
 */
let bakeCursor = false;
/** Secure desktop (UAC / lock screen) currently owns the host's screen. */
let secureDesktop = { active: false, name: 'Default' };
let desktopMonitor: SecureDesktopMonitor | null = null;
let foregroundMonitor: ForegroundMonitor | null = null;
/** Periodic re-enumeration of the host's displays during a session. */
let displayWatchTimer: ReturnType<typeof setInterval> | null = null;
let displayWatchBusy = false;
/** Periodic check that the host encoder is actually alive. */
let encoderWatchTimer: ReturnType<typeof setInterval> | null = null;
/** Encoder crashes absorbed in the current session, so a broken capture cannot loop. */
let autoRestarts = 0;
/**
 * Decoder configuration of the stream we are receiving, in whichever
 * codec family the host negotiated. The UI gets `codec` (RFC 6381) plus
 * the raw configuration record (avcC or hvcC) as `description`.
 */
let streamConfig: { family: VideoCodecKind; codec: string; description: Buffer } | null = null;
const decodeInUi = values.display === 'ui';
/**
 * Video codecs the peer UI can decode, in its preference order, learned
 * from its resize messages. H.265 is only encoded when 'hevc' is listed
 * AND this host has a hardware HEVC encoder.
 */
let peerVideoCodecs: string[] = ['h264'];
/** Set when the peer's decoder rejected HEVC mid-session: stay on H.264. */
let peerCodecLock: 'h264' | null = null;
/** Video codecs THIS device's UI can decode (reported by the renderer). */
let uiVideoCodecs: string[] = ['h264'];
/** Codec family of the currently running host encoder. */
let encoderFamily: VideoCodecKind = 'h264';

logger.info(
  'app',
  `=== Lumen Remote ${VERSION} 启动 · ${platform()} ${arch()} · Node ${process.version} · pid ${process.pid} ===`,
);
logger.info(
  'app',
  `日志文件 ${logger.filePath} · 级别 ${logger.currentLevel} · 状态目录 ${STATE_DIR}`,
);
logger.info(
  'app',
  `参数 signal=${state.signalHost}:${state.signalPort} ui=${values.ui} source=${values.source} quality=${state.quality} encoder=${values.encoder} inject=${values.inject} upnp=${!values['no-upnp']} 验证码${values.password ? "(命令行已设置)" : "(未设置)"}`,
);

const link = await UdpLink.bind({});
link.setLatch(true);
log('info', `UDP 双栈=${link.isDualStack}${hasGlobalIpv6() ? ' · 检测到公网 IPv6 地址' : ' · 无公网 IPv6'}`);

/** Router port mapping, when the gateway supports NAT-PMP or UPnP. */
let portMapping: PortMapping | null = null;

let signaling: SignalingClient | null = null;
let discovery: { token: string; endpoint: { address: string; port: number } } | null = null;
/** UDP port of the signalling server, learned from its welcome message. */
let signalUdpPort = 7802;
let lastDiscoveryAt = 0;

/**
 * Re-run UDP endpoint discovery and re-register with the signalling server.
 *
 * On a mobile network the endpoint the server observes changes over time
 * (NAT rebinding, cell handover); the relay forwards by that observed
 * endpoint, so a registration made at connect time points at a dead
 * address exactly when the session falls back to the relay. Refreshing
 * keeps the fallback path real.
 */
async function refreshDiscovery(): Promise<void> {
  if (!signaling || !signalOnline) return;
  try {
    const found = await discoverUdpEndpoint(link.raw, state.signalHost, signalUdpPort);
    discovery = found;
    lastDiscoveryAt = Date.now();
    signaling.send({ t: 'udp-token', token: found.token, endpoint: found.endpoint });
  } catch {
    /* best effort: the next watchdog round tries again */
  }
}
let deviceCode = '';
let signalOnline = false;
let signalReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let signalReconnectDelayMs = 2_000;
let signalFailNotified = false;
let shuttingDown = false;

/**
 * A dropped signaling socket used to mean "offline until the app restarts"
 * (a server deploy left every client unreachable). Retry with backoff instead;
 * an active UDP session keeps running while we re-register.
 */
function scheduleSignalReconnect(): void {
  if (shuttingDown || signalReconnectTimer) return;
  const delay = signalReconnectDelayMs;
  signalReconnectDelayMs = Math.min(signalReconnectDelayMs * 2, 30_000);
  log('warn', `信令已断开，${Math.round(delay / 1000)} 秒后重连`);
  signalReconnectTimer = setTimeout(() => {
    signalReconnectTimer = null;
    void connectSignaling();
  }, delay);
  signalReconnectTimer.unref?.();
}

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

/** Human label shared by the log and the controller's screen picker. */
function displayLabel(d: HostDisplay): string {
  return `屏幕 ${d.index + 1}${d.primary ? '（主屏）' : ''} ${d.width}x${d.height}@${d.refreshRate}Hz`;
}

function displayDescriptors(): DisplayDescriptor[] {
  return hostDisplays.map((d) => ({
    index: d.index,
    name: d.name,
    primary: d.primary,
    width: d.width,
    height: d.height,
    refreshRate: d.refreshRate,
  }));
}

/**
 * Point the injector at the display being controlled. Absolute moves are
 * mapped through that display's rectangle (see frameToVirtual), so input
 * physically cannot land on another monitor.
 */
function aimInjector(): void {
  if (!active || active.role !== 'host') return;
  const sel = hostDisplays[active.displayIndex];
  if (!sel) return;
  const virtual = virtualBounds(hostDisplays);
  injector.setTarget(
    { x: sel.x, y: sel.y, width: sel.width, height: sel.height },
    virtual,
  );
  // Logged on every (re)aim so a post-mortem export shows which
  // geometry pointer mapping was actually using at the time.
  log(
    'info',
    `鼠标注入瞄准 屏幕 ${sel.index + 1} ${sel.width}x${sel.height}@${sel.x},${sel.y} · 虚拟桌面 ${virtual.width}x${virtual.height}@${virtual.x},${virtual.y} · 共 ${hostDisplays.length} 块屏`,
  );
}

/** Tell both the controller (data channel) and this UI what can be picked. */
function sendDisplayList(): void {
  if (!active) return;
  sendUi({ type: 'displays', displays: displayDescriptors(), active: active.displayIndex });
  if (active.role === 'host') {
    active.session.sendControl({
      t: 'displays',
      displays: displayDescriptors(),
      active: active.displayIndex,
    });
  }
}

/**
 * Follow the host's input desktop during a session. When the secure
 * desktop (UAC consent, lock screen) takes the screen, Windows suspends
 * both capture and injection for a user-level process: tell the
 * controller immediately so it can show "waiting for a local click"
 * instead of a dead black screen, and revive the encoder on return.
 */
function startDesktopMonitor(): void {
  desktopMonitor?.stop();
  desktopMonitor = new SecureDesktopMonitor({
    log,
    onChange: (nowSecure, name) => {
      secureDesktop = { active: nowSecure, name };
      if (!active || active.role !== 'host') return;
      active.session.sendControl({ t: 'secure-desktop', active: nowSecure });
      sendUi({ type: 'secure-desktop', active: nowSecure });
      if (nowSecure) {
        log(
          'warn',
          `检测到安全桌面（${name}，通常是 UAC 管理员弹窗或锁屏）：远程画面与点击已暂停，已通知主控等待本地确认`,
        );
      } else {
        log('info', '已回到普通桌面，远程画面恢复');
        autoRestarts = 0;
        if (active.encoder && !active.encoder.running) startEncoder(active);
      }
    },
  });
  desktopMonitor.start();
}

/**
 * Log which application owns the host's foreground window. "Clicks do
 * nothing while game X is in front" was undiagnosable from logs: the
 * input chain counters proved delivery, but nothing recorded what was
 * in front, whether it was fullscreen, or whether it had switched the
 * display mode. Now the export says so.
 */
function startForegroundMonitor(): void {
  foregroundMonitor?.stop();
  foregroundMonitor = new ForegroundMonitor({
    log,
    onChange: (info) => {
      if (!active || active.role !== 'host') return;
      const sel = hostDisplays[active.displayIndex];
      const full =
        sel &&
        info.x <= sel.x &&
        info.y <= sel.y &&
        info.width >= sel.width &&
        info.height >= sel.height;
      log(
        'info',
        `前台应用：${info.name} · 窗口 ${info.width}x${info.height}@${info.x},${info.y}${full ? '（全屏覆盖）' : ''} · 完整性 ${info.integrity}`,
      );
    },
    onSelfIntegrity: (integrity) => {
      // The injector is spawned from this process, so synthetic input
      // originates at this level too. If a foreground game logs 高
      // while this says 中, Windows (UIPI) is dropping our input
      // before the game ever sees it — a different wall than games
      // filtering injected-flag events, with a different fix.
      log('info', `本机进程完整性：${integrity}（注入器同级，合成输入的出发级别）`);
    },
  });
  foregroundMonitor.start();
}

/**
 * Follow display-mode changes made by fullscreen applications. Games
 * routinely switch the panel to their own resolution; everything in a
 * session (capture geometry, negotiated size, pointer mapping) is
 * keyed on the layout enumerated at connect time, so a mode switch
 * silently invalidated all of it until the next reconnect. Re-enumerate
 * periodically and re-aim everything at the new layout.
 */
/**
 * Revive a dead encoder during a host session, whatever killed it.
 * Capture death has many transient causes — UAC secure desktops,
 * display-mode switches by games, GPU driver resets, another app
 * holding Desktop Duplication — and the previous design's recovery
 * depended on noticing each cause individually; when one slipped
 * through (a 4 s desktop denial burned the fast-retry budget, and a
 * broken `running` flag blocked the desktop monitor's revive), the
 * session stayed black for a minute while input kept working. A
 * watchdog that simply asks "is the encoder alive?" every 5 s and
 * restarts it if not covers the whole class.
 */
function startEncoderWatchdog(): void {
  stopEncoderWatchdog();
  encoderWatchTimer = setInterval(() => {
    if (!active || active.role !== 'host') return;
    if (secureDesktop.active) return; // capture is supposed to be down
    if (!active.encoder || !active.encoder.running) {
      log('warn', '看门狗：编码器不在运行，尝试恢复采集');
      // Fast retries stay exhausted so a persistent denial costs one
      // spawn per watchdog tick, not a 4-spawn burst every 5 s.
      autoRestarts = 3;
      startEncoder(active);
    }
  }, 5000);
}

function stopEncoderWatchdog(): void {
  if (encoderWatchTimer) clearInterval(encoderWatchTimer);
  encoderWatchTimer = null;
}

function startDisplayWatcher(): void {
  stopDisplayWatcher();
  displayWatchTimer = setInterval(() => {
    void watchDisplays();
  }, 5000);
}

function stopDisplayWatcher(): void {
  if (displayWatchTimer) clearInterval(displayWatchTimer);
  displayWatchTimer = null;
}

async function watchDisplays(): Promise<void> {
  const current = active;
  if (!current || current.role !== 'host' || displayWatchBusy) return;
  displayWatchBusy = true;
  try {
    const now = await listDisplays(preset.fps);
    if (!active || active !== current) return;
    const sig = (ds: HostDisplay[]) =>
      ds.map((d) => `${d.index}:${d.x},${d.y},${d.width},${d.height}`).join(';');
    if (sig(now) === sig(hostDisplays)) return;
    log(
      'warn',
      `检测到显示布局变化（全屏应用可能切换了显示模式）：${hostDisplays.map(displayLabel).join(' · ')} → ${now.map(displayLabel).join(' · ')}，按新布局重新采集与瞄准`,
    );
    hostDisplays = now;
    aimInjector();
    current.encoder?.stop();
    startEncoder(current);
    sendDisplayList();
  } catch {
    /* enumeration hiccup: the next tick retries */
  } finally {
    displayWatchBusy = false;
  }
}

/**
 * Move capture + control to another display at the controller's request.
 * Only the selected screen is captured and injected into; other displays
 * are never touched — in particular the panel takeover (resolution switch
 * and DDC dimming, which by design affect the primary and every panel's
 * brightness) is handed back before capture moves off the primary, and is
 * not re-applied when switching back mid-session.
 */
async function switchDisplay(index: number): Promise<void> {
  const current = active;
  if (!current || current.role !== 'host') return;
  // Re-enumerate first: monitors get plugged and unplugged between sessions.
  hostDisplays = await listDisplays(preset.fps);
  if (!active || active !== current) return;
  const next = hostDisplays[index];
  if (!next) {
    sendDisplayList();
    return;
  }
  if (next.index === current.displayIndex) return;
  current.displayIndex = next.index;
  log('info', `已切换到${displayLabel(next)}（仅影响此屏）`);
  if (!next.primary && panelHold) await releasePanel('（切换到非主屏）');
  if (!active || active !== current) return;
  aimInjector();
  current.encoder?.stop();
  startEncoder(current);
  sendDisplayList();
}

/**
 * The codec family the next encoder should emit. H.265 wherever it is
 * actually usable — the peer's UI must be able to hardware-decode it
 * and this host must have a hardware HEVC encoder. Commercial tools
 * (UU) stream HEVC for a reason: at the same bitrate it carries
 * visibly more picture, which is exactly the gap reported against
 * them at equal latency/fps. An explicit --encoder name always wins
 * over negotiation.
 */
function desiredEncoderFamily(): { family: VideoCodecKind; explicit: EncoderName | 'auto' } {
  const explicit = values.encoder as EncoderName | 'auto';
  if (explicit !== 'auto') {
    return { family: explicit === 'libx265' || explicit.startsWith('hevc') ? 'hevc' : 'h264', explicit };
  }
  if (peerCodecLock === 'h264') return { family: 'h264', explicit };
  if (peerVideoCodecs.includes('hevc') && hevcHardwareEncoder(ffmpegBinary())) {
    return { family: 'hevc', explicit };
  }
  return { family: 'h264', explicit };
}

function startEncoder(target: ActiveSession): void {
  // Never leave an unowned encoder behind: several callers stop the
  // old one first, but the watchdog can interleave with an async
  // display transition and start one the transition does not know
  // about. Stopping here is cheap insurance against a leak.
  if (target.encoder && target.encoder.running) target.encoder.stop();
  // Frames queued for the previous encoder belong to a reference chain that the
  // new keyframe replaces; sending them only delays the useful picture.
  target.session.discardPendingMedia();
  // A fresh encoder already emits an IDR, so an IDR request arriving right after
  // the session starts must not tear it down again.
  lastKeyframeRestart = Date.now();
  // Capture follows the display the controller picked (the primary until
  // they say otherwise); geometry negotiation is against that panel, not
  // the primary the process happened to start with.
  const sel = target.role === 'host' ? (hostDisplays[target.displayIndex] ?? null) : null;
  const capture = sel ?? display;
  const negotiated = negotiateSize(capture, peerDisplay);
  let { width, height } = negotiated;
  let scaled = negotiated.scaled;
  let fps = relayBudget ? Math.min(preset.fps, RELAY_FPS) : preset.fps;
  const presetKbps = relayBudget ? Math.min(preset.bitrateKbps, RELAY_NET_KBPS) : preset.bitrateKbps;
  let bitrateKbps = scaled ? scaleBitrate(presetKbps, capture, { width, height }) : presetKbps;
  // The congestion controller's verdict, learned from the wire: never let the
  // encoder produce faster than the path has proven it can carry. Without
  // this the encoder kept emitting the full preset rate into a saturated
  // pacer, which dropped frames, broke reference chains and forced an
  // encoder restart every second — the visible "卡得要死" death spiral.
  if (probing()) {
    // Link probe: fixed high rate, no verdict clamp, no geometry fit —
    // the stats must show the link's own ceiling, not our control
    // loops' opinion of it.
    bitrateKbps = 45000;
  } else if (adaptedBitrateKbps > 0) {
    bitrateKbps = Math.max(800, Math.min(bitrateKbps, adaptedBitrateKbps));
  }
  // When the network (or the relay budget) has cut the bitrate far below
  // what the negotiated pixels need, shrink the picture to fit the
  // bitrate instead of starving every pixel into mosaic blocks. The
  // smaller frame also serialises much faster on a thin uplink, which
  // is where most of the input lag on a starved 4K stream comes from.
  // Healthy paths never see this: it only engages once a measured
  // verdict (or the relay cap) is in force.
  if (!probing() && (verdictApplied || relayBudget)) {
    const fit = fitGeometryForBitrate({ width, height }, bitrateKbps, fps);
    if (fit.width !== width || fit.height !== height || fit.fps !== fps) {
      // Geometry stickiness: a size change forces the peer to rebuild
      // its decoder and eats a keyframe burst on the thinnest part of
      // the link. The congestion verdict wobbles every few seconds, so
      // refitting on every wobble rebuilt the controller's decoder 104
      // times in one 285 s session (fps samples of 2 amid the storm).
      // A modest fit now keeps the running geometry — the new bitrate
      // still applies, and a same-size restart costs no decoder
      // rebuild. Only a severe collapse (<50% of the running pixels)
      // or the first fit after a 20 s quiet window changes size; fps
      // transitions always apply, since yielding frames for pixels is
      // the point of the fit. Context changes (viewport / quality /
      // display) reset the stickiness via the context key.
      const prev = lastEncoderGeom;
      const fitPx = fit.width * fit.height;
      const prevPx = prev ? prev.width * prev.height : 0;
      const sticky =
        prev !== null &&
        prev.context === `${negotiated.width}x${negotiated.height}@${fps}` &&
        fit.fps === prev.fps &&
        prevPx > 0 &&
        fitPx >= prevPx * 0.5 &&
        fitPx <= prevPx * 1.6 &&
        Date.now() - lastGeomChangeAt < 20000;
      if (sticky && prev) {
        width = prev.width;
        height = prev.height;
        fps = prev.fps;
        scaled = true;
      } else {
        log(
          'info',
          `网络可用码率约 ${bitrateKbps} kbps，编码由 ${width}x${height}@${fps} 调整为 ${fit.width}x${fit.height}@${fit.fps} 以保证清晰度（带宽恢复后自动回升）`,
        );
        width = fit.width;
        height = fit.height;
        fps = fit.fps;
        scaled = true;
        lastGeomChangeAt = Date.now();
      }
    }
  }
  lastEncoderGeom = {
    width,
    height,
    fps,
    context: `${negotiated.width}x${negotiated.height}@${relayBudget ? Math.min(preset.fps, RELAY_FPS) : preset.fps}`,
  };
  const { family, explicit: explicitEncoder } = desiredEncoderFamily();
  if (family === 'h264' && explicitEncoder === 'auto' && peerCodecLock !== 'h264' && peerVideoCodecs.includes('hevc')) {
    log('info', '主控支持 H.265 解码，但本机无 HEVC 硬件编码器，继续使用 H.264');
  }
  encoderFamily = family;

  let self: ScreenEncoder | null = null;
  const encoder: ScreenEncoder = new ScreenEncoder({
    source:
      values.source === 'test' || probing()
        ? { kind: 'test', size: `${capture.width}x${capture.height}` }
        : {
            kind: 'screen',
            mode: 'auto',
            outputIndex: sel?.index,
            rect: sel ? { x: sel.x, y: sel.y, width: sel.width, height: sel.height } : undefined,
            drawMouse: bakeCursor,
          },
    fps,
    bitrateKbps,
    targetSize: scaled ? { width, height } : undefined,
    encoder: explicitEncoder,
    codec: family,
    ffmpegPath: ffmpegBinary(),
    onAccessUnit: (au) => {
      if (!active || active.role !== 'host') return;
      // A stopped encoder can still flush its last access units; those belong to
      // a reference chain the replacement already superseded.
      if (active.encoder && active.encoder !== self) return;
      try {
        const sent = active.session.sendFrame(
          family === 'hevc' ? Codec.HEVC : Codec.H264,
          au.isKey ? FrameFlags.Key : 0,
          au.payload,
        );
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
      if (secureDesktop.active) {
        // Expected: Windows took the screen away (UAC / lock). Do not burn
        // the crash budget on it — the desktop monitor restarts capture
        // when the normal desktop comes back.
        log('info', '编码器随安全桌面暂停，桌面恢复后自动重启');
        return;
      }
      if (autoRestarts >= 3) {
        log('error', '编码器多次异常退出，暂停快速重启（看门狗将每 5 秒重试；或检查显卡驱动/是否有其他远控软件占用桌面复制）');
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
    const codecLabel = `${family === 'hevc' ? 'H.265' : 'H.264'}/${resolveEncoder(explicitEncoder, ffmpegBinary(), family)}`;
    log(
      'info',
      `屏幕采集 ${mode} ${capture.width}x${capture.height}@${fps}${shape} · 编码 ${codecLabel}${sel ? ` · ${displayLabel(sel)}` : ''}`,
    );
  }
}

function onIncomingFrame(frame: IncomingFrame): void {
  if (!active || active.role !== 'controller') return;
  const family: VideoCodecKind = frame.codec === Codec.HEVC ? 'hevc' : 'h264';
  const units = splitAnnexB(frame.payload, family);
  // Re-derive the config from every parameter set seen, not just the
  // first: a mid-session encoder restart at a new size brings a new SPS,
  // and a controller still holding the first config decodes garbage (or
  // errors out and never recovers, because no new config ever arrives).
  if (family === 'hevc') {
    const sets = extractHevcParameterSets(units);
    if (sets.vps && sets.sps && sets.pps) {
      const current = streamConfig?.family === 'hevc' ? streamConfig : null;
      const next = hevcStreamConfigChanged(current ? { hvcC: current.description } : null, sets.vps, sets.sps, sets.pps);
      if (next) {
        if (streamConfig) log('info', `视频参数变化（编码器换尺寸重启），已通知界面重建解码器 ${next.codec}`);
        streamConfig = { family: 'hevc', codec: next.codec, description: next.hvcC };
        sendUi({ type: 'config', codec: next.codec, description: next.hvcC.toString('base64') });
      } else if (!streamConfig) {
        // SPS we cannot parse into an hvcC: better to ask for H.264
        // than to leave the UI staring at an unconfigurable stream.
        log('warn', 'H.265 参数集无法解析，请求被控回退 H.264');
        active.session.sendControl({ t: 'codec', codec: 'h264' });
      }
    }
  } else {
    const sps = units.find((u) => u.type === 7);
    const pps = units.find((u) => u.type === 8);
    if (sps && pps) {
      const current = streamConfig?.family === 'h264' ? streamConfig : null;
      const next = streamConfigChanged(
        current ? { sps: Buffer.from(sps.data), pps: Buffer.from(pps.data), avcC: current.description, codec: current.codec } : null,
        Buffer.from(sps.data),
        Buffer.from(pps.data),
      );
      if (next) {
        if (streamConfig) log('info', `视频参数变化（编码器换尺寸重启），已通知界面重建解码器 ${next.codec}`);
        streamConfig = { family: 'h264', codec: next.codec, description: next.avcC };
        sendUi({ type: 'config', codec: next.codec, description: next.avcC.toString('base64') });
      }
    }
  }
  if (!streamConfig || !decodeInUi) return;
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
  if (signalReconnectTimer) {
    clearTimeout(signalReconnectTimer);
    signalReconnectTimer = null;
  }
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
    signalReconnectDelayMs = 2_000;
    signalFailNotified = false;
    signalUdpPort = welcome.udpPort;
    discovery = await discoverUdpEndpoint(link.raw, state.signalHost, welcome.udpPort);
    lastDiscoveryAt = Date.now();
    if (discovery) client.send({ t: 'udp-token', token: discovery.token, endpoint: discovery.endpoint });
    log('info', `设备 ID ${deviceCode} · 信令 ${state.signalHost}:${state.signalPort}`);
    emitDevice();
    client.onMessage((msg) => void onSignaling(msg));
    client.onClose(() => {
      if (signaling !== client) return;
      signalOnline = false;
      deviceCode = '';
      emitDevice();
      scheduleSignalReconnect();
    });
  } catch (err) {
    log('error', `无法连接信令服务: ${(err as Error).message}`);
    emitDevice();
    if (!signalFailNotified) {
      signalFailNotified = true;
      sendUi({ type: 'notice', level: 'error', message: `信令服务不可达 (${state.signalHost}:${state.signalPort})` });
    }
    scheduleSignalReconnect();
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
      peerQuality = msg.display?.quality;
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
  streamConfig = null;
  peerVideoCodecs = ['h264'];
  peerCodecLock = null;
  relayBudget = false;
  if (current) {
    current.cancelUpgrade?.();
    current.encoder?.stop();
    current.session.close(reason);
    if (current.role === 'host') injector.stop();
  }
  desktopMonitor?.stop();
  desktopMonitor = null;
  foregroundMonitor?.stop();
  foregroundMonitor = null;
  stopDisplayWatcher();
  stopEncoderWatchdog();
  if (probeTimer) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
  probeUntil = 0;
  secureDesktop = { active: false, name: 'Default' };
  if (current.role === 'host') void releasePanel(reason);
  sendUi({ type: 'session-end', reason });
  log(
    'info',
    `会话结束 ${reason} · 时长 ${Math.max(0, Math.round((Date.now() - current.startedAt) / 1000))}s · 路由 ${current.route}`,
  );
  if (lastStatsLine) log('info', `结束时统计 ${lastStatsLine}`);
  rotateOnceCode();
}

/** Wire the background relay->P2P upgrade for a path that landed on the relay. */
function wireRelayUpgrade(path: PathResult): void {
  if (path.route !== 'relay' || !path.upgrade) return;
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
  if (active) active.cancelUpgrade = path.cancelUpgrade;
}

let reprobing = false;
let lastReprobeAt = 0;

/**
 * Re-run path selection for a live session whose path went silent.
 *
 * Previously the route chosen at connect time was final: if the peer's
 * endpoint changed (mobile NAT rebinding, cell handover) or the punch
 * decayed, both sides talked to a dead address for 8 s and then hung up.
 * Now 4 s of silence triggers a re-probe — candidates plus the relay,
 * with the relay registration refreshed first — and the session only
 * ends after 25 s of total silence. Session-level path migration (see
 * Session.maybeMigrate) heals the common endpoint-change case even
 * before this fires.
 */
async function reprobePath(): Promise<void> {
  const current = active;
  if (!current || reprobing) return;
  if (Date.now() - lastReprobeAt < 6000) return;
  reprobing = true;
  lastReprobeAt = Date.now();
  log('warn', '数据通道无响应，正在重新探测路径…');
  try {
    await refreshDiscovery();
    const path = await selectDataPath({
      link,
      session: current.session,
      candidates: values['force-relay'] ? [] : current.peerCandidates,
      relay: current.relayEndpoint,
    });
    if (!active || active !== current) return;
    current.cancelUpgrade?.();
    current.route = path.route;
    sendUi({ type: 'session-route', route: path.route });
    log('info', `数据通道重新探测完成：${path.route === 'p2p' ? 'P2P 直连' : '中继转发'} ${path.endpoint.address}:${path.endpoint.port}`);
    const wasRelay = relayBudget;
    relayBudget = path.route === 'relay';
    if (current.role === 'host' && relayBudget !== wasRelay) {
      if (relayBudget) {
        const cap = Math.min(preset.netKbps, RELAY_NET_KBPS);
        current.session.setMaxBudget(cap * 1000);
        log('info', `已切换到中继：码率上限 ${cap} kbps · 帧率上限 ${RELAY_FPS} fps（打通 P2P 后自动恢复）`);
      } else {
        current.session.setMaxBudget(preset.netKbps * 1000);
        log('info', `已恢复 P2P：码率上限 ${preset.netKbps} kbps`);
      }
      startEncoder(current);
    }
    wireRelayUpgrade(path);
  } catch (err) {
    log('warn', `重新探测路径失败: ${(err as Error).message}`);
  } finally {
    reprobing = false;
  }
}

/**
 * Both peers ping every 250 ms, so silence means the path (or the peer) is
 * gone. A dead path gets re-probed long before the session is declared
 * over; only sustained silence ends it, so a host is not left in its
 * "being controlled" card forever when a phone is truly killed.
 */
setInterval(() => {
  if (!active) return;
  const silenceMs = Date.now() - lastPeerAt;
  if (silenceMs > 25000) {
    endSession('连接超时（对方已离线）');
    return;
  }
  if (silenceMs > 4000) void reprobePath();
  if (Date.now() - lastDiscoveryAt > 30000) void refreshDiscovery();
}, 3000).unref?.();

/**
 * Fifteen seconds of fixed-rate test pattern with every adaptation
 * loop disabled (see the 'probe' control message). The stats logged
 * during the window — offered 45 Mbps vs delivered send/recv, loss,
 * displayed-vs-received frames — separate a genuinely thin uplink
 * from our own congestion/restart cycle manufacturing one.
 */
function startProbe(): void {
  if (!active || active.role !== 'host') return;
  if (probeTimer) clearTimeout(probeTimer);
  probeUntil = Date.now() + 15000;
  log(
    'warn',
    '链路测速开始：15 秒测试图固定 45000 kbps 发送（绕过拥塞裁决与尺寸拟合）——期间画面为测试图案，测完自动恢复',
  );
  active.encoder?.stop();
  startEncoder(active);
  const probingSession = active;
  probeTimer = setTimeout(() => {
    probeTimer = null;
    probeUntil = 0;
    if (active && active === probingSession && active.role === 'host') {
      log('info', '链路测速结束，恢复正常采集与自适应');
      active.encoder?.stop();
      startEncoder(active);
    }
  }, 15000);
  probeTimer.unref?.();
}

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
  if (role === 'host') {
    hostDisplays = await listDisplays(preset.fps);
    log(
      'info',
      hostDisplays.length > 1
        ? `检测到 ${hostDisplays.length} 块屏幕：${hostDisplays.map(displayLabel).join(' · ')}，默认主屏`
        : `单屏 ${displayLabel(hostDisplays[0]!)}`,
    );
    if (state.handOverDisplay && peerQuality === 'uhd') {
      // 真4K means the panel must stay native: taking it over would
      // switch a 3840x2160 panel down to the controller's viewport and
      // the "4K" stream would be an upscale of a smaller desktop —
      // exactly the soft picture the user is complaining about.
      log('info', '主控请求真4K：保持本机原生分辨率，不切换面板');
    } else if (state.handOverDisplay) {
      await takeOverPanel(negotiateSize(display, peerDisplay));
      // The takeover may have changed the primary's mode; re-read the sizes
      // so capture geometry and the screen picker describe reality.
      hostDisplays = await listDisplays(preset.fps);
    }
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
  bakeCursor = false;
  // Seed the encoder at the slow-start rate too: an encoder producing the
  // full preset into a 3 Mbps pacer just gets its frames dropped until the
  // first congestion adaptation lands seconds later.
  adaptedBitrateKbps = Math.floor(Math.min(preset.netKbps * 1000, START_NET_BPS) / NET_OVERHEAD / 1000);
  verdictApplied = false;
  lastEncoderGeom = null;
  lastGeomChangeAt = 0;
  lastBitrateAdaptAt = 0;
  pendingRecoverAt = 0;
  lastVerdictBps = 0;
  inputReceived = 0;
  inputClicksReceived = 0;
  inputForwarded = 0;
  inputClicksForwarded = 0;
  if (resizeTimer) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }

  // Feed the congestion verdict back into the encoder (debounced, and
  // only on a material change): pacing alone cannot fix an encoder that
  // produces 12 Mbps into a 5 Mbps uplink — it can only drop the excess.
  // No encoder yet (path still probing) is not a reason to drop the
  // verdict: record it, and startEncoder picks it up when it starts.
  const applyVerdict = (bps: number): void => {
    if (!active || active.role !== 'host') return;
    if (probing()) return; // a probe measures the raw link; adapting would contaminate it
    const now = Date.now();
    const kbps = Math.max(800, Math.floor(bps / NET_OVERHEAD / 1000));
    // Judge the verdict against what the encoder can actually run at:
    // the preset (or relay) cap. The wire verdict swings far above it
    // on a probing link (4.6M -> 18.6M -> 4.6M ...), and comparing /
    // storing it raw restarted the encoder at the *same* capped rate
    // over and over — 16 no-op restarts in one 8-minute session, each
    // costing a stall plus a keyframe burst into a thin uplink.
    const capKbps = relayBudget ? Math.min(preset.bitrateKbps, RELAY_NET_KBPS) : preset.bitrateKbps;
    const capped = Math.min(kbps, capKbps);
    const current = adaptedBitrateKbps > 0 ? Math.min(adaptedBitrateKbps, capKbps) : capKbps;
    // Wide hysteresis: restarting the encoder costs a pipeline stall
    // plus a keyframe burst, so on a healthy-but-variable link the cure
    // was worse than the disease — a visible freeze every few seconds.
    // Only a deep, sustained mismatch (40%+) justifies the restart;
    // the pacer absorbs anything smaller by dropping frames.
    const drop = capped < current * 0.6;
    const recover = adaptedBitrateKbps > 0 && capped > current * 1.5;
    if (!drop && !recover) {
      pendingRecoverAt = 0;
      return;
    }
    // A recovery must be sustained, not a probe spike: the congestion
    // target regularly leaps to the ceiling for a second or two while
    // probing, then crashes back. Acting on the spike restarted the
    // encoder (and rebuilt the peer's decoder at a new size) five
    // times in half a minute — the visible stall right after the
    // user asked for 4K. Drops stay immediate: protecting the link
    // cannot wait, climbing back can.
    if (recover && !drop) {
      if (pendingRecoverAt === 0) {
        pendingRecoverAt = now;
        return;
      }
      if (now - pendingRecoverAt < 3000) return;
    }
    pendingRecoverAt = 0;
    // Both directions now land at most every 8 s. Recoveries used to
    // get a faster 3 s cadence so a fresh 4K stream would not be
    // judged by its low-bitrate opening — but on a flapping link each
    // step is an encoder restart plus a keyframe burst, and the steps
    // fired every few seconds for entire sessions. With geometry
    // stickiness a slower climb costs little sharpness and buys a
    // stable picture; drops keep the same cadence (they were never
    // the thrashy direction once clamped, and 8 s is still fast
    // enough to protect the link via the pacer in between).
    if (now - lastBitrateAdaptAt < 8000) return;
    lastBitrateAdaptAt = now;
    // Recover in steps, not in one leap to the (probing) verdict: a
    // 1.5x step that the link cannot hold is absorbed by the pacer
    // inside the hysteresis band instead of crashing straight back
    // down and restarting the encoder again.
    adaptedBitrateKbps = drop ? capped : Math.min(capped, Math.floor(current * 1.5));
    if (capped >= capKbps) adaptedBitrateKbps = 0; // fully recovered: preset rate rules
    verdictApplied = true;
    log('info', `按网络状况调整编码码率至 ${adaptedBitrateKbps > 0 ? adaptedBitrateKbps : capKbps} kbps`);
    if (active.encoder) {
      active.encoder.stop();
      startEncoder(active);
    }
  };

  const session = new Session({
    role,
    link,
    keys,
    sessionId: msg.sessionId,
    initialBitrateBps: Math.min(preset.netKbps * 1000, START_NET_BPS),
    maxBitrateBps: preset.netKbps * 1000,
    logger: logger.child('session'),
    onInput: (event) => {
      inputReceived++;
      if (event.k === 'mb' && event.down) inputClicksReceived++;
      injector.inject(event);
    },
    onFrame: (frame) => onIncomingFrame(frame),
    onControl: (ctl) => {
      lastPeerAt = Date.now();
      if (ctl.t === 'bye') {
        endSession(ctl.reason ?? '对方已断开');
        return;
      }
      if (ctl.t === 'secure-desktop' && role === 'controller') {
        sendUi({ type: 'secure-desktop', active: ctl.active });
        if (ctl.active) {
          log('warn', '对方屏幕被系统安全提示占用（UAC/锁屏），画面已暂停，等待对方本地确认');
        } else {
          log('info', '对方已确认系统提示，画面恢复');
        }
        return;
      }
      if (ctl.t === 'displays' && role === 'controller') {
        sendUi({ type: 'displays', displays: ctl.displays, active: ctl.active });
        return;
      }
      if (ctl.t === 'select-display' && role === 'host') {
        void switchDisplay(Math.round(ctl.index));
        return;
      }
      if (ctl.t === 'pointer-lock' && role === 'host' && active) {
        if (ctl.locked !== bakeCursor) {
          bakeCursor = ctl.locked;
          log('info', bakeCursor ? '主控进入鼠标锁定：已将本机光标烘焙进画面' : '主控退出鼠标锁定：恢复本地光标');
          active.encoder?.stop();
          startEncoder(active);
        }
        return;
      }
      if (ctl.t === 'codec' && role === 'host' && active) {
        // The peer's decoder rejected the negotiated codec (or its SPS
        // would not parse): pin H.264 for the rest of the session.
        // Idempotent — repeated requests change nothing.
        if (ctl.codec === 'h264' && peerCodecLock !== 'h264') {
          peerCodecLock = 'h264';
          log('warn', '主控解码端不支持当前编码，已回退 H.264（本会话内不再尝试 H.265）');
          if (encoderFamily !== 'h264' && active.encoder?.running) {
            active.encoder.stop();
            startEncoder(active);
          }
        }
        return;
      }
      if (ctl.t === 'resize' && role === 'host' && active) {
        // Codec capabilities ride along with the viewport report. If
        // they unlock (or revoke) H.265 relative to the running encoder,
        // switch families once — one restart at negotiation time, not
        // a mid-session surprise.
        if (Array.isArray(ctl.codecs) && ctl.codecs.length > 0) {
          const cleaned = ctl.codecs.filter((c) => c === 'hevc' || c === 'h264');
          if (cleaned.length > 0 && cleaned.join(',') !== peerVideoCodecs.join(',')) {
            peerVideoCodecs = cleaned;
            if (active.encoder?.running && desiredEncoderFamily().family !== encoderFamily) {
              log('info', `主控解码能力 ${cleaned.join('/')}，切换编码为 ${desiredEncoderFamily().family === 'hevc' ? 'H.265' : 'H.264'}`);
              active.encoder.stop();
              startEncoder(active);
            }
          }
        }
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
      if (ctl.t === 'probe' && role === 'host' && active) {
        startProbe();
        return;
      }
      if (ctl.t === 'quality' && role === 'host' && active) {
        // Session-scoped: the host owner's own saved default is left
        // untouched; this only steers the running encoder (and the log
        // says why the fps/bitrate suddenly changed).
        const key = ctl.preset as QualityPreset;
        const p = QUALITY_PRESETS[key];
        if (p && key !== presetKey) {
          presetKey = key;
          preset = p;
          active.session.setMaxBudget(qualityCeilingBps(p));
          log('info', `主控请求画质 ${p.label} · ${p.fps} fps · ${p.bitrateKbps} kbps`);
          if (key === 'uhd' && panelHold?.applied) {
            // The panel was taken over (switched down) at session start,
            // so the capture source itself is no longer 4K. Restore the
            // native mode before encoding, or the 4K stream is just an
            // upscale. Async: display switching takes a second or two.
            log('info', '主控请求真4K：恢复本机原生分辨率后重新采集');
            active.encoder?.stop();
            void (async () => {
              await releasePanel('（主控请求真4K）');
              if (!active || active.role !== 'host') return;
              hostDisplays = await listDisplays(preset.fps);
              log('info', `恢复原生后面板：${hostDisplays.map(displayLabel).join(' · ')}（共 ${hostDisplays.length} 块屏）`);
              // Re-aim the injector at the restored panel: absolute
              // pointer mapping runs through the display rectangle, and
              // the restore just changed it (2560x1440 -> 3840x2160,
              // with the other panels shifting inside the virtual
              // desktop). Skipping this left every click landing in a
              // compressed top-left region — the controller looked
              // completely dead, and switching quality back did not
              // re-aim either, so only a reconnect recovered it.
              aimInjector();
              startEncoder(active);
              sendDisplayList();
            })();
          } else {
            active.encoder?.stop();
            startEncoder(active);
          }
        }
        return;
      }
      if (ctl.t !== 'idr' || role !== 'host' || !active) return;
      const now = Date.now();
      // Restarting the encoder means a pipeline stall plus the largest
      // frame of the GOP straight into whatever congestion prompted the
      // request. 2 s let a struggling controller trigger that cycle
      // continuously; the GOP (2 s) bounds the wait for a natural IDR
      // anyway, so only honour explicit requests at a calmer cadence.
      if (now - lastKeyframeRestart > 5000) {
        lastKeyframeRestart = now;
        active.encoder?.stop();
        startEncoder(active);
      }
    },
    onStats: (s) => {
      sendUi({ type: 'stats', stats: toDto(s) });
      // Re-run the last verdict from this heartbeat: once the
      // congestion target pins at the ceiling it stops changing, so no
      // further onBitrateChange arrives — without this, a recovery
      // armed (or due its next 1.5x step) was never executed and the
      // encoder froze at its first stepped rate for the whole session
      // while the stats claimed a 31M target. The verdict's own
      // sustained/cadence gates throttle how often this can act.
      if (active?.role === 'host' && lastVerdictBps > 0) {
        applyVerdict(lastVerdictBps);
      }
      // A 10 s stats heartbeat in the log file is what makes "it stuttered
      // around 21:40" answerable after the fact: the live UI numbers are
      // gone the moment the session ends, the file keeps the whole curve.
      const now = Date.now();
      if (now - lastStatsLoggedAt < 10_000) return;
      lastStatsLoggedAt = now;
      lastStatsLine =
        `role=${s.role} route=${active?.route ?? '?'} fps=${Math.round(s.fps)} ` +
        `rtt=${(s.rttUs / 1000).toFixed(1)}ms oneway=${(s.oneWayUs / 1000).toFixed(1)}ms ` +
        `loss=${s.lossPct}% jitter=${(s.jitterUs / 1000).toFixed(1)}ms ` +
        `target=${(s.targetBps / 1e6).toFixed(2)}M pacer=${(s.pacerRateBps / 1e6).toFixed(2)}M ` +
        `send=${(s.sendBps / 1e6).toFixed(2)}M recv=${(s.recvBps / 1e6).toFixed(2)}M ` +
        `queue=${s.queueBytes}B pending=${s.pendingFrames} drop=${s.droppedFrames} skip=${s.skippedFrames} ` +
        `fec=${s.recoveredFrames} rxpkts=${s.packetsReceived} authfail=${s.authFailures}`;
      // Input checkpoints (see counters above): a dead-click report is
      // answerable by comparing clicksSent (controller) with clicks
      // (host) and injDrop — no more guessing which hop ate the input.
      lastStatsLine +=
        s.role === 'host'
          ? ` in=${inputReceived} clicks=${inputClicksReceived} inj=${injector.running ? 'on' : 'off'} injDrop=${injector.droppedEvents}`
          : ` inSent=${inputForwarded} clicksSent=${inputClicksForwarded}`;
      logger.info('stats', lastStatsLine);
    },
    onBitrateChange: (bps) => {
      log('info', `目标码率 ${(bps / 1000).toFixed(0)} kbps`);
      lastVerdictBps = bps;
      applyVerdict(bps);
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
    caps: [...uiVideoCodecs, 'webcodecs'],
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

  active = {
    session,
    role,
    peerName: msg.peer.name,
    peerCode: msg.peer.code,
    route: path.route,
    startedAt: Date.now(),
    sessionId: msg.sessionId,
    peerCandidates: values['force-relay'] ? [] : msg.peerCandidates,
    relayEndpoint: relay,
    displayIndex: role === 'host' ? primaryDisplayIndex(hostDisplays) : 0,
  };
  wireRelayUpgrade(path);
  lastPeerAt = Date.now();

  if (role === 'host') {
    if (relayBudget) {
      const cap = Math.min(preset.netKbps, RELAY_NET_KBPS);
      session.setMaxBudget(cap * 1000);
      log('info', `中继模式：码率上限 ${cap} kbps · 帧率上限 ${RELAY_FPS} fps（打通 P2P 后自动恢复）`);
    }
    startEncoder(active);
    injector.start();
    aimInjector();
    sendDisplayList();
    startDesktopMonitor();
    startForegroundMonitor();
    startDisplayWatcher();
    startEncoderWatchdog();
  }

  // The controller's quality choice drives the host's encoder; without
  // this the host only ever used its own saved preset (default 30 fps).
  if (role === 'controller') {
    session.sendControl({ t: 'quality', preset: presetKey });
    // Report the viewport AND the decode capabilities immediately, so
    // the host's first encoder (started during path selection above)
    // already knows whether H.265 is on the table.
    session.sendControl({
      t: 'resize',
      width: controllerSize.width,
      height: controllerSize.height,
      fps: preset.fps,
      codecs: uiVideoCodecs,
    });
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
    display: { width: controllerSize.width, height: controllerSize.height, fps: preset.fps, quality: presetKey },
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


/** Ceiling for a quality preset, honouring the relay budget when on it. */
function qualityCeilingBps(p: (typeof QUALITY_PRESETS)[QualityPreset]): number {
  return (relayBudget ? Math.min(p.netKbps, RELAY_NET_KBPS) : p.netKbps) * 1000;
}

function applyQuality(next: QualityPreset): void {
  const p = QUALITY_PRESETS[next];
  if (!p) return;
  state = { ...state, quality: next };
  saveState(state);
  preset = p;
  presetKey = next;
  if (active) active.session.setMaxBudget(qualityCeilingBps(p));
  if (active?.role === 'controller') {
    active.session.sendControl({ t: 'quality', preset: next });
  }
  if (active?.role === 'host' && active.encoder) {
    active.encoder.stop();
    startEncoder(active);
  }
  emitSettings();
  log('info', `画质 ${p.label} · ${p.bitrateKbps} kbps`);
}

/**
 * Everything a developer needs to diagnose a bad session, in one text file:
 * environment header, the engine log tail, and the browser-side log the UI
 * kept. No secrets: access codes and key material are never logged, and the
 * logger redacts credential-looking assignments on the way in.
 */
function buildLogBundle(clientLog?: string): string {
  const sessionLine = active
    ? `${active.role} · 对端 ${active.peerName} (${active.peerCode}) · 路由 ${active.route} · 已持续 ${Math.max(0, Math.round((Date.now() - active.startedAt) / 1000))}s`
    : '无';
  const header = [
    'Lumen Remote 日志导出',
    `生成时间 ${new Date().toISOString()}（本机 ${new Date().toString()}）`,
    `版本 ${VERSION} · 平台 ${platform()} ${arch()} · Node ${process.version} · pid ${process.pid} · 进程已运行 ${Math.round(process.uptime())}s`,
    `设备 ${DEVICE_NAME} · 编号 ${deviceCode || '(未上线)'} · 信令 ${state.signalHost}:${state.signalPort} ${signalOnline ? '在线' : '离线'}`,
    `显示 ${display.width}x${display.height}@${display.fps} · 画质 ${preset.label} ${preset.bitrateKbps}kbps/${preset.fps}fps`,
    `日志文件 ${logger.filePath} · 级别 ${logger.currentLevel}`,
    `当前会话 ${sessionLine}`,
    lastStatsLine ? `最近统计 ${lastStatsLine}` : '最近统计 （无）',
  ].join('\n');
  return `${header}\n\n===== 引擎日志（文件尾部） =====\n${logger.exportText()}\n\n===== 界面日志（浏览器） =====\n${clientLog?.trim() ? clientLog.trim() : '（无）'}\n`;
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
    case 'probe':
      if (active?.role === 'controller') active.session.sendControl({ t: 'probe' });
      break;
    case 'keyframe':
      active?.session.requestKeyframe();
      break;
    case 'select-display':
      if (active?.role === 'controller') {
        active.session.sendControl({ t: 'select-display', index: Math.round(msg.index) });
      }
      break;
    case 'pointer-lock':
      if (active?.role === 'controller') {
        active.session.sendControl({ t: 'pointer-lock', locked: msg.locked });
      }
      break;
    case 'client-display':
      if (Array.isArray(msg.codecs) && msg.codecs.length > 0) {
        const cleaned = msg.codecs.filter((c) => c === 'hevc' || c === 'h264');
        if (cleaned.length > 0) uiVideoCodecs = cleaned;
      }
      if (msg.width > 0 && msg.height > 0) {
        controllerSize = { width: Math.round(msg.width), height: Math.round(msg.height) };
        // Mid-session (window resize, entering/leaving fullscreen) the host
        // must hear about it, otherwise it keeps encoding for the size the
        // window had at connect time and fullscreen shows that small,
        // blurry picture. Previously this only updated a local variable
        // that nothing read until the NEXT connection.
        if (active?.role === 'controller') {
          active.session.sendControl({
            t: 'resize',
            width: controllerSize.width,
            height: controllerSize.height,
            fps: preset.fps,
            codecs: uiVideoCodecs,
          });
        }
      }
      break;
    case 'codec-fallback':
      // Our own UI cannot decode what the host is sending (the WebCodecs
      // capability probe is best-effort, this is the ground truth). Ask
      // the host to pin H.264; it stays there for the session.
      if (active?.role === 'controller') {
        log('warn', '本机界面无法解码当前视频流，已请求被控回退 H.264');
        active.session.sendControl({ t: 'codec', codec: 'h264' });
      }
      break;
    case 'input':
      if (active?.role === 'controller' && isInputEvent(msg.event)) {
        inputForwarded++;
        if (msg.event.k === 'mb' && msg.event.down) inputClicksForwarded++;
        active.session.sendInput(msg.event);
      }
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
    case 'export-logs': {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      sendUi({
        type: 'log-bundle',
        filename: `lumen-logs-${stamp}.txt`,
        text: buildLogBundle(msg.clientLog),
      });
      log('info', '已导出日志（设置页「运行日志 → 导出日志」）');
      break;
    }
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
      if (streamConfig) push({ type: 'config', codec: streamConfig.codec, description: streamConfig.description.toString('base64') });
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
  shuttingDown = true;
  endSession('应用退出');
  signaling?.close();
  ui?.close();
  link.close();
  // Give the panel restore a chance to run before the process goes away.
  void releasePanel('').finally(() => process.exit(0));
});

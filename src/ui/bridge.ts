/**
 * Messages exchanged between the Node processes and the browser UI over the
 * local WebSocket. Binary frames (kind 1) use this 20-byte header:
 *
 *   u8  kind        1 = video sample
 *   u8  flags       bit0 = keyframe
 *   u16 reserved
 *   u32 frameId
 *   f64 captureTsUs (host monotonic clock)
 *   u32 oneWayUs    transport latency estimate for this frame
 */

export const VIDEO_HEADER_LEN = 20;

export type QualityPreset = 'office' | 'balanced' | 'game' | 'uhd';

/**
 * `bitrateKbps` is the encoder target, which is what the user thinks of as
 * "画质". The network budget must additionally carry FEC parity, per-fragment
 * headers and occasional retransmissions, so `netKbps` is derived from it
 * rather than being the same number.
 */
export const QUALITY_PRESETS: Record<
  QualityPreset,
  { label: string; fps: number; bitrateKbps: number; netKbps: number; note: string }
> = {
  office: { label: '办公', fps: 30, bitrateKbps: 6_000, netKbps: 7_600, note: '文字优先 · 低带宽' },
  balanced: { label: '平衡', fps: 30, bitrateKbps: 8_000, netKbps: 10_000, note: '清晰与流畅兼顾 · 低延迟' },
  game: { label: '游戏', fps: 60, bitrateKbps: 25_000, netKbps: 31_000, note: '高帧率 · 低延迟' },
  uhd: { label: '4K', fps: 60, bitrateKbps: 45_000, netKbps: 56_000, note: '4K60 · 最高画质' },
};

/** Overhead factor from encoder bitrate to on-wire rate. */
export const NET_OVERHEAD = 1.25;

/**
 * 单次 = 每次启动生成，会话结束后再换一个
 * 今日 = 当天内固定，跨零点自动更换
 * 长期 = 用户自设，长期不变
 */
export type VerifyMode = 'once' | 'daily' | 'long';

export type UiToApp =
  | { type: 'accept'; sessionId: string }
  | { type: 'decline'; sessionId: string; reason?: string }
  | { type: 'connect'; code: string; password?: string }
  | { type: 'disconnect' }
  /** Session quality pick. fps/bitrateKbps optionally override the preset for this session (UU-style bitrate tiers + independent frame rate); they are never persisted as the device default. */
  | { type: 'quality'; preset: QualityPreset; fps?: number; bitrateKbps?: number }
  | { type: 'keyframe' }
  | { type: 'probe' }
  /**
   * The UI's stage size, plus the video codecs this UI can decode in
   * preference order (probed via WebCodecs). The app forwards the list
   * to the host, which only negotiates H.265 when 'hevc' appears here.
   */
  | { type: 'client-display'; width: number; height: number; fps?: number; codecs?: string[] }
  /** The UI could not configure a decoder for the stream it is receiving (e.g. no HEVC hardware decode): ask the host to fall back to H.264. */
  | { type: 'codec-fallback' }
  | { type: 'input'; event: unknown }
  | { type: 'set-allow'; enabled: boolean }
  | { type: 'set-handover'; enabled: boolean }
  | { type: 'set-blackout'; enabled: boolean }
  | { type: 'set-verify'; mode: VerifyMode; password?: string }
  | { type: 'set-signal'; host: string; port: number }
  | { type: 'fav-add'; code: string; name?: string }
  | { type: 'export-logs'; clientLog?: string }
  | { type: 'select-display'; index: number }
  | { type: 'pointer-lock'; locked: boolean }
  | { type: 'fav-remove'; code: string };

export interface AppSettingsDto {
  quality: QualityPreset;
  verifyMode: VerifyMode;
  /** Fixed code used when verifyMode is 'long'. */
  longPassword: string;
  /** Code currently required from controllers. */
  accessCode: string;
  allowRemote: boolean;
  signalHost: string;
  signalPort: number;
  /** Match the controller's resolution while a session runs. */
  handOverDisplay: boolean;
  /** Also drop the local panel to zero brightness (needs DDC/CI). */
  blackOutScreen: boolean;
}

export type AppToUi =
  | { type: 'hello'; name: string; version: string; platform: string }
  | {
      type: 'device';
      code: string;
      name: string;
      online: boolean;
      allowRemote: boolean;
      verifyMode: VerifyMode;
      accessCode: string;
      /** Addresses a phone on the same network should dial. */
      lanAddresses: string[];
    }
  | { type: 'settings'; settings: AppSettingsDto }
  | { type: 'favorites'; favorites: { code: string; name: string }[] }
  | { type: 'display'; display: { width: number; height: number; fps: number } }
  | {
      type: 'incoming';
      sessionId: string;
      from: { name: string; code: string; os: string };
      passwordRequired: boolean;
    }
  | { type: 'session-state'; state: 'connecting' | 'waiting'; role: 'host' | 'controller'; message?: string }
  | {
      type: 'session-start';
      role: 'host' | 'controller';
      sas: string;
      peerName: string;
      peerCode: string;
      route: string;
      display?: { width: number; height: number; fps: number };
    }
  /** Decoder configuration for the incoming stream: RFC 6381 codec string plus the base64 codec-specific record (avcC for H.264, hvcC for H.265). */
  | { type: 'config'; codec: string; description: string }
  | { type: 'stats'; stats: SessionStatsDto }
  | { type: 'session-route'; route: 'p2p' | 'relay' }
  | { type: 'session-end'; reason: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; ts: number }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'log-bundle'; filename: string; text: string }
  | { type: 'secure-desktop'; active: boolean }
  | {
      type: 'displays';
      displays: { index: number; name: string; primary: boolean; width: number; height: number; refreshRate: number }[];
      active: number;
    };

export interface SessionStatsDto {
  fps: number;
  rttMs: number;
  oneWayMs: number;
  lossPct: number;
  targetBps: number;
  pacerRateBps?: number;
  sendBps: number;
  recvBps: number;
  recoveredFrames: number;
  droppedFrames: number;
  queueBytes: number;
}

export function encodeVideoPacket(opts: {
  frameId: number;
  key: boolean;
  captureTsUs: bigint;
  oneWayUs: number;
  payload: Buffer;
}): Buffer {
  const header = Buffer.allocUnsafe(VIDEO_HEADER_LEN);
  header.writeUInt8(1, 0);
  header.writeUInt8(opts.key ? 1 : 0, 1);
  header.writeUInt16BE(0, 2);
  header.writeUInt32BE(opts.frameId >>> 0, 4);
  header.writeBigUInt64BE(BigInt(opts.captureTsUs), 8);
  header.writeUInt32BE(Math.min(0xffff_ffff, Math.max(0, Math.round(opts.oneWayUs))), 16);
  return Buffer.concat([header, opts.payload]);
}

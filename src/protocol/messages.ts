import { PROTOCOL_VERSION } from './constants.ts';

/** Highest sequence number seen, plus interval loss counters. */
export interface ReceiverReport {
  /** Highest packet sequence received by the reporter. */
  hi: number;
  /** Packets lost during the reporting interval. */
  lost: number;
  /** Packets received during the reporting interval. */
  received: number;
  /** Inter-arrival delay gradient in µs; > 0 means a queue is building. */
  delayGradientUs: number;
  /** RFC3550-style jitter estimate in µs. */
  jitterUs: number;
  /** Reporter local monotonic time when the report was produced. */
  nowUs: number;
}

export interface NackEntry {
  channel: number;
  frameId: number;
  frags: number[];
}

export type ControlMessage =
  | {
      t: 'hello';
      v: typeof PROTOCOL_VERSION;
      sessionId: string;
      role: 'host' | 'controller';
      deviceId: string;
      eph: string;
      caps: string[];
      display?: { width: number; height: number; fps: number };
    }
  | {
      t: 'hello-ack';
      v: typeof PROTOCOL_VERSION;
      sessionId: string;
      role: 'host' | 'controller';
      deviceId: string;
      eph: string;
      sas: string;
    }
  | { t: 'report'; report: ReceiverReport }
  | { t: 'nack'; entries: NackEntry[] }
  | { t: 'idr' }
  | { t: 'bitrate'; bps: number }
  | { t: 'ping'; n: number; t1: number }
  | { t: 'pong'; n: number; t1: number; t2: number; t3: number }
  | { t: 'clipboard'; format: 'text' | 'html'; data: string }
  | { t: 'cursor'; visible: boolean; x: number; y: number }
  | { t: 'bye'; reason: string }
  | { t: 'notice'; level: 'info' | 'warn' | 'error'; message: string };

export type InputEvent =
  | { k: 'mm'; dx: number; dy: number }
  | { k: 'ma'; nx: number; ny: number }
  | { k: 'mb'; b: number; down: boolean }
  | { k: 'mw'; delta: number }
  | { k: 'kd'; scan: number; vk: number; repeat?: boolean }
  | { k: 'ku'; scan: number; vk: number }
  | { k: 'kr'; text: string }
  | { k: 'hello'; name: string };

export function encodeControl(m: ControlMessage): Buffer {
  return Buffer.from(JSON.stringify(m), 'utf8');
}

export function decodeControl(buf: Buffer): ControlMessage | null {
  try {
    const v = JSON.parse(buf.toString('utf8')) as ControlMessage;
    return typeof v === 'object' && v && typeof (v as { t?: unknown }).t === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function encodeInput(e: InputEvent): Buffer {
  return Buffer.from(JSON.stringify(e), 'utf8');
}

export function decodeInput(buf: Buffer): InputEvent | null {
  try {
    const v = JSON.parse(buf.toString('utf8')) as InputEvent;
    return typeof v === 'object' && v && typeof (v as { k?: unknown }).k === 'string' ? v : null;
  } catch {
    return null;
  }
}

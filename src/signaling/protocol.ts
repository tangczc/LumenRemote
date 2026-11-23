export interface EndpointInfo {
  address: string;
  port: number;
}

export type CandidateKind = 'host' | 'srflx' | 'relay';

export interface Candidate {
  kind: CandidateKind;
  address: string;
  port: number;
  /** Higher wins. */
  priority?: number;
}

export interface DeviceSummary {
  deviceId: string;
  code: string;
  name: string;
  os: string;
}

export type ClientToServer =
  | { t: 'hello'; deviceId?: string; preferredCode?: string; name: string; os: string; hostable?: boolean; token?: string }
  | { t: 'udp-token'; token: string; endpoint: EndpointInfo }
  | { t: 'connect'; sessionId: string; targetCode: string; password?: string; eph: string; candidates: Candidate[]; display?: { width: number; height: number; fps: number } }
  | { t: 'accept'; sessionId: string; eph: string; candidates: Candidate[]; password?: string }
  | { t: 'reject'; sessionId: string; reason: string }
  | { t: 'candidates'; sessionId: string; candidates: Candidate[] }
  | { t: 'bye'; sessionId: string; reason?: string }
  | { t: 'ping'; n: number };

export type ServerToClient =
  | { t: 'welcome'; deviceId: string; code: string; udpPort: number; name: string }
  | { t: 'incoming'; sessionId: string; from: DeviceSummary; passwordRequired: boolean; display?: { width: number; height: number; fps: number } }
  | {
      t: 'ready';
      sessionId: string;
      role: 'host' | 'controller';
      peer: DeviceSummary;
      peerEph: string;
      peerCandidates: Candidate[];
      relay: EndpointInfo;
      password?: string;
    }
  | { t: 'rejected'; sessionId: string; reason: string }
  | { t: 'peer-candidates'; sessionId: string; candidates: Candidate[] }
  | { t: 'bye'; sessionId: string; reason?: string }
  | { t: 'pong'; n: number }
  | { t: 'error'; message: string; fatal?: boolean };

export function encodeLine(msg: ClientToServer | ServerToClient): string {
  return `${JSON.stringify(msg)}\n`;
}

/** Splits a TCP stream into newline-delimited JSON messages. */
export class LineDecoder<T> {
  private buffer = '';

  constructor(
    private readonly onMessage: (msg: T) => void,
    private readonly maxLine = 1 << 20,
  ) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (this.buffer.length > this.maxLine) {
      this.buffer = '';
      return;
    }
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) {
        try {
          this.onMessage(JSON.parse(line) as T);
        } catch {
          /* ignore malformed line */
        }
      }
      idx = this.buffer.indexOf('\n');
    }
  }
}

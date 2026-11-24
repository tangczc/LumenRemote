import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : fallback;
}

/**
 * Secrets must never reach a log file that users are encouraged to share:
 * mask anything that looks like a credential assignment, plus long opaque
 * blobs (tokens, key material) wherever they appear.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(
      /(password|passwd|pwd|token|secret|access[-_ ]?code|验证码|口令)(\s*[:=：]\s*)[^\s,;，；]+/gi,
      '$1$2***',
    )
    .replace(/[A-Za-z0-9+/=_-]{48,}/g, (m) => `${m.slice(0, 8)}…`);
}

function safeMeta(meta: Record<string, unknown>): string {
  try {
    return redactSecrets(JSON.stringify(meta));
  } catch {
    return '"<unserializable meta>"';
  }
}

export interface AppLoggerOptions {
  /** Directory the log files live in (created recursively). */
  dir: string;
  /** File basename: `<name>.log`, rotations `<name>.1.log`, … */
  name: string;
  level?: LogLevel;
  /** Rotate the active file once it passes this size. Default 5 MB. */
  maxFileBytes?: number;
  /** Total files kept including the active one. Default 5 (≈25 MB worst case). */
  maxFiles?: number;
  /** Lines retained in memory for instant export. Default 2000. */
  ringSize?: number;
  /** Also mirror every line to stdout (the app already did this). */
  consoleEcho?: boolean;
  now?: () => Date;
}

export type BoundLogger = (
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
) => void;

/**
 * Structured, crash-safe application logger.
 *
 * Writes are synchronous appends: a remote-desktop process that dies mid-
 * session must leave its last words on disk, and log volume here is tiny
 * (events + a stats line every 10 s), so buffering would only add a way to
 * lose exactly the lines that matter. Every method swallows its own errors —
 * logging must never take the app down with it.
 */
export class AppLogger {
  readonly dir: string;
  readonly filePath: string;
  private readonly name: string;
  private level: LogLevel;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly ringSize: number;
  private readonly consoleEcho: boolean;
  private readonly nowFn: () => Date;
  private seq = 0;
  private size = 0;
  private readonly ring: string[] = [];
  private broken = false;

  constructor(opts: AppLoggerOptions) {
    this.dir = opts.dir;
    this.name = opts.name;
    this.level = opts.level ?? 'info';
    this.maxFileBytes = opts.maxFileBytes ?? 5 * 1024 * 1024;
    this.maxFiles = Math.max(1, opts.maxFiles ?? 5);
    this.ringSize = opts.ringSize ?? 2000;
    this.consoleEcho = opts.consoleEcho ?? false;
    this.nowFn = opts.now ?? (() => new Date());
    this.filePath = join(opts.dir, `${opts.name}.log`);
    try {
      mkdirSync(opts.dir, { recursive: true });
      this.size = statSync(this.filePath).size;
    } catch {
      this.size = 0;
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  get currentLevel(): LogLevel {
    return this.level;
  }

  log(level: LogLevel, module: string, message: string, meta?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const line =
      `${this.nowFn().toISOString()} [${level.toUpperCase().padEnd(5)}] ` +
      `[${module}] #${++this.seq} ${redactSecrets(message)}` +
      (meta ? ` ${safeMeta(meta)}` : '');
    this.ring.push(line);
    if (this.ring.length > this.ringSize) this.ring.shift();
    if (this.consoleEcho) console.log(line);
    if (this.broken) return;
    try {
      if (this.size > 0 && this.size + line.length + 1 > this.maxFileBytes) this.rotate();
      appendFileSync(this.filePath, `${line}\n`, 'utf8');
      this.size += line.length + 1;
    } catch {
      // A read-only disk or a deleted directory must not crash the app;
      // the in-memory ring still backs the export feature.
      this.broken = true;
    }
  }

  debug(module: string, message: string, meta?: Record<string, unknown>): void {
    this.log('debug', module, message, meta);
  }
  info(module: string, message: string, meta?: Record<string, unknown>): void {
    this.log('info', module, message, meta);
  }
  warn(module: string, message: string, meta?: Record<string, unknown>): void {
    this.log('warn', module, message, meta);
  }
  error(module: string, message: string, meta?: Record<string, unknown>): void {
    this.log('error', module, message, meta);
  }

  /** Logger bound to one module tag; matches the transport layer's Logger type. */
  child(module: string): BoundLogger {
    return (level, message, meta) => this.log(level, module, message, meta);
  }

  /** Last `count` formatted lines held in memory (oldest first). */
  recentText(count = this.ringSize): string {
    return this.ring.slice(-count).join('\n');
  }

  /**
   * Best available log tail for an export bundle: the on-disk file when it
   * can be read (it survives restarts), the memory ring otherwise.
   */
  exportText(maxChars = 512 * 1024): string {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      return raw.length > maxChars ? `…（前略）…\n${raw.slice(-maxChars)}` : raw.trimEnd();
    } catch {
      return this.recentText();
    }
  }

  private rotate(): void {
    try {
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = i === 1 ? this.filePath : join(this.dir, `${this.name}.${i - 1}.log`);
        const to = join(this.dir, `${this.name}.${i}.log`);
        try {
          renameSync(from, to);
        } catch {
          /* that generation does not exist yet */
        }
      }
      if (this.maxFiles === 1) unlinkSync(this.filePath);
    } catch {
      /* rotation is best effort; appending continues regardless */
    }
    this.size = 0;
  }
}

/**
 * Last-resort crash reporting. An uncaught exception is fatal (the process
 * is in an unknown state), so log it synchronously and exit; a stray
 * rejected promise is logged loudly but must not kill a live session.
 */
export function installCrashHandlers(logger: AppLogger, module = 'process'): void {
  process.on('uncaughtException', (err) => {
    const text = `未捕获异常: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
    logger.error(module, text);
    console.error(text);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(
      module,
      `未处理的 Promise 拒绝: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
  });
}

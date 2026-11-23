import http, { type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { attachWebSocketServer, type WsConnection } from '../net/ws.ts';
import { publicDir } from '../util/resources.ts';

const PUBLIC_DIR = publicDir();

/** Replaced with a per-launch token before `index.html` leaves the server. */
const TOKEN_PLACEHOLDER = '__LUMEN_UI_TOKEN__';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface UiServerOptions {
  port?: number;
  bind?: string;
  onConnection?: (ws: WsConnection) => void;
  onRequest?: (url: string) => void;
}

export interface UiServer {
  port: number;
  url: string;
  broadcastText: (text: string) => void;
  broadcastBinary: (data: Buffer) => void;
  close: () => void;
  readonly clients: number;
}

/** Serves the single-page UI and its WebSocket bridge. */
export async function startUiServer(opts: UiServerOptions = {}): Promise<UiServer> {
  const sockets = new Set<WsConnection>();
  // A fresh token per launch: the page can read it because it is served from the
  // same origin, while a page on any other origin cannot (and its Origin header
  // is rejected anyway).
  const uiToken = randomBytes(18).toString('base64url');
  let boundPort = opts.port ?? 0;

  const server: Server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    opts.onRequest?.(url);
    let path = url.split('?')[0] ?? '/';
    if (path === '/' || path === '') path = '/index.html';
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC_DIR, safe);
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    try {
      let data: Buffer | string = await readFile(file);
      if (type.startsWith('text/html')) data = data.toString('utf8').replaceAll(TOKEN_PLACEHOLDER, uiToken);
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'no-store',
        // The control UI must never be framed by another page.
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  });

  attachWebSocketServer(
    server,
    (ws) => {
      sockets.add(ws);
      ws.onClose(() => sockets.delete(ws));
      opts.onConnection?.(ws);
    },
    {
      token: () => uiToken,
      allowedHosts: () => [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`],
      allowedOrigins: () => [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`],
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.bind ?? '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  boundPort = port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    broadcastText: (text) => {
      for (const ws of sockets) if (ws.isOpen) ws.sendText(text);
    },
    broadcastBinary: (data) => {
      for (const ws of sockets) if (ws.isOpen) ws.sendBinary(data);
    },
    close: () => {
      for (const ws of sockets) ws.close();
      sockets.clear();
      server.close();
    },
    get clients() {
      return sockets.size;
    },
  };
}

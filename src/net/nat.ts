import dgram from 'node:dgram';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';

/**
 * Best-effort router port mapping (NAT-PMP / UPnP-IGD).
 *
 * Hole punching fails outright when *both* peers sit behind symmetric NAT, and
 * that is exactly the case a home router can fix: ask it to forward a port and
 * the peer gets a plain, dialable public endpoint. This is the highest-leverage
 * P2P improvement after IPv6, and it needs no server-side change.
 *
 * Everything here is optional: a router that ignores us simply returns null and
 * the caller falls back to hole punching.
 */

export interface PortMapping {
  /** Protocol that was mapped. */
  protocol: 'udp';
  externalPort: number;
  internalPort: number;
  /** Local address the router forwards to. */
  internalAddress: string;
  /** Public address, when the router reports one. */
  externalAddress: string | null;
  /** How the mapping was created. */
  via: 'natpmp' | 'upnp';
  /** Called to drop the mapping. */
  release: () => Promise<void>;
  /** Lifetime the router granted, in seconds (0 = until released). */
  lifetimeSec: number;
}

const NATPMP_PORT = 5351;
const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

function firstLanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return null;
}

/** Default gateway is not exposed by Node; ask the OS once. */
async function defaultGateway(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { execFile } = await import('node:child_process');
    const out = await new Promise<string>((resolve) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop",
        ],
        { timeout: 4000, windowsHide: true },
        (err, stdout) => resolve(err ? '' : stdout.trim()),
      );
    });
    return /^\d+\.\d+\.\d+\.\d+$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ NAT-PMP

/**
 * RFC 6886. One request/response pair, no XML parsing, so it is tried first.
 */
export async function tryNatPmp(internalPort: number, lifetimeSec = 7200): Promise<PortMapping | null> {
  const gateway = await defaultGateway();
  if (!gateway) return null;

  const request = Buffer.alloc(12);
  request.writeUInt8(0, 0); // version 0
  request.writeUInt8(1, 1); // opcode 1 = UDP
  request.writeUInt16BE(0, 2); // reserved
  request.writeUInt16BE(internalPort, 4); // suggested external port
  request.writeUInt16BE(internalPort, 6); // internal port
  request.writeUInt32BE(lifetimeSec, 8);

  const reply = await new Promise<Buffer | null>((resolve) => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, 1200);
    socket.on('message', (msg) => {
      clearTimeout(timer);
      socket.close();
      resolve(msg);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    socket.send(request, NATPMP_PORT, gateway);
  });
  if (!reply || reply.length < 16) return null;

  const resultCode = reply.readUInt16BE(2);
  if (resultCode !== 0) return null; // 1 = unsupported, 2 = not authorized, ...

  const externalPort = reply.readUInt16BE(10);
  const grantedLifetime = reply.readUInt32BE(12) & 0x7fffffff;
  const externalAddress = reply.length >= 16 ? Array.from(reply.subarray(8, 12)).join('.') : null;
  const internalAddress = firstLanAddress();
  if (!externalPort || !internalAddress) return null;

  return {
    protocol: 'udp',
    externalPort,
    internalPort,
    internalAddress,
    externalAddress: externalAddress === '0.0.0.0' ? null : externalAddress,
    via: 'natpmp',
    lifetimeSec: grantedLifetime,
    release: async () => {
      const drop = Buffer.alloc(12);
      drop.writeUInt8(0, 0);
      drop.writeUInt8(2, 1); // opcode 2 = delete mapping
      drop.writeUInt16BE(0, 2);
      drop.writeUInt16BE(externalPort, 4);
      drop.writeUInt16BE(internalPort, 6);
      drop.writeUInt32BE(0, 8);
      const socket = dgram.createSocket('udp4');
      socket.send(drop, NATPMP_PORT, gateway, () => setTimeout(() => socket.close(), 100));
    },
  };
}

// --------------------------------------------------------------------- UPnP

interface UpnpService {
  controlUrl: string;
  serviceType: string;
}

/** Reads the IGD description and pulls out WAN connection services. */
async function discoverUpnpServices(timeoutMs: number): Promise<{ base: string; services: UpnpService[] } | null> {
  const search = [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    'MX: 2',
    'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
    '',
    '',
  ].join('\r\n');

  const locations = new Set<string>();
  await new Promise<void>((resolve) => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      socket.close();
      resolve();
    }, timeoutMs);
    socket.on('message', (msg) => {
      const text = msg.toString('utf8');
      const match = /^location:\s*(.+)$/im.exec(text);
      if (match) locations.add(match[1]!.trim());
    });
    socket.on('error', () => {
      clearTimeout(timer);
      socket.close();
      resolve();
    });
    socket.bind(0, () => {
      try {
        socket.send(search, SSDP_PORT, SSDP_ADDRESS);
      } catch {
        clearTimeout(timer);
        socket.close();
        resolve();
      }
    });
  });
  if (locations.size === 0) return null;

  for (const location of locations) {
    try {
      const xml = await fetchText(location, 2500);
      if (!xml) continue;
      const baseMatch = /<URLBase>([^<]+)<\/URLBase>/i.exec(xml);
      const origin = baseMatch ? baseMatch[1]!.trim() : new URL(location).origin;
      const services: UpnpService[] = [];

      // IGD nests everything under a root device; walking every <service> block
      // is simpler than modelling that hierarchy and finds the WAN connection.
      const blocks = xml.split(/<service>/i).slice(1);
      for (const block of blocks) {
        const type = /<serviceType>([^<]+)<\/serviceType>/i.exec(block)?.[1]?.trim();
        const control = /<controlURL>([^<]+)<\/controlURL>/i.exec(block)?.[1]?.trim();
        if (!type || !control) continue;
        if (!/WAN(IP|PPP)Connection/i.test(type)) continue;
        services.push({ serviceType: type, controlUrl: new URL(control, origin).toString() });
      }
      if (services.length > 0) return { base: origin, services };
    } catch {
      /* try the next location */
    }
  }
  return null;
}

function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 512 * 1024) req.destroy();
      });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

function soapEnvelope(serviceType: string, action: string, body: string): string {
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="${serviceType}">${body}</u:${action}></s:Body>
</s:Envelope>`;
}

async function soapCall(controlUrl: string, serviceType: string, action: string, body: string): Promise<string | null> {
  const envelope = soapEnvelope(serviceType, action, body);
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(controlUrl);
    } catch {
      resolve(null);
      return;
    }
    const req = request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'POST',
        timeout: 3000,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: `"${serviceType}#${action}"`,
          'Content-Length': Buffer.byteLength(envelope),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve(res.statusCode && res.statusCode < 400 ? text : null));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.write(envelope);
    req.end();
  });
}

export async function tryUpnp(internalPort: number, lifetimeSec = 7200): Promise<PortMapping | null> {
  const found = await discoverUpnpServices(1800);
  const internalAddress = firstLanAddress();
  if (!found || !internalAddress) return null;

  for (const service of found.services) {
    const addBody = [
      `<NewRemoteHost></NewRemoteHost>`,
      `<NewExternalPort>${internalPort}</NewExternalPort>`,
      `<NewProtocol>UDP</NewProtocol>`,
      `<NewInternalPort>${internalPort}</NewInternalPort>`,
      `<NewInternalClient>${internalAddress}</NewInternalClient>`,
      `<NewEnabled>1</NewEnabled>`,
      `<NewPortMappingDescription>Lumen Remote</NewPortMappingDescription>`,
      `<NewLeaseDuration>${lifetimeSec}</NewLeaseDuration>`,
    ].join('');
    const added = await soapCall(service.controlUrl, service.serviceType, 'AddPortMapping', addBody);
    if (!added) continue;

    let externalAddress: string | null = null;
    const info = await soapCall(service.controlUrl, service.serviceType, 'GetExternalIPAddress', '');
    if (info) {
      const match = /<NewExternalIPAddress>([^<]*)<\/NewExternalIPAddress>/i.exec(info);
      const value = match?.[1]?.trim();
      if (value && value !== '0.0.0.0') externalAddress = value;
    }

    return {
      protocol: 'udp',
      externalPort: internalPort,
      internalPort,
      internalAddress,
      externalAddress,
      via: 'upnp',
      lifetimeSec,
      release: async () => {
        const dropBody = [
          `<NewRemoteHost></NewRemoteHost>`,
          `<NewExternalPort>${internalPort}</NewExternalPort>`,
          `<NewProtocol>UDP</NewProtocol>`,
        ].join('');
        await soapCall(service.controlUrl, service.serviceType, 'DeletePortMapping', dropBody);
      },
    };
  }
  return null;
}

/**
 * Try NAT-PMP then UPnP. Returns null when the router offers neither, which is
 * the normal case on carrier-grade NAT and on networks that block multicast.
 */
export async function requestPortMapping(internalPort: number): Promise<PortMapping | null> {
  const natpmp = await tryNatPmp(internalPort).catch(() => null);
  if (natpmp) return natpmp;
  return tryUpnp(internalPort).catch(() => null);
}


import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { SignalingServer } from './server.ts';
import { AppLogger, installCrashHandlers, parseLogLevel } from '../util/log.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '7801' },
    udp: { type: 'string', default: '7802' },
    bind: { type: 'string', default: '0.0.0.0' },
    public: { type: 'string', default: '' },
    'log-level': { type: 'string', default: '' },
    'log-dir': { type: 'string', default: '' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`
Signaling + NAT helper service

  --port <port>    TCP signaling port (default 7801)
  --udp <port>     UDP discovery / relay port (default 7802)
  --bind <addr>    bind address (default 0.0.0.0)
  --public <addr>  address peers should use for the relay; set it when the machine
                   only has a private address on its NIC (cloud 1:1 NAT). Default:
                   the address each peer used to reach this server.
  --log-level <lvl>  debug|info|warn|error (default info; env RD_LOG_LEVEL)
  --log-dir <path>   log directory (default ./logs; env RD_LOG_DIR)
`);
  process.exit(0);
}

const logger = new AppLogger({
  dir: values['log-dir'] || process.env.RD_LOG_DIR || join(process.cwd(), 'logs'),
  name: 'signaling',
  level: parseLogLevel(values['log-level'] || process.env.RD_LOG_LEVEL),
  consoleEcho: true,
});
installCrashHandlers(logger);
const log = (level: 'info' | 'warn' | 'error', message: string): void =>
  logger.log(level, 'signaling', message);

const server = new SignalingServer({
  tcpPort: Number(values.port),
  udpPort: Number(values.udp),
  bindAddress: values.bind,
  publicAddress: values.public,
  log,
});

const ports = await server.listen();
log('info', `signaling listening · 日志 ${logger.filePath} · 级别 ${logger.currentLevel}`);
log('info', `  tcp ${values.bind}:${ports.tcpPort}`);
log('info', `  udp ${values.bind}:${ports.udpPort} (discovery + relay)`);
log('info', `  relay ${values.public || 'auto（使用客户端连入的地址，云主机建议显式传 --public）'}`);

// systemd sends SIGTERM; close the sockets so peers see a clean disconnect
// instead of waiting for a TCP timeout.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}

import { parseArgs } from 'node:util';
import { SignalingServer } from './server.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '7801' },
    udp: { type: 'string', default: '7802' },
    bind: { type: 'string', default: '0.0.0.0' },
    public: { type: 'string', default: '' },
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
`);
  process.exit(0);
}

const stamp = () => new Date().toISOString().slice(11, 23);

const server = new SignalingServer({
  tcpPort: Number(values.port),
  udpPort: Number(values.udp),
  bindAddress: values.bind,
  publicAddress: values.public,
  log: (level, message) => console.log(`${stamp()} [${level}] ${message}`),
});

const ports = await server.listen();
console.log(`${stamp()} [info] signaling listening`);
console.log(`${stamp()} [info]   tcp ${values.bind}:${ports.tcpPort}`);
console.log(`${stamp()} [info]   udp ${values.bind}:${ports.udpPort} (discovery + relay)`);
console.log(
  `${stamp()} [info]   relay ${values.public || 'auto（使用客户端连入的地址，云主机建议显式传 --public）'}`,
);

// systemd sends SIGTERM; close the sockets so peers see a clean disconnect
// instead of waiting for a TCP timeout.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}

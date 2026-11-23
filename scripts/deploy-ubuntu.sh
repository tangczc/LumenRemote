#!/usr/bin/env bash
#
# Lumen Remote —— 信令服务一键部署（Ubuntu 24.04）
#
# 在一台全新、什么都没装的 Ubuntu 24.04 上跑这一条就行：
#
#   scp signaling-main.mjs deploy-ubuntu.sh root@<你的服务器>:/root/
#   ssh root@<你的服务器> 'bash /root/deploy-ubuntu.sh'
#
# 脚本会：装 Node.js → 建专用系统用户 → 装成 systemd 服务（开机自启、崩溃自拉）
#          → 放开 7801/tcp 与 7802/udp → 打印客户端该填什么。
#
# 重复执行是安全的：会替换程序并重启服务，不会重复建用户、不会改端口。
#
#   bash deploy-ubuntu.sh                    # 默认 7801/tcp + 7802/udp
#   bash deploy-ubuntu.sh --port 9001        # UDP 自动用 9002
#   bash deploy-ubuntu.sh --udp 9102         # 也可以单独指定 UDP
#   bash deploy-ubuntu.sh --public 1.2.3.4   # 手动指定中继地址（默认自动探测公网 IP）
#   bash deploy-ubuntu.sh --uninstall        # 卸载
#
# 需要两个文件在同一个目录：signaling-main.mjs（由 npm run build:engine 生成）
# 和本脚本。也可以在仓库里直接跑，脚本会自己去 build/ 找。

set -euo pipefail

# Windows 上传的文件可能带 CRLF，bash 会因为 "\r" 报奇怪的错，先自愈一次。
if [ "${_LUMEN_CRLF_FIXED:-0}" != "1" ] && grep -q $'\r' "$0" 2>/dev/null; then
  sed -i 's/\r$//' "$0"
  _LUMEN_CRLF_FIXED=1 exec bash "$0" "$@"
fi

SERVICE="lumen-signal"
INSTALL_DIR="/opt/lumen-signal"
RUN_USER="lumen"
NODE_VERSION="24.22.3"      # 覆盖：--node 22.14.0
# 默认版本的官方 SHA-256（取自 nodejs.org/dist/v<NODE_VERSION>/SHASUMS256.txt）。
# 装了别的版本时脚本会去官方清单核对，不依赖下面这两行。
NODE_SHA256_X64="4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb"
NODE_SHA256_ARM64="6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c"
PORT="7801"
UDP_PORT=""
BUNDLE=""
PUBLIC_ADDR=""
UNINSTALL="0"

die()  { printf '\033[31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m[信息]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[完成]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[注意]\033[0m %s\n' "$*"; }

usage() {
  sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)      PORT="${2:?--port 需要一个端口}"; shift 2 ;;
    --udp)       UDP_PORT="${2:?--udp 需要一个端口}"; shift 2 ;;
    --dir)       INSTALL_DIR="${2:?}"; shift 2 ;;
    --user)      RUN_USER="${2:?}"; shift 2 ;;
    --node)      NODE_VERSION="${2:?}"; shift 2 ;;
    --bundle)    BUNDLE="${2:?}"; shift 2 ;;
    --public)    PUBLIC_ADDR="${2:?--public 需要一个地址}"; shift 2 ;;
    --uninstall) UNINSTALL="1"; shift ;;
    -h|--help)   usage ;;
    *)           die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

case "$PORT" in ''|*[!0-9]*) die "TCP 端口必须是数字" ;; esac
[ -n "$UDP_PORT" ] || UDP_PORT=$((10#$PORT + 1))
case "$UDP_PORT" in ''|*[!0-9]*) die "UDP 端口必须是数字" ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "TCP 端口超出范围"
[ "$UDP_PORT" -ge 1 ] && [ "$UDP_PORT" -le 65535 ] || die "UDP 端口超出范围"
[ "$PORT" != "$UDP_PORT" ] || die "TCP 与 UDP 端口不能相同"

[ "$(id -u)" = "0" ] || die "请用 root 运行：sudo bash $0"

# ---------------------------------------------------------------- 卸载

if [ "$UNINSTALL" = "1" ]; then
  info "停止并移除服务 $SERVICE"
  systemctl stop "$SERVICE" 2>/dev/null || true
  systemctl disable "$SERVICE" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload || true
  rm -rf "$INSTALL_DIR"
  rm -f /etc/sysctl.d/99-lumen-signal.conf
  if id -u "$RUN_USER" >/dev/null 2>&1; then
    userdel "$RUN_USER" 2>/dev/null || true
  fi
  ok "已卸载（Node.js 保留，没删）"
  exit 0
fi

# ---------------------------------------------------------------- 体检

if [ -r /etc/os-release ]; then
  # shellcheck source=/dev/null
  . /etc/os-release
  case "${ID:-}${VERSION_ID:-}" in
    ubuntu24*|debian12*|debian13*) : ;;
    *) warn "这套脚本按 Ubuntu 24.04 写的，当前是 ${PRETTY_NAME:-未知系统}，继续但可能失败" ;;
  esac
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  NODE_ARCH="linux-x64" ;;
  aarch64|arm64) NODE_ARCH="linux-arm64" ;;
  *) die "不支持的架构：$ARCH" ;;
esac

# ---------------------------------------------------------------- 找程序文件

find_bundle() {
  for candidate in \
    "$BUNDLE" \
    "./signaling-main.mjs" \
    "$(dirname "$0")/signaling-main.mjs" \
    "$(dirname "$0")/../build/signaling-main.mjs" \
    "$(dirname "$0")/build/signaling-main.mjs"
  do
    [ -n "$candidate" ] && [ -f "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

BUNDLE="$(find_bundle)" || die "找不到 signaling-main.mjs。
请把它和本脚本放在同一目录再运行：
  scp signaling-main.mjs deploy-ubuntu.sh root@<服务器>:/root/
（本机可以用 npm run build:engine 生成，产物在 build/signaling-main.mjs）"

info "程序文件：$BUNDLE ($(wc -c <"$BUNDLE") 字节)"

# ---------------------------------------------------------------- 装依赖

export DEBIAN_FRONTEND=noninteractive
info "安装基础依赖（curl / xz / ca-certificates）"
apt-get update -qq
apt-get install -y -qq --no-install-recommends curl ca-certificates xz-utils >/dev/null

# ---------------------------------------------------------------- 装 Node

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 20 ]
}

if node_ok; then
  NODE_BIN="$(command -v node)"
  ok "已有 Node.js $(node -v)，跳过安装"
else
  info "安装 Node.js v$NODE_VERSION（$NODE_ARCH）"
  TARBALL="node-v${NODE_VERSION}-${NODE_ARCH}.tar.xz"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  # 国内机器走 npmmirror 通常快得多，失败再回落到官方源。
  DOWNLOADED="0"
  for base in \
    "https://npmmirror.com/mirrors/node/v${NODE_VERSION}" \
    "https://nodejs.org/dist/v${NODE_VERSION}"
  do
    info "下载 $base/$TARBALL"
    if curl -fsSL --retry 2 --connect-timeout 10 -o "$TMP/$TARBALL" "$base/$TARBALL"; then
      DOWNLOADED="1"
      break
    fi
    warn "这个源不通，换下一个"
  done
  [ "$DOWNLOADED" = "1" ] || die "Node.js 下载失败，请检查服务器出网"

  # 校验压缩包，否则一个被投毒的镜像就能在 root 身份下执行任意代码。
  if [ "$NODE_VERSION" = "24.22.3" ]; then
    case "$NODE_ARCH" in
      linux-x64)   EXPECTED_SHA="$NODE_SHA256_X64" ;;
      linux-arm64) EXPECTED_SHA="$NODE_SHA256_ARM64" ;;
      *)           EXPECTED_SHA="" ;;
    esac
  else
    EXPECTED_SHA=""
  fi
  if [ -z "$EXPECTED_SHA" ]; then
    info "从官方清单核对 SHA-256"
    SUMS="$(curl -fsSL --retry 2 --connect-timeout 10 \
      "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" 2>/dev/null \
      | awk -v f="$TARBALL" '$2 == f { print $1 }')"
    [ -n "$SUMS" ] || die "取不到 $TARBALL 的官方 SHA-256，拒绝安装未校验的 Node.js"
    EXPECTED_SHA="$SUMS"
  fi
  ACTUAL_SHA="$(sha256sum "$TMP/$TARBALL" | awk '{ print $1 }')"
  [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] \
    || die "Node.js 校验失败（期望 $EXPECTED_SHA，实际 $ACTUAL_SHA），已中止"
  ok "Node.js 安装包校验通过"

  tar -xJf "$TMP/$TARBALL" -C /opt
  rm -rf /opt/node
  mv "/opt/node-v${NODE_VERSION}-${NODE_ARCH}" /opt/node
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm  /usr/local/bin/npm
  ln -sf /opt/node/bin/npx  /usr/local/bin/npx
  # 直接用绝对路径，避免系统自带的旧 node 仍排在 PATH 前面
  NODE_BIN="/opt/node/bin/node"
  "$NODE_BIN" -v >/dev/null 2>&1 || die "Node.js 安装后仍不可用"
  ok "Node.js 已安装：$("$NODE_BIN" -v)"
fi

# ---------------------------------------------------------------- 建用户 / 目录

if id -u "$RUN_USER" >/dev/null 2>&1; then
  info "用户 $RUN_USER 已存在，复用"
else
  info "创建系统用户 $RUN_USER"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
fi

install -d -m 0755 "$INSTALL_DIR"
install -m 0644 "$BUNDLE" "$INSTALL_DIR/signaling-main.mjs"
chown -R root:root "$INSTALL_DIR"
ok "程序已安装到 $INSTALL_DIR"

# ---------------------------------------------------------------- 内核参数

# 服务端会把 UDP 接收缓冲调到 4 MB，但内核默认上限通常只有 208 KB，
# 不放开的话大流量中继期间会丢包。
info "调整 UDP 缓冲上限"
cat >/etc/sysctl.d/99-lumen-signal.conf <<'EOF'
# Lumen Remote signaling / relay
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.netdev_max_backlog = 5000
EOF
sysctl -q --system || warn "sysctl 应用失败（不影响信令，可能影响中继吞吐）"

# ------------------------------------------------------------ 公网地址（中继）

# 打洞失败时两端要把媒体发到这个地址的中继端口上，所以它必须是**公网**地址。
# 云主机的网卡上通常只有内网地址（公网 IP 是 1:1 NAT），直接用网卡地址会把中继
# 指到一台不可达的主机上——对端会一直等到超时（"连接超时（对方已离线）"）。
is_private_ip() {
  case "$1" in
    10.*|192.168.*|127.*|169.254.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
    100.6[4-9].*|100.[7-9][0-9].*|100.1[0-1][0-9].*|100.12[0-7].*) return 0 ;;
  esac
  return 1
}

detect_public_ip() {
  for url in https://api.ipify.org https://ip.3322.net https://ifconfig.me/ip \
             https://myip.ipip.net https://ipinfo.io/ip; do
    candidate="$(curl -fsS --max-time 4 "$url" 2>/dev/null | tr -d '[:space:]' \
      | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -n1 || true)"
    if [ -n "$candidate" ] && ! is_private_ip "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

if [ -z "$PUBLIC_ADDR" ]; then
  PUBLIC_ADDR="$(detect_public_ip || true)"
fi
PUBLIC_ARG=""
if [ -n "$PUBLIC_ADDR" ]; then
  if is_private_ip "$PUBLIC_ADDR"; then
    warn "--public $PUBLIC_ADDR 是内网地址，客户端连不上这个中继；请改成公网 IP"
    PUBLIC_ADDR=""
  fi
fi
if [ -n "$PUBLIC_ADDR" ]; then
  PUBLIC_ARG="--public $PUBLIC_ADDR"
  info "中继地址：$PUBLIC_ADDR（可用 --public 覆盖）"
else
  warn "探测不到公网 IP：请用 --public <公网IP> 重跑一次，否则打洞失败的连接会一直超时"
fi

# ---------------------------------------------------------------- systemd

info "写入 systemd 服务"
cat >"/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Lumen Remote signaling + NAT helper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/signaling-main.mjs --bind 0.0.0.0 --port $PORT --udp $UDP_PORT $PUBLIC_ARG
Restart=always
RestartSec=2
LimitNOFILE=65535

# 这个服务只碰网络，不需要写系统任何位置
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
# os.networkInterfaces() 走 netlink，Node 的解析器偶尔用 unix socket，都要放行
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"

info "等待服务启动…"
STARTED="0"
for _ in $(seq 1 20); do
  sleep 0.5
  if systemctl is-active --quiet "$SERVICE"; then STARTED="1"; break; fi
done

if [ "$STARTED" != "1" ]; then
  warn "服务没有起来，最近日志："
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  die "部署失败"
fi

# 端口真的在监听才算数
sleep 0.5
if command -v ss >/dev/null 2>&1; then
  ss -lntu 2>/dev/null | grep -qE "[:.]${PORT}([^0-9]|$)" || warn "没看到 TCP $PORT 在监听，请检查日志"
  ss -lntu 2>/dev/null | grep -qE "[:.]${UDP_PORT}([^0-9]|$)" || warn "没看到 UDP $UDP_PORT 在监听，请检查日志"
fi
ok "服务已运行：$SERVICE"

# ---------------------------------------------------------------- 防火墙

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  info "ufw 处于启用状态，放行端口"
  ufw allow "$PORT/tcp"  >/dev/null 2>&1 || true
  ufw allow "$UDP_PORT/udp" >/dev/null 2>&1 || true
  ok "已放行 $PORT/tcp 与 $UDP_PORT/udp"
else
  warn "未检测到启用中的 ufw；如果用了 firewalld，请手动放行：
    firewall-cmd --permanent --add-port=$PORT/tcp --add-port=$UDP_PORT/udp && firewall-cmd --reload"
fi

# ---------------------------------------------------------------- 收尾信息

PUBLIC_IP="${PUBLIC_ADDR:-}"
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
fi
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="<你的公网IP>"

cat <<EOF

────────────────────────────────────────────────────────────
 Lumen Remote 信令服务已就绪
────────────────────────────────────────────────────────────
 公网地址   $PUBLIC_IP
 信令端口   $PORT/tcp      （TCP JSON，一次会话约 1.5 KB）
 UDP 端口   $UDP_PORT/udp   只做两件事：
              ① 建链时测自己的公网映射（1 字节探测 + 约 80 字节回复）
              ② 打洞失败时的中继兜底
            P2P 打洞成功时，这个端口上没有任何媒体流量
 服务名     $SERVICE       （systemctl status $SERVICE）
 日志       journalctl -u $SERVICE -f

 ⚠ 云厂商「安全组 / 防火墙」里还要放行这两个端口，这一步脚本改不了：
     TCP $PORT   入站
     UDP $UDP_PORT   入站   ← 只开 TCP 会拿不到公网映射，
                            打洞成功率暴跌，而中继也走这个端口，等于没有退路

 客户端这样填：
   Windows  设置 → 信令服务器 = $PUBLIC_IP  端口 $PORT
            或命令行：--signal $PUBLIC_IP --port $PORT --no-signal-host
   Android  信令服务器 = $PUBLIC_IP（不能填 192.168.x，自动发现只对局域网有效）
   两端必须连同一个信令服务，9 位识别码才互相对应。

 验证：
   ss -lntu | grep -E ':$PORT|:$UDP_PORT'
   journalctl -u $SERVICE -n 50
────────────────────────────────────────────────────────────
EOF

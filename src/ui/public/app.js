/* Lumen Remote — application UI.
   One page: this device's ID on the left, connect-to-partner on the right,
   plus a full-screen stage when a session is live. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  ws: null,
  device: { code: '', name: '', online: false, allowRemote: true, verifyMode: 'once', accessCode: '', lanAddresses: [] },
  codeRevealed: false,
  settings: {
    quality: 'balanced',
    verifyMode: 'once',
    longPassword: '',
    accessCode: '',
    allowRemote: true,
    signalHost: '127.0.0.1',
    signalPort: 7801,
  },
  favorites: [],
  session: null,
  sessionId: null,
  stats: null,
  lastOneWayMs: null,
  decoder: null,
  configuredKey: '',
  decodedFrames: 0,
  page: 'assist',
};

/* ------------------------------------------------------------------ utils */

function toast(message, kind = 'info', ttl = 4000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  }, ttl);
}

function fmtRate(bps) {
  if (!bps || bps < 1000) return '—';
  const mbps = bps / 1_000_000;
  return mbps >= 1 ? `${mbps.toFixed(1)} Mbps` : `${Math.round(bps / 1000)} kbps`;
}

function fmtMs(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
}

/* Browser-side log lines, retained for the 导出日志 bundle: the engine log
 * alone cannot show decoder errors or WebCodecs complaints. */
const clientLogLines = [];
function rememberLog(level, message) {
  const stamp = new Date().toISOString();
  clientLogLines.push(`${stamp} [${level}] ${message}`);
  if (clientLogLines.length > 1000) clientLogLines.shift();
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function logLine(level, message) {
  rememberLog(level, message);
  const host = $('#logList');
  if (!host) return;
  const row = document.createElement('div');
  row.className = `log-line ${level}`;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const m = document.createElement('span');
  m.className = 'm';
  m.textContent = message;
  row.append(t, m);
  host.appendChild(row);
  while (host.childElementCount > 300) host.firstElementChild.remove();
  host.scrollTop = host.scrollHeight;
}

function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function formatCode(code) {
  const d = digits(code);
  if (d.length !== 9) return code || '--- --- ---';
  return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

/** `415563885` -> `415 563 885`; digits past the ninth are dropped. */
function groupIdDigits(value) {
  const d = digits(value).slice(0, 9);
  return d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3, 6)}${d.length > 6 ? ` ${d.slice(6)}` : ''}` : d;
}

/** Index just past the n-th digit, so the caret survives reformatting. */
function caretAfterDigits(text, n) {
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\d/.test(text[i]) && ++seen === n) return i + 1;
  }
  return text.length;
}

/**
 * Keeps a device-ID field grouped in threes while typing. The separator is
 * cosmetic: callers still read the value through `digits()`.
 */
function attachGroupedId(input) {
  const apply = (raw, digitsBeforeCaret) => {
    input.value = groupIdDigits(raw);
    const pos = caretAfterDigits(input.value, digitsBeforeCaret);
    input.setSelectionRange(pos, pos);
  };

  input.addEventListener('input', () => {
    const caret = input.selectionStart ?? input.value.length;
    apply(input.value, digits(input.value.slice(0, caret)).length);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Backspace') return;
    const { selectionStart: start, selectionEnd: end, value } = input;
    if (start !== end || start === 0) return;
    // The caret usually sits right after a separator; consuming only the space
    // would make the key look dead, so take the digit in front of it as well.
    if (value[start - 1] !== ' ') return;
    event.preventDefault();
    const head = value.slice(0, start - 2);
    apply(head + value.slice(start), digits(head).length);
  });
}

/* --------------------------------------------------------------- transport */

/** Consecutive failed upgrades; a stale token can never succeed, so reload once. */
let socketFailures = 0;

function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // The server injects a per-launch token into this page; the upgrade is
  // rejected without it, which is what keeps other sites off the control socket.
  const token = document.querySelector('meta[name="lumen-ui-token"]')?.content ?? '';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.addEventListener('open', () => {
    socketFailures = 0;
    // A fresh connection means the token was current; allow the next engine
    // restart to trigger one automatic reload again.
    sessionStorage.removeItem('lumen-reloaded');
    setConnState('connecting', '连接本机服务…');
    reportClientDisplay();
  });
  ws.addEventListener('close', () => {
    setConnState('offline', '界面连接中断，正在重试');
    // The engine regenerates its token on every launch, so a page that outlived
    // a restart can retry forever. Reloading picks up the new one.
    socketFailures += 1;
    if (socketFailures >= 3 && !sessionStorage.getItem('lumen-reloaded')) {
      sessionStorage.setItem('lumen-reloaded', '1');
      location.reload();
      return;
    }
    setTimeout(connectSocket, 1200);
  });
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') {
      try {
        handleServer(JSON.parse(ev.data));
      } catch {
        /* ignore malformed */
      }
    } else {
      handleVideo(ev.data);
    }
  });
}

function send(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

/**
 * Tell the engine how big the *video area* is, because the host encodes for the
 * controller's viewport. It used to report the whole screen in device pixels, so a
 * 1200x700 window on a 4K display asked the host to encode 3840x2160 -- five times
 * the pixels for a picture that then had to be scaled back down, which is what made
 * relay sessions unusable.
 */
let lastClientDisplay = '';
let clientDisplayTimer = 0;

function reportClientDisplay() {
  const stage = $('#stage');
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  if (rect.width < 160 || rect.height < 120) return; // not laid out yet
  // Report CSS pixels, not device pixels. Multiplying by devicePixelRatio made
  // a 1920-wide window on a 200%-scaled display ask the host to encode 3840
  // wide: double the pixels for a picture the browser then scales back down,
  // which saturated software encoders and made every session feel laggy.
  // The browser upscales the decoded frame to the display anyway, so CSS
  // pixels are the honest budget.
  // Round to even numbers: the encoder likes chroma-aligned sizes and this also
  // keeps a one-pixel wobble from re-negotiating the stream.
  const width = Math.round(rect.width / 2) * 2;
  const height = Math.round(rect.height / 2) * 2;
  const key = `${width}x${height}`;
  if (key === lastClientDisplay) return;
  lastClientDisplay = key;
  send({ type: 'client-display', width, height });
}

function scheduleClientDisplay() {
  if (clientDisplayTimer) return;
  clientDisplayTimer = requestAnimationFrame(() => {
    clientDisplayTimer = 0;
    reportClientDisplay();
  });
}

window.addEventListener('resize', scheduleClientDisplay);

/* ---------------------------------------------------------------- fullscreen */

/**
 * Session fullscreen, F11-style. One code path for the toolbar button, the
 * F11 key and the desktop shell (whose default menu used to swallow F11
 * and toggle the *window*, leaving this page's fullscreen CSS and the
 * hidden toolbar out of sync). Esc exits natively in browsers; the
 * desktop shell gets an explicit handler below.
 */
function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.()?.catch?.(() => {});
    } else {
      const p = $('#sessionLayer')?.requestFullscreen?.({ navigationUI: 'hide' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch {
    /* fullscreen needs a user gesture; the click/keypress is one, but a
       programmatic re-entry after session start is not — ignore. */
  }
}

let toolbarPeekTimer = 0;
function syncFullscreenChrome() {
  const fs = Boolean(document.fullscreenElement);
  document.body.classList.toggle('is-fullscreen', fs);
  const btn = $('#btnFullscreen');
  if (btn) btn.title = fs ? '退出全屏（F11 / Esc）' : '全屏（F11）';
  $('.session-top')?.classList.remove('peek');
  if (toolbarPeekTimer) {
    clearTimeout(toolbarPeekTimer);
    toolbarPeekTimer = 0;
  }
  if (fs) $('#stage')?.focus();
}
document.addEventListener('fullscreenchange', syncFullscreenChrome);

/** In fullscreen the toolbar hides; brushing the top edge brings it back. */
function pokeToolbar(ev) {
  if (!document.fullscreenElement) return;
  const top = $('.session-top');
  if (!top) return;
  const nearTop = ev.clientY <= 44 || ev.target instanceof Node && top.contains(ev.target);
  if (!nearTop) return;
  top.classList.add('peek');
  if (toolbarPeekTimer) clearTimeout(toolbarPeekTimer);
  toolbarPeekTimer = setTimeout(() => top.classList.remove('peek'), 2400);
}
window.addEventListener('orientationchange', scheduleClientDisplay);
document.addEventListener('fullscreenchange', scheduleClientDisplay);
if (typeof ResizeObserver !== 'undefined') {
  const stage = $('#stage');
  if (stage) new ResizeObserver(scheduleClientDisplay).observe(stage);
}

function setConnState(kind, text) {
  const el = $('#connState');
  el.dataset.state = kind;
  $('#connText').textContent = text;
}

/* ------------------------------------------------------------- server msgs */

function handleServer(msg) {
  switch (msg.type) {
    case 'hello':
      document.title = `Lumen Remote · ${msg.name}`;
      break;

    case 'device':
      state.device = msg;
      renderDevice();
      break;

    case 'settings':
      state.settings = msg.settings;
      renderSettings();
      break;

    case 'favorites':
      state.favorites = msg.favorites || [];
      renderFavorites();
      break;

    case 'display':
      $('#displayInfo').textContent = `采集分辨率 ${msg.display.width}×${msg.display.height} @ ${msg.display.fps}Hz`;
      break;

    case 'incoming':
      openRequest(msg);
      break;

    case 'session-start':
      enterSession(msg);
      break;

    case 'session-route': {
      const p2p = msg.route === 'p2p';
      $('#routeBadge').textContent = p2p ? 'P2P 直连' : '中继转发';
      $('#routeBadge').classList.toggle('relay', !p2p);
      if (p2p) toast('已升级为 P2P 直连');
      break;
    }

    case 'session-state':
      showConnectMsg(msg.message || '正在建立连接…', false);
      $('#btnConnect').disabled = true;
      break;

    case 'config':
      configureDecoder(msg);
      break;

    case 'displays':
      renderDisplayPicker(msg.displays ?? [], msg.active ?? 0);
      break;

    case 'stats':
      state.stats = msg.stats;
      renderStats(msg.stats);
      break;

    case 'session-end':
      exitSession(msg.reason || '会话已结束');
      break;

    case 'log':
      logLine(msg.level, msg.message);
      break;

    case 'log-bundle':
      downloadText(msg.filename || 'lumen-logs.txt', msg.text || '');
      toast('日志已下载，把这个文件发给开发者即可');
      break;

    case 'notice':
      toast(msg.message, msg.level === 'error' ? 'error' : 'info');
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------- render */

const VERIFY_LABELS = { once: '单次验证码', daily: '今日验证码', long: '长期验证码' };
const VERIFY_HINTS = {
  once: '每次启动换一个，连接结束后立即更换',
  daily: '当天内保持不变，跨零点自动更换',
  long: '长期不变，只有你知道，请勿外传',
};

function renderDevice() {
  const d = state.device;
  $('#deviceId').textContent = d.online ? formatCode(d.code) : '--- --- ---';
  $('#deviceHint').textContent = d.online
    ? `本机名称 ${d.name} · 已连接信令服务器`
    : '正在连接信令服务器…';
  setConnState(d.online ? 'online' : 'offline', d.online ? '已连接信令服务器' : '未连接信令');
  $('#allowRemote').checked = d.allowRemote;
  $('#verifyModeLabel').textContent = VERIFY_LABELS[d.verifyMode] ?? '单次验证码';
  $('#verifyHint').textContent = VERIFY_HINTS[d.verifyMode] ?? VERIFY_HINTS.once;
  for (const item of $$('#verifyMenu button')) {
    item.setAttribute('aria-selected', String(item.dataset.mode === d.verifyMode));
  }
  renderAccessCode();
  renderLan(d.lanAddresses ?? []);
}

/**
 * The phone has to be told which address to dial, and users should not have to
 * read the log for it — surface the first reachable LAN address right in the card.
 */
function renderLan(addresses) {
  const field = $('#lanField');
  const preferred = addresses[0];
  if (!preferred) {
    field.hidden = true;
    return;
  }
  field.hidden = false;
  $('#lanAddress').textContent = preferred;
  $('#lanAddress').dataset.address = preferred;
}

function renderAccessCode() {
  const code = state.device.accessCode || '';
  const el = $('#accessCode');
  el.textContent = state.codeRevealed ? code : '•'.repeat(Math.max(6, code.length));
  el.classList.toggle('masked', !state.codeRevealed);
  $('#btnToggleCode').title = state.codeRevealed ? '隐藏验证码' : '显示验证码';
  $('#btnToggleCode').setAttribute('aria-label', $('#btnToggleCode').title);
}

function renderSettings() {
  const s = state.settings;
  if (document.activeElement !== $('#signalHost')) $('#signalHost').value = s.signalHost;
  if (document.activeElement !== $('#signalPort')) $('#signalPort').value = String(s.signalPort);
  if (document.activeElement !== $('#password')) $('#password').value = s.longPassword;
  $('#allowRemote').checked = s.allowRemote;
  $('#handOverDisplay').checked = s.handOverDisplay !== false;
  $('#blackOutScreen').checked = s.blackOutScreen === true;
  for (const chip of $$('#qualityChips .chip')) chip.classList.toggle('active', chip.dataset.preset === s.quality);
}

function renderFavorites() {
  const build = (host, withName) => {
    host.textContent = '';
    for (const fav of state.favorites) {
      const item = document.createElement('div');
      item.className = 'fav-item';

      const id = document.createElement('span');
      id.className = 'fav-id';
      id.textContent = formatCode(fav.code);

      const actions = document.createElement('div');
      actions.className = 'fav-actions';

      const connect = document.createElement('button');
      connect.className = 'icon-mini';
      connect.type = 'button';
      connect.title = '连接';
      connect.textContent = '↗';
      connect.addEventListener('click', () => connectPeer(fav.code));

      const remove = document.createElement('button');
      remove.className = 'icon-mini';
      remove.type = 'button';
      remove.title = '移除';
      remove.textContent = '✕';
      remove.addEventListener('click', () => send({ type: 'fav-remove', code: fav.code }));

      actions.append(connect, remove);
      item.append(id);
      if (withName && fav.name && fav.name !== fav.code) {
        const name = document.createElement('span');
        name.className = 'field-hint';
        name.textContent = fav.name;
        item.append(name);
      }
      item.append(actions);
      host.appendChild(item);
    }
  };

  build($('#favList'), true);
  build($('#recentList'), false);
  $('#favEmpty').hidden = state.favorites.length > 0;
  $('#recentCard').hidden = state.favorites.length === 0;
}

function renderStats(stats) {
  if (!state.session) return;
  const fps = `${stats.fps}`;
  const latency = state.session.role === 'controller' ? fmtMs(state.lastOneWayMs ?? stats.oneWayMs) : fmtMs(stats.rttMs);
  const rate = state.session.role === 'controller' ? fmtRate(stats.recvBps) : fmtRate(stats.sendBps);
  const loss = `${stats.lossPct}%`;
  $('#hudFps').textContent = fps;
  $('#hudLatency').textContent = latency;
  $('#hudBitrate').textContent = rate;
  $('#hudLoss').textContent = loss;
  if (document.body.classList.contains('host-mode')) {
    $('#hostFps').textContent = fps;
    $('#hostLatency').textContent = latency;
    $('#hostBitrate').textContent = rate;
  }
}

/* ------------------------------------------------------------------- pages */

function showPage(page) {
  state.page = page;
  // "全部设备" is the same screen as "开始协助" but with its own title; the two
  // sidebar entries must not both look active.
  const target = page === 'devices' ? 'assist' : page;
  for (const el of $$('.page')) el.hidden = el.id !== `page-${target}`;
  for (const btn of $$('.nav-item')) btn.classList.toggle('active', btn.dataset.page === page);
  const titles = {
    assist: ['远程协助', '让其他设备协助或控制本机，也可以主动连接伙伴设备'],
    devices: ['全部设备', '本机设备信息与已收藏的设备'],
    favorites: ['收藏设备', '常用设备一键连接'],
    settings: ['设置', '连接、画质与安全'],
  };
  const [title, sub] = titles[page] ?? titles.assist;
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub;
}

/* ------------------------------------------------------------------ session */

function openRequest(msg) {
  state.sessionId = msg.sessionId;
  $('#requestName').textContent = msg.from.name;
  $('#requestCode').textContent = formatCode(msg.from.code);
  $('#requestOs').textContent = msg.from.os;
  $('#requestBody').textContent = '对方请求远程协助本机。确认设备 ID 并核对验证码后再允许。';
  $('#requestAccessCode').textContent = state.device.accessCode || '———';
  $('#requestModal').hidden = false;
  $('#btnAccept').focus();
}

function enterSession(msg) {
  state.session = msg;
  state.decodedFrames = 0;
  state.lastOneWayMs = null;
  $('#requestModal').hidden = true;
  $('#sessionLayer').hidden = false;
  $('#peerName').textContent = msg.peerName;
  $('#sasCode').textContent = `SAS ${msg.sas}`;
  const p2p = msg.route === 'p2p';
  $('#routeBadge').textContent = p2p ? 'P2P 直连' : '中继转发';
  $('#routeBadge').classList.toggle('relay', !p2p);
  $('#overlayText').textContent = msg.role === 'controller' ? '正在接收画面…' : '对方正在查看本机屏幕';
  $('#stageOverlay').hidden = msg.role !== 'controller';
  $('#btnConnect').disabled = false;
  showConnectMsg('', false);
  delete $('#stage').dataset.video;
  if (msg.role === 'controller') {
    setupStageInput();
    $('#stage').focus();
    setTimeout(() => {
      if (state.decodedFrames === 0) send({ type: 'keyframe' });
    }, 700);
  } else {
    enterHostMode(msg);
  }
  logLine('info', `会话建立 ${msg.role === 'host' ? '被控' : '主控'} · ${msg.peerName} · ${p2p ? 'P2P' : '中继'}`);
  if (msg.role === 'controller' && !state.fsHintShown) {
    state.fsHintShown = true;
    toast('按 F11 进入全屏（全屏时鼠标移到顶部可调出工具栏）');
  }
  toast(`已连接 ${msg.peerName}`);
}

/**
 * Being controlled should not take over the screen: the window becomes a small
 * always-on-top card the user can collapse, with a disconnect button on hand.
 */
function enterHostMode(msg) {
  document.body.classList.add('host-mode');
  document.body.classList.remove('host-collapsed');
  $('#hostPeer').textContent = msg.peerName;
  $('#hostSas').textContent = `SAS ${msg.sas}`;
  const p2p = msg.route === 'p2p';
  $('#hostRoute').textContent = p2p ? 'P2P 直连' : '中继转发';
  $('#hostRoute').classList.toggle('relay', !p2p);
  $('#hostFps').textContent = '—';
  $('#hostLatency').textContent = '—';
  $('#hostBitrate').textContent = '—';
  $('#btnHostExpand').hidden = true;
  window.lumen?.setHostPanel?.('expanded');
}

function leaveHostMode() {
  if (!document.body.classList.contains('host-mode')) return;
  document.body.classList.remove('host-mode', 'host-collapsed');
  $('#btnHostExpand').hidden = true;
  window.lumen?.setHostPanel?.('off');
}

/**
 * The host's screens, as reported over the control channel. Only shown
 * when there is an actual choice: a single-screen host gets no extra UI.
 * Switching restarts the host's encoder on the picked display; the input
 * mapping follows it, so the pointer can only ever land on that screen.
 */
function renderDisplayPicker(displays, active) {
  const select = $('#displaySelect');
  if (!select) return;
  if (state.session?.role === 'host') {
    const current = displays.find((d) => d.index === active);
    if (current) logLine('info', `对方正在查看：屏幕 ${current.index + 1}${current.primary ? '（主屏）' : ''}`);
    return;
  }
  select.replaceChildren();
  for (const d of displays) {
    const option = document.createElement('option');
    option.value = String(d.index);
    option.textContent = `屏幕 ${d.index + 1}${d.primary ? '（主屏）' : ''} · ${d.width}×${d.height}`;
    select.appendChild(option);
  }
  select.value = String(active);
  select.hidden = displays.length <= 1;
}

function exitSession(reason) {
  state.session = null;
  if (document.fullscreenElement) void document.exitFullscreen?.()?.catch?.(() => {});
  const select = $('#displaySelect');
  if (select) {
    select.hidden = true;
    select.replaceChildren();
  }
  state.sessionId = null;
  $('#sessionLayer').hidden = true;
  $('#requestModal').hidden = true;
  leaveHostMode();
  $('#btnConnect').disabled = false;
  teardownDecoder();
  if (document.pointerLockElement) document.exitPointerLock();
  if (reason) {
    toast(reason, 'warn');
    logLine('warn', reason);
  }
  showConnectMsg('', false);
}

/* --------------------------------------------------------------- decoding */

function configureDecoder(cfg) {
  const key = cfg.codec;
  if (state.configuredKey === key && state.decoder?.state === 'configured') return;
  state.configuredKey = key;

  if (typeof VideoDecoder === 'undefined') {
    $('#overlayText').textContent = '当前浏览器不支持 WebCodecs 解码';
    return;
  }

  teardownDecoder();
  const description = Uint8Array.from(atob(cfg.avcC), (c) => c.charCodeAt(0));
  const decoder = new VideoDecoder({
    output: onDecodedFrame,
    error: (err) => {
      logLine('error', `解码失败 ${err.message}`);
      state.decoder = null;
      state.configuredKey = '';
      send({ type: 'keyframe' });
    },
  });
  decoder.configure({ codec: cfg.codec, description, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
  state.decoder = decoder;
  logLine('info', `解码器就绪 ${cfg.codec}`);
}

function teardownDecoder() {
  if (!state.decoder) return;
  try {
    state.decoder.close();
  } catch {
    /* ignore */
  }
  state.decoder = null;
}

function onDecodedFrame(frame) {
  // Draw in the decoder's output callback instead of waiting for the
  // next animation frame: rAF added up to a full vsync (16 ms) of pure
  // latency to every frame for no benefit — the canvas is already
  // `desynchronized`, and if frames ever arrive faster than the display
  // can show them, drawing the newest immediately is still the right
  // trade for an interactive session.
  drawFrame(frame);
}

function drawFrame(frame) {
  if (!frame) return;
  const canvas = $('#screen');
  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
  }
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  frame.close();
  state.decodedFrames++;
  $('#stage').dataset.video = 'ready';
  if (!$('#stageOverlay').hidden) $('#stageOverlay').hidden = true;
}

function handleVideo(buf) {
  const view = new DataView(buf);
  if (view.byteLength <= 20) return;
  if (view.getUint8(0) !== 1) return;
  const flags = view.getUint8(1);
  const captureTsUs = Number(view.getBigUint64(8));
  const oneWayUs = view.getUint32(16);
  if (oneWayUs > 0) {
    state.lastOneWayMs = oneWayUs / 1000;
    const el = $('#hudLatency');
    if (el) el.textContent = fmtMs(state.lastOneWayMs);
  }
  if (!state.decoder || state.decoder.state !== 'configured') return;
  // Drop instead of queueing when the decoder is already behind: decoding
  // every frame while the queue grows turns a brief network hiccup into
  // seconds of stale video. Interactive remote desktop prefers the newest
  // frame over a complete but late one. Dropping a delta frame invalidates
  // every frame that references it, though, so once we drop we must stay
  // dropped until the next keyframe (and ask for one) rather than feeding
  // the decoder references it no longer has.
  const isKey = (flags & 1) !== 0;
  if (isKey) {
    state.waitingForKey = false;
    state.lastKeyAt = performance.now();
  } else if (state.waitingForKey) return;
  else if (state.decoder.decodeQueueSize > 4) {
    state.waitingForKey = true;
    // Asking for a keyframe restarts the host's encoder — a stall plus the
    // biggest frame of the GOP into the congestion that caused this. The
    // GOP (2 s) delivers a natural keyframe soon anyway, so only ask when
    // none has been seen for a while, not on every queue hiccup.
    if (performance.now() - (state.lastKeyAt ?? 0) > 1500) send({ type: 'keyframe' });
    return;
  }
  try {
    state.decoder.decode(
      new EncodedVideoChunk({
        type: flags & 1 ? 'key' : 'delta',
        timestamp: Math.round(captureTsUs / 1000),
        data: new Uint8Array(buf, 20),
      }),
    );
  } catch (err) {
    logLine('warn', `解码入队失败 ${err.message}`);
  }
}

/* ------------------------------------------------------------------ input */

const KEYMAP = {
  Digit1: [0x02, 0x31], Digit2: [0x03, 0x32], Digit3: [0x04, 0x33], Digit4: [0x05, 0x34],
  Digit5: [0x06, 0x35], Digit6: [0x07, 0x36], Digit7: [0x08, 0x37], Digit8: [0x09, 0x38],
  Digit9: [0x0a, 0x39], Digit0: [0x0b, 0x30],
  KeyQ: [0x10, 0x51], KeyW: [0x11, 0x57], KeyE: [0x12, 0x45], KeyR: [0x13, 0x52],
  KeyT: [0x14, 0x54], KeyY: [0x15, 0x59], KeyU: [0x16, 0x55], KeyI: [0x17, 0x49],
  KeyO: [0x18, 0x4f], KeyP: [0x19, 0x50],
  KeyA: [0x1e, 0x41], KeyS: [0x1f, 0x53], KeyD: [0x20, 0x44], KeyF: [0x21, 0x46],
  KeyG: [0x22, 0x47], KeyH: [0x23, 0x48], KeyJ: [0x24, 0x4a], KeyK: [0x25, 0x4b],
  KeyL: [0x26, 0x4c],
  KeyZ: [0x2c, 0x5a], KeyX: [0x2d, 0x58], KeyC: [0x2e, 0x43], KeyV: [0x2f, 0x56],
  KeyB: [0x30, 0x42], KeyN: [0x31, 0x4e], KeyM: [0x32, 0x4d],
  Enter: [0x1c, 0x0d], NumpadEnter: [0x11c, 0x0d], Escape: [0x01, 0x1b], Backspace: [0x0e, 0x08],
  Tab: [0x0f, 0x09], Space: [0x39, 0x20], CapsLock: [0x3a, 0x14],
  ShiftLeft: [0x2a, 0xa0], ShiftRight: [0x36, 0xa1],
  ControlLeft: [0x1d, 0xa2], ControlRight: [0x11d, 0xa3],
  AltLeft: [0x38, 0xa4], AltRight: [0x138, 0xa5],
  MetaLeft: [0x15b, 0x5b], MetaRight: [0x15c, 0x5c],
  ArrowUp: [0x148, 0x26], ArrowDown: [0x150, 0x28], ArrowLeft: [0x14b, 0x25], ArrowRight: [0x14d, 0x27],
  Insert: [0x152, 0x2d], Delete: [0x153, 0x2e], Home: [0x147, 0x24], End: [0x14f, 0x23],
  PageUp: [0x149, 0x21], PageDown: [0x151, 0x22],
  F1: [0x3b, 0x70], F2: [0x3c, 0x71], F3: [0x3d, 0x72], F4: [0x3e, 0x73], F5: [0x3f, 0x74],
  F6: [0x40, 0x75], F7: [0x41, 0x76], F8: [0x42, 0x77], F9: [0x43, 0x78], F10: [0x44, 0x79],
  F11: [0x57, 0x7a], F12: [0x58, 0x7b],
  Minus: [0x0c, 0xbd], Equal: [0x0d, 0xbb], BracketLeft: [0x1a, 0xdb], BracketRight: [0x1b, 0xdd],
  Backslash: [0x2b, 0xdc], Semicolon: [0x27, 0xba], Quote: [0x28, 0xde], Backquote: [0x29, 0xc0],
  Comma: [0x33, 0xbc], Period: [0x34, 0xbe], Slash: [0x35, 0xbf],
  Numpad0: [0x52, 0x60], Numpad1: [0x4f, 0x61], Numpad2: [0x50, 0x62], Numpad3: [0x51, 0x63],
  Numpad4: [0x4b, 0x64], Numpad5: [0x4c, 0x65], Numpad6: [0x4d, 0x66], Numpad7: [0x47, 0x67],
  Numpad8: [0x48, 0x68], Numpad9: [0x49, 0x69],
  NumpadMultiply: [0x37, 0x6a], NumpadAdd: [0x4e, 0x6b], NumpadSubtract: [0x4a, 0x6d],
  NumpadDecimal: [0x53, 0x6e], NumpadDivide: [0x135, 0x6f],
  NumLock: [0x145, 0x90], ScrollLock: [0x46, 0x91], PrintScreen: [0x137, 0x2c], Pause: [0x45, 0x13],
  ContextMenu: [0x15d, 0x5d],
};

let pendingMove = null;
let pendingAbs = null;
let inputReady = false;

/**
 * Pointer motion is throttled to ~125 Hz by TIME, not by animation
 * frames. The old rAF coalescing delayed every move by up to a vsync
 * (16 ms) even when the link was idle — pure input latency added before
 * the packet left the machine. 8 ms still collapses a 1000 Hz gaming
 * mouse to a sane packet rate, and the trailing send guarantees the
 * final resting position is never the one that got throttled away.
 */
const MOVE_INTERVAL_MS = 8;
let lastMoveSentAt = 0;
let moveTimer = 0;

function flushMoves() {
  moveTimer = 0;
  lastMoveSentAt = performance.now();
  const move = pendingMove;
  const abs = pendingAbs;
  pendingMove = null;
  pendingAbs = null;
  if (abs) {
    send({ type: 'input', event: { k: 'ma', nx: abs.nx, ny: abs.ny } });
    return;
  }
  if (!move) return;
  if (Math.abs(move.dx) < 0.5 && Math.abs(move.dy) < 0.5) return;
  send({ type: 'input', event: { k: 'mm', dx: Math.round(move.dx), dy: Math.round(move.dy) } });
}

function scheduleMoveFlush() {
  const wait = MOVE_INTERVAL_MS - (performance.now() - lastMoveSentAt);
  if (wait <= 0) {
    flushMoves();
    return;
  }
  if (!moveTimer) moveTimer = setTimeout(flushMoves, wait);
}

function queueMove(dx, dy) {
  if (pendingMove) {
    pendingMove.dx += dx;
    pendingMove.dy += dy;
  } else {
    pendingMove = { dx, dy };
  }
  scheduleMoveFlush();
}

function queueAbsolute(nx, ny) {
  pendingAbs = { nx, ny };
  scheduleMoveFlush();
}

function setupStageInput() {
  if (inputReady) return;
  inputReady = true;
  const stage = $('#stage');
  const canvas = $('#screen');

  /**
   * The canvas element fills the stage but the picture inside it is
   * letterboxed by `object-fit: contain`, so the element's box is NOT the
   * picture's box whenever the aspects differ (always, in fullscreen on a
   * monitor with a different shape than the host's). Mapping against the
   * element box would shift every click by the black-bar size — clicks
   * landing beside the target is exactly that bug.
   */
  function displayedVideoRect() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !canvas.width || !canvas.height) return null;
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const w = canvas.width * scale;
    const h = canvas.height * scale;
    return { left: rect.left + (rect.width - w) / 2, top: rect.top + (rect.height - h) / 2, width: w, height: h };
  }

  function absoluteFromEvent(ev) {
    const rect = displayedVideoRect();
    if (!rect) return null;
    const nx = Math.max(0, Math.min(65535, Math.round(((ev.clientX - rect.left) / rect.width) * 65535)));
    const ny = Math.max(0, Math.min(65535, Math.round(((ev.clientY - rect.top) / rect.height) * 65535)));
    return { nx, ny };
  }

  canvas.addEventListener('mousemove', (ev) => {
    if (document.pointerLockElement === stage) {
      queueMove(ev.movementX || 0, ev.movementY || 0);
      return;
    }
    const pos = absoluteFromEvent(ev);
    if (!pos) return;
    queueAbsolute(pos.nx, pos.ny);
  });

  // DOM MouseEvent.button is 0=left, 1=middle, 2=right, but the wire format
  // (and the host injector, and Android) use 0=left, 1=right, 2=middle.
  // Sending ev.button verbatim swapped right- and middle-click.
  const WIRE_BUTTON = [0, 2, 1, 3, 4];
  const wireButton = (b) => WIRE_BUTTON[b] ?? 0;

  canvas.addEventListener('mousedown', (ev) => {
    stage.focus();
    // Position first, then the button. The button used to be sent immediately
    // while the absolute move waited for the next animation frame, so the
    // host clicked wherever its cursor already was instead of where the user
    // pointed. Sending the position synchronously here keeps the two in
    // order. Pointer lock is deliberately not requested on click: switching
    // to relative motion mid-session makes every subsequent click land at an
    // offset the user cannot see. Double-click toggles it for gaming.
    if (document.pointerLockElement !== stage) {
      const pos = absoluteFromEvent(ev);
      if (pos) send({ type: 'input', event: { k: 'ma', nx: pos.nx, ny: pos.ny } });
    }
    send({ type: 'input', event: { k: 'mb', b: wireButton(ev.button), down: true } });
    ev.preventDefault();
  });

  // No pointer-lock toggle on double-click: double-clicking is how icons
  // and folders open, and engaging pointer lock there hid the cursor
  // (browser hides it; the video has no baked cursor) with no hint why.
  // The toolbar's mouse-lock button owns that mode now.

  // Mouseup must be heard even when the pointer left the canvas mid-drag,
  // otherwise the host button stays pressed.
  window.addEventListener('mouseup', (ev) => {
    if (ev.target === canvas || document.pointerLockElement === stage) {
      send({ type: 'input', event: { k: 'mb', b: wireButton(ev.button), down: false } });
    }
  });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  canvas.addEventListener(
    'wheel',
    (ev) => {
      // Windows counts one notch as 120; Chrome reports 100 px per notch and
      // Firefox 3 lines, so normalise both before sending.
      const lines = ev.deltaMode === 1 ? -ev.deltaY : (-ev.deltaY / 100) * 3;
      const delta = Math.round(lines * 40);
      if (delta !== 0) send({ type: 'input', event: { k: 'mw', delta } });
      ev.preventDefault();
    },
    { passive: false },
  );

  stage.addEventListener('keydown', (ev) => {
    if (ev.isComposing) return;
    const map = KEYMAP[ev.code];
    if (!map) {
      // Layout-specific or IME-produced characters have no fixed scancode, so the
      // character itself is the only thing that reaches the host correctly.
      if (typeof ev.key === 'string' && [...ev.key].length === 1 && !ev.ctrlKey && !ev.metaKey) {
        ev.preventDefault();
        send({ type: 'input', event: { k: 'kr', text: ev.key } });
      }
      return;
    }
    ev.preventDefault();
    if (ev.repeat) return;
    send({ type: 'input', event: { k: 'kd', scan: map[0] & 0xff, vk: map[1] | (map[0] > 0xff ? 0x100 : 0) } });
  });

  stage.addEventListener('keyup', (ev) => {
    const map = KEYMAP[ev.code];
    if (!map) return;
    ev.preventDefault();
    send({ type: 'input', event: { k: 'ku', scan: map[0] & 0xff, vk: map[1] | (map[0] > 0xff ? 0x100 : 0) } });
  });

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === stage;
    $('#captureHint').textContent = locked
      ? '鼠标已锁定 · 以画面中的光标为准 · 按 Esc 释放'
      : '工具栏「鼠标锁定」可切换游戏相对模式';
    $('#btnPointerLock')?.classList.toggle('active', locked);
    // The browser hides the local cursor while locked, so the host bakes
    // its real cursor into the video for the duration. Without this the
    // pointer simply vanishes — the original complaint.
    send({ type: 'pointer-lock', locked });
  });
}

/* ------------------------------------------------------------- interactions */

function showConnectMsg(text, isError) {
  const el = $('#connectMsg');
  el.textContent = text || '';
  el.hidden = !text;
  el.classList.toggle('error', Boolean(isError));
}

function connectPeer(rawCode, password) {
  const code = digits(rawCode);
  if (code.length !== 9) {
    showConnectMsg('请输入 9 位设备 ID', true);
    return;
  }
  const pass = (password ?? $('#peerPass').value).trim();
  if (!pass) {
    showConnectMsg('请输入对方的设备验证码', true);
    $('#peerPass').focus();
    return;
  }
  showConnectMsg('正在请求连接…', false);
  $('#btnConnect').disabled = true;
  send({ type: 'connect', code, password: pass });
}

function bindEvents() {
  $('#displaySelect')?.addEventListener('change', (ev) => {
    const index = Number(ev.target.value);
    if (Number.isFinite(index)) {
      send({ type: 'select-display', index });
      toast(`正在切换到屏幕 ${index + 1}…`);
    }
  });
  $('#btnExportLogs')?.addEventListener('click', () => {
    const header = [
      `浏览器 ${navigator.userAgent}`,
      `页面 ${location.href} · 时间 ${new Date().toISOString()}`,
      `解码器 ${state.decoderState ?? '(未建立)'}`,
    ].join('\n');
    const clientLog = `${header}\n${clientLogLines.join('\n')}`;
    if (state.ws?.readyState === WebSocket.OPEN) {
      send({ type: 'export-logs', clientLog });
    } else {
      // Engine unreachable: still hand the user the browser half.
      downloadText(`lumen-ui-logs-${Date.now()}.txt`, clientLog);
    }
  });
  for (const btn of $$('.nav-item')) {
    btn.addEventListener('click', () => showPage(btn.dataset.page));
  }

  for (const head of $$('.nav-group-head')) {
    head.addEventListener('click', () => {
      const open = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', String(!open));
      let node = head.nextElementSibling;
      while (node && node.classList.contains('nav-item')) {
        node.hidden = open;
        node = node.nextElementSibling;
      }
    });
  }

  $('#allowRemote').addEventListener('change', (ev) => {
    send({ type: 'set-allow', enabled: ev.target.checked });
  });

  $('#handOverDisplay').addEventListener('change', (ev) => {
    send({ type: 'set-handover', enabled: ev.target.checked });
  });

  $('#blackOutScreen').addEventListener('change', (ev) => {
    send({ type: 'set-blackout', enabled: ev.target.checked });
  });

  const menu = $('#verifyMenu');
  const modeBtn = $('#verifyModeBtn');
  const closeMenu = () => {
    menu.hidden = true;
    modeBtn.setAttribute('aria-expanded', 'false');
  };
  modeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const next = menu.hidden;
    menu.hidden = !next;
    modeBtn.setAttribute('aria-expanded', String(next));
  });
  menu.addEventListener('click', (ev) => {
    const target = ev.target.closest('button[data-mode]');
    if (!target) return;
    const mode = target.dataset.mode;
    closeMenu();
    if (mode === state.device.verifyMode) return;
    if (mode === 'long' && !state.settings.longPassword) {
      showPage('settings');
      $('#password').focus();
      toast('请先在设置中填写长期验证码', 'warn');
      return;
    }
    send({ type: 'set-verify', mode });
  });
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeMenu();
  });

  $('#btnToggleCode').addEventListener('click', () => {
    state.codeRevealed = !state.codeRevealed;
    renderAccessCode();
  });

  $('#btnTogglePassword').addEventListener('click', () => {
    const input = $('#password');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    $('#btnTogglePassword').title = reveal ? '隐藏长期验证码' : '显示长期验证码';
    $('#btnTogglePassword').setAttribute('aria-label', $('#btnTogglePassword').title);
  });

  $('#btnCopyShare').addEventListener('click', async () => {
    const code = formatCode(state.device.code);
    const access = state.device.accessCode ?? '';
    try {
      await navigator.clipboard.writeText(`Lumen Remote 识别码：${code}  验证码：${access}`);
      toast('识别码与验证码已复制');
    } catch {
      toast('复制失败，请手动选择', 'warn');
    }
  });

  $('#btnCopyLan').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#lanAddress').dataset.address ?? '');
      toast('局域网地址已复制');
    } catch {
      toast('复制失败，请手动选择', 'warn');
    }
  });

  attachGroupedId($('#peerCode'));

  $('#peerCode').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') connectPeer($('#peerCode').value);
  });
  $('#peerPass').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') connectPeer($('#peerCode').value);
  });

  $('#btnConnect').addEventListener('click', () => connectPeer($('#peerCode').value));

  $('#btnFavCurrent').addEventListener('click', () => {
    const code = digits($('#peerCode').value);
    if (code.length !== 9) {
      showConnectMsg('请输入 9 位设备 ID 后再收藏', true);
      return;
    }
    send({ type: 'fav-add', code });
    toast('已收藏');
  });

  $('#btnAccept').addEventListener('click', () => {
    send({ type: 'accept', sessionId: state.sessionId });
    $('#requestModal').hidden = true;
    showConnectMsg('正在建立连接…', false);
  });

  $('#btnDecline').addEventListener('click', () => {
    send({ type: 'decline', sessionId: state.sessionId });
    $('#requestModal').hidden = true;
  });

  $('#btnHangup').addEventListener('click', () => send({ type: 'disconnect' }));

  $('#btnHostHangup').addEventListener('click', () => {
    send({ type: 'disconnect' });
    leaveHostMode();
  });

  $('#btnHostCollapse').addEventListener('click', () => {
    document.body.classList.add('host-collapsed');
    $('#btnHostExpand').hidden = false;
    window.lumen?.setHostPanel?.('collapsed');
  });

  $('#btnHostExpand').addEventListener('click', () => {
    document.body.classList.remove('host-collapsed');
    $('#btnHostExpand').hidden = true;
    window.lumen?.setHostPanel?.('expanded');
  });
  $('#btnKeyframe').addEventListener('click', () => {
    send({ type: 'keyframe' });
    toast('已请求关键帧');
  });
  $('#btnFullscreen').addEventListener('click', toggleFullscreen);
  $('#btnPointerLock')?.addEventListener('click', () => {
    const stage = $('#stage');
    if (document.pointerLockElement === stage) {
      document.exitPointerLock();
    } else if (stage) {
      // Chrome returns a promise here and rejects when the gesture is not
      // trusted, which would otherwise surface as an unhandled rejection.
      Promise.resolve(stage.requestPointerLock?.()).catch(() => undefined);
    }
  });
  $('#sessionLayer')?.addEventListener('mousemove', pokeToolbar);
  // Capture phase, so F11 is claimed locally before the stage's input
  // forwarding can also ship it to the remote machine: one press must not
  // both toggle this window's fullscreen and press F11 over there.
  document.addEventListener('keydown', (ev) => {
    if ($('#sessionLayer')?.hidden) return;
    if (ev.key === 'F11') {
      // The F11-style experience this app promises: our fullscreen, not
      // whichever window/browser variant the host OS had in mind.
      ev.preventDefault();
      ev.stopPropagation();
      toggleFullscreen();
    } else if (ev.key === 'Escape' && document.fullscreenElement && window.lumen) {
      // Desktop shell: Esc does not reliably exit element fullscreen
      // there, so do it explicitly. Browsers handle Esc natively and
      // mostly do not deliver this keydown at all.
      ev.preventDefault();
      void document.exitFullscreen?.();
    }
  }, true);

  for (const chip of $$('#qualityChips .chip')) {
    chip.addEventListener('click', () => send({ type: 'quality', preset: chip.dataset.preset }));
  }

  $('#btnSaveSignal').addEventListener('click', () => {
    const host = $('#signalHost').value.trim() || '127.0.0.1';
    const port = Number($('#signalPort').value) || 7801;
    send({ type: 'set-signal', host, port });
    toast('已保存，正在重连信令…');
  });

  $('#btnSavePassword').addEventListener('click', () => {
    const password = $('#password').value.trim();
    if (password.length < 4) {
      toast('长期验证码至少 4 位', 'warn');
      return;
    }
    // Generated codes never contain symbols, and the phone keypad has none, so a
    // hand-typed code sticks to the same alphabet.
    if (!/^[A-Za-z0-9]+$/.test(password)) {
      toast('长期验证码只能使用数字和字母', 'warn');
      return;
    }
    if (state.device.verifyMode === 'long') {
      send({ type: 'set-verify', mode: 'long', password });
      toast('长期验证码已保存');
      return;
    }
    // Stored for later without changing the mode that is in effect right now.
    send({ type: 'set-verify', mode: state.device.verifyMode, password });
    toast('长期验证码已保存，切换到「长期验证码」后生效');
  });

  window.addEventListener('beforeunload', () => {
    if (state.session) send({ type: 'disconnect' });
  });

  if (window.lumen?.onEngineExit) {
    window.lumen.onEngineExit(({ code }) => toast(`后台引擎已退出（${code}）`, 'error', 8000));
  }
}

/* --------------------------------------------------------------- bootstrap */

bindEvents();
renderFavorites();
showPage('assist');
connectSocket();
logLine('info', '界面已就绪');

// Register the service worker so the web client can be installed on a phone
// home screen (Android Chrome / iOS Safari 16.4+).
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    // A new worker taking over means the cached shell was replaced; reload once
    // so the page never keeps running yesterday's app.js against today's API.
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
    }
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

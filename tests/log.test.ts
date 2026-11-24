import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppLogger, parseLogLevel, redactSecrets } from '../src/util/log.ts';

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('logger writes structured lines with module, level and meta', (t) => {
  const dir = tempDir(t);
  const logger = new AppLogger({ dir, name: 'lumen' });
  logger.info('app', '会话开始', { role: 'host' });
  logger.warn('session', '数据包鉴权失败（累计 1）');
  const text = readFileSync(join(dir, 'lumen.log'), 'utf8');
  assert.match(text, /\[INFO \] \[app\] #1 会话开始 \{"role":"host"\}/);
  assert.match(text, /\[WARN \] \[session\] #2 数据包鉴权失败/);
  assert.match(logger.recentText(), /会话开始/);
});

test('level filtering drops lines below the configured level', (t) => {
  const dir = tempDir(t);
  const logger = new AppLogger({ dir, name: 'lumen', level: 'warn' });
  logger.debug('app', 'debug-noise');
  logger.info('app', 'info-noise');
  logger.error('app', 'real-problem');
  const text = readFileSync(join(dir, 'lumen.log'), 'utf8');
  assert.doesNotMatch(text, /noise/);
  assert.match(text, /real-problem/);
  logger.setLevel('debug');
  logger.debug('app', 'now-visible');
  assert.match(readFileSync(join(dir, 'lumen.log'), 'utf8'), /now-visible/);
});

test('child logger binds the module tag and matches the Logger shape', (t) => {
  const dir = tempDir(t);
  const logger = new AppLogger({ dir, name: 'lumen' });
  logger.child('session')('warn', '队列溢出', { bytes: 42 });
  assert.match(readFileSync(join(dir, 'lumen.log'), 'utf8'), /\[session\] #1 队列溢出 \{"bytes":42\}/);
});

test('rotation bounds the number and size of files on disk', (t) => {
  const dir = tempDir(t);
  const logger = new AppLogger({ dir, name: 'lumen', maxFileBytes: 400, maxFiles: 3 });
  for (let i = 0; i < 200; i++) logger.info('app', `line ${i} ${'x'.repeat(40)}`);
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ['lumen.1.log', 'lumen.2.log', 'lumen.log']);
  const total = files.reduce((sum, f) => sum + readFileSync(join(dir, f), 'utf8').length, 0);
  assert.ok(total <= 400 * 3 + 512, `total ${total} should stay near the 3x400 budget`);
  // The newest line is always in the active file.
  assert.match(readFileSync(join(dir, 'lumen.log'), 'utf8'), /line 199/);
});

test('ring buffer is capped and exportText falls back to it', (t) => {
  const dir = tempDir(t);
  const logger = new AppLogger({ dir, name: 'lumen', ringSize: 5 });
  for (let i = 0; i < 12; i++) logger.info('app', `ring ${i}`);
  const lines = logger.recentText().split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0]!, /ring 7/);
  assert.match(lines[4]!, /ring 11/);
});

test('redactSecrets masks credential assignments and long blobs', () => {
  assert.equal(redactSecrets('password=123456 ok'), 'password=*** ok');
  assert.equal(redactSecrets('token: abcdef 其他'), 'token: *** 其他');
  assert.match(redactSecrets(`key ${'A'.repeat(64)}`), /^key A{8}…$/);
  // Ordinary diagnostics survive untouched.
  assert.equal(redactSecrets('rtt=12ms loss=0%'), 'rtt=12ms loss=0%');
});

test('logged messages are redacted before they reach disk', (t) => {
  const dir = tempDir(t);
  const logger = new AppLogger({ dir, name: 'lumen' });
  logger.info('app', 'connect password=hunter2 done');
  const text = readFileSync(join(dir, 'lumen.log'), 'utf8');
  assert.doesNotMatch(text, /hunter2/);
  assert.match(text, /password=\*\*\*/);
});

test('a broken log directory never throws', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const dir = tempDir(t);
  const fileAsDir = join(dir, 'not-a-dir');
  writeFileSync(fileAsDir, 'x');
  const logger = new AppLogger({ dir: join(fileAsDir, 'logs'), name: 'lumen' });
  assert.doesNotThrow(() => logger.info('app', 'still fine'));
  assert.doesNotThrow(() => logger.info('app', 'still fine again'));
  assert.match(logger.recentText(), /still fine/);
  // Degrading silently is what hid a root-owned log dir on the server: warn once.
  assert.equal(warn.mock.callCount(), 1);
  const firstWarning = warn.mock.calls[0];
  assert.ok(firstWarning);
  assert.match(String(firstWarning.arguments[0]), /文件日志已停用/);
});

test('parseLogLevel accepts known levels and falls back otherwise', () => {
  assert.equal(parseLogLevel('debug'), 'debug');
  assert.equal(parseLogLevel('WARN'), 'warn');
  assert.equal(parseLogLevel('nonsense'), 'info');
  assert.equal(parseLogLevel(undefined, 'error'), 'error');
});

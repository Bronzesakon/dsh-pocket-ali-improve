// downloadFile 多线程分块下载测试：本地起一个支持 Range 的服务器，
// 验证分块并发下载 + 合并后字节与源完全一致；以及不支持 Range 时回退单线程。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { downloadFile } from '../lib/tunnel.mjs';

/** 假二进制内容：4MB 可预测字节（> MIN_PARALLEL_SIZE，触发分块）。 */
function makePayload(size) {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

/** 支持/不支持 Range 的服务器。 */
async function rangeServer(payload, { supportRange }) {
  const server = createServer((req, res) => {
    const range = req.headers.range;
    if (supportRange && range) {
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(m[1]);
      const end = Number(m[2]);
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${end}/${payload.length}`,
        'content-length': end - start + 1,
        'accept-ranges': 'bytes',
      });
      res.end(payload.subarray(start, end + 1));
    } else {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': payload.length,
        ...(supportRange ? { 'accept-ranges': 'bytes' } : {}),
      });
      res.end(payload);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, server };
}

test('downloadFile：支持 Range 时多线程分块，合并后字节与源一致', async () => {
  const payload = makePayload(4 * 1024 * 1024);
  const { port, server } = await rangeServer(payload, { supportRange: true });
  const dir = await mkdtemp(join(tmpdir(), 'dl-par-'));
  try {
    const dest = join(dir, 'out.bin');
    const len = await downloadFile(`http://127.0.0.1:${port}/cf`, dest, { segments: 8 });
    assert.equal(len, payload.length, '返回总字节数');
    const got = await readFile(dest);
    assert.equal(got.length, payload.length, '合并后长度一致');
    assert.ok(got.equals(payload), '合并后字节完全一致');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test('downloadFile：不支持 Range 时回退单线程，字节一致', async () => {
  const payload = makePayload(3 * 1024 * 1024);
  const { port, server } = await rangeServer(payload, { supportRange: false });
  const dir = await mkdtemp(join(tmpdir(), 'dl-single-'));
  try {
    const dest = join(dir, 'out.bin');
    const len = await downloadFile(`http://127.0.0.1:${port}/cf`, dest, { segments: 8 });
    assert.equal(len, payload.length);
    const got = await readFile(dest);
    assert.ok(got.equals(payload), '单线程回退字节一致');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test('resolveCloudflared：手动放置的资产名文件也能命中缓存（issue #15）', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { resolveCloudflared } = await import('../lib/tunnel.mjs');
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshp-manual-'));
  const { platform } = await import('node:process');
  const archMap = { x64: 'amd64', arm64: 'arm64' };
  const osName = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : 'linux';
  const arch = archMap[process.arch] ?? process.arch;
  const assetName = `cloudflared-${osName}-${arch}${osName === 'windows' ? '.exe' : ''}`;

  // 只放资产名文件（不是 bin 名）→ 应命中，不触发下载
  const binDir = path.join(home, 'dsh-pocket', 'bin');
  await fsp.mkdir(binDir, { recursive: true });
  await fsp.writeFile(path.join(binDir, assetName), 'fake-binary');
  let downloading = false;
  const bin = await resolveCloudflared({ home, onPhase: (p) => { if (p === 'downloading') downloading = true; } });
  assert.equal(downloading, false, '未触发下载');
  assert.ok(bin.includes(assetName), '命中资产名文件: ' + bin);
  await fsp.rm(home, { recursive: true, force: true });
});

test('resolveCloudflared：Linux 上丢弃 Homebrew bottle 坏缓存（issue #22）', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { resolveCloudflared } = await import('../lib/tunnel.mjs');
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshp-homebrew-'));
  const binDir = path.join(home, 'dsh-pocket', 'bin');
  await fsp.mkdir(binDir, { recursive: true });
  // 模拟 Linux Homebrew bottle 坏缓存：文件含 @@HOMEBREW_PREFIX@@ 占位符
  await fsp.writeFile(path.join(binDir, 'cloudflared'), '@@HOMEBREW_PREFIX@@/lib/ld.so\x00fake-binary');
  let downloading = false;
  // 在 Linux 上会触发删除 + 重新下载（下载会失败因网络，但我们只验证"不命中坏缓存"）
  try {
    await resolveCloudflared({ home, onPhase: (p) => { if (p === 'downloading') downloading = true; } });
  } catch { /* 下载失败可接受 */ }
  // 坏缓存应已被删除（不再被当成可用二进制）
  const stillThere = await fsp.readFile(path.join(binDir, 'cloudflared'), 'utf8').catch(() => null);
  // 若系统是 Linux 且触发了下载流程 → 文件被删/被覆盖；macOS 上本测试不适用（无 Homebrew 检查）
  if (process.platform === 'linux') {
    assert.ok(stillThere === null || !stillThere.includes('@@HOMEBREW_PREFIX@@'), '坏缓存被丢弃');
  }
  await fsp.rm(home, { recursive: true, force: true });
});

test('隧道 URL 解析（issue #32）：排除 api.trycloudflare.com 保留子域', async () => {
  const { QUICK_TUNNEL_URL_RE } = await import('../lib/tunnel.mjs');
  // 正常隧道 URL 匹配
  assert.match('https://abc123-def.trycloudflare.com', QUICK_TUNNEL_URL_RE);
  // 保留子域 api 不匹配（扫码打开 api 端点会返回 code 10005 Method Not Allowed）
  assert.doesNotMatch('https://api.trycloudflare.com', QUICK_TUNNEL_URL_RE);
  // cloudflared 输出里 api 地址先出现时，第一个匹配必须是隧道 URL
  const output = 'INF registering tunnel at https://api.trycloudflare.com/...\nYour quick tunnel: https://xyz789.trycloudflare.com\n';
  const m = output.match(QUICK_TUNNEL_URL_RE);
  assert.ok(m && m[0] === 'https://xyz789.trycloudflare.com', '不误匹配 api 地址: ' + (m && m[0]));
});

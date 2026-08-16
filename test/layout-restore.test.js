// 桌面高级模式布局回插：boot 图改写 + 自托管 bundle 路由。
// 场景：DSH Desktop 的 `dsh-desktop.mode: advanced` 会在宿主客户端插件图里禁用
// 官方 @deepseek-ai/dsh-client-ui-layout，手机经代理访问（被迫 compatibility）时
// 没有任何插件提供 layout 服务 → "web boot: N entries did not activate"。
// 代理修复：给 HTML 回插该行 + 自托管 bundle（宿主对 disabled 行 404）。
// 全部走真实 HTTP（无 stub），与 smoke.test.js 的链路测试同一风格。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPocketProxy, restoreLayoutEntry } from '../lib/proxy.mjs';

const LAYOUT_ID = '@deepseek-ai/dsh-client-ui-layout';
const BUNDLE_BODY = 'window.__ModuleLoader__.load({id:"' + LAYOUT_ID + '",factory:function(){}})';
const BASE_GRAPH = { rev: 'abc123', entries: [{ id: 'other-plugin', url: '/plugins/other-plugin/client.js?rev=x', rev: 'x' }] };
const BOOT_HTML = `<!doctype html><html><head><script>window.__DSH_BOOT__ = ${JSON.stringify(BASE_GRAPH).replaceAll('<', '\\u003c')}</script></head><body>dsh</body></html>`;

/** 临时写一个"官方布局 bundle"文件，返回其路径。 */
async function fakeLayoutFile(dir) {
  const file = join(dir, 'client.js');
  await writeFile(file, BUNDLE_BODY, 'utf8');
  return file;
}

/** 假 dsh web：HTML 带 boot 图；bundle 路径一律 404（模拟宿主 disabled 行）。 */
async function fakeUpstream(html) {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/plugins/')) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

test('restoreLayoutEntry：图里缺行时回插，且转义保持 JSON 可解析', () => {
  const out = restoreLayoutEntry(BOOT_HTML, { id: LAYOUT_ID, rev: 'deadbeef1234' });
  assert.notEqual(out, BOOT_HTML, '确实发生了改写');
  assert.ok(out.includes(`"id":"${LAYOUT_ID}"`), '回插了官方布局行');
  assert.ok(out.includes(`/plugins/${LAYOUT_ID}/client.js?rev=deadbeef1234`), 'bundle URL 指向代理自托管路由');
  // 回写仍能被解析：< 被转义成 \u003c（JSON.parse 自动还原）
  const m = /<script>window\.__DSH_BOOT__ = (.*?)<\/script>/s.exec(out);
  assert.ok(m, 'boot 脚本仍在');
  const graph = JSON.parse(m[1]);
  assert.ok(Array.isArray(graph.entries));
  const row = graph.entries.find((e) => e.id === LAYOUT_ID);
  assert.equal(row.url, `/plugins/${LAYOUT_ID}/client.js?rev=deadbeef1234`);
  assert.equal(row.rev, 'deadbeef1234');
});

test('restoreLayoutEntry：图里已有该行时幂等（不重复插入）', () => {
  const withRow = {
    rev: 'abc',
    entries: [{ id: LAYOUT_ID, url: `/plugins/${LAYOUT_ID}/client.js?rev=host`, rev: 'host' }],
  };
  const html = `<!doctype html><head><script>window.__DSH_BOOT__ = ${JSON.stringify(withRow).replaceAll('<', '\\u003c')}</script></head>`;
  assert.equal(restoreLayoutEntry(html, { id: LAYOUT_ID, rev: 'pocket' }), html, '宿主已有行（未来按请求图实现）→ 原样不动，自动退位');
});

test('restoreLayoutEntry：非 boot 图 HTML 原样返回', () => {
  const plain = '<!doctype html><head><script>window.__OTHER__ = 1</script></head>';
  assert.equal(restoreLayoutEntry(plain, { id: LAYOUT_ID, rev: 'x' }), plain);
});

test('真实链路：HTML 回插 + bundle 自托管（宿主 404 也不影响手机）', async () => {
  const up = await fakeUpstream(BOOT_HTML);
  const dir = await mkdtemp(join(tmpdir(), 'layout-'));
  const file = await fakeLayoutFile(dir);
  const proxy = await createPocketProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    injectHtml: '',
    layoutBundle: { id: LAYOUT_ID, file, map: null },
  });
  try {
    // HTML 文档：boot 图被回插官方布局行
    const res = await fetch(`http://127.0.0.1:${proxy.port}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(`"id":"${LAYOUT_ID}"`), 'HTML 里已有官方布局行');

    // bundle：代理自托管（上游 404），内容与本地文件一致
    const rev = /\/plugins\/@deepseek-ai\/dsh-client-ui-layout\/client\.js\?rev=([a-f0-9]+)/.exec(html)?.[1];
    assert.ok(rev, '回插行的 rev 已生成');
    const bundle = await fetch(`http://127.0.0.1:${proxy.port}/plugins/${LAYOUT_ID}/client.js?rev=${rev}`);
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type') ?? '', /text\/javascript/);
    assert.equal(await bundle.text(), BUNDLE_BODY);

    // 其他 /plugins 路径照常透传（上游 404 → 404）
    const other = await fetch(`http://127.0.0.1:${proxy.port}/plugins/other-plugin/client.js?rev=x`);
    assert.equal(other.status, 404);
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

test('真实链路：layoutBundle 未配置时不动 HTML、bundle 透传上游', async () => {
  const up = await fakeUpstream(BOOT_HTML);
  const proxy = await createPocketProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    injectHtml: '',
  });
  try {
    const html = await (await fetch(`http://127.0.0.1:${proxy.port}/`)).text();
    assert.ok(!html.includes(`"id":"${LAYOUT_ID}"`), '未启用时不回插');
    const bundle = await fetch(`http://127.0.0.1:${proxy.port}/plugins/${LAYOUT_ID}/client.js`);
    assert.equal(bundle.status, 404, '未启用时透传上游 404');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

// 真实链路冒烟测试：不注入任何 stub，验证「真实代理转发 + polyfill 注入 + 状态快照 + RPC」。
// 之前的教训：测试全用 stub 会漏掉真实环境才出现的 bug（如 require 崩溃、未处理 rejection）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPocketService } from '../lib/service.mjs';
import { installPocketRpc } from '../lib/web-rpc.js';
import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS } from '../client/api.js';

/** 假 dsh web：返回一个简单 HTML 文档（走真实 qrcode / 真实代理，无 stub）。 */
async function fakeUpstream() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>dsh</title></head><body>real-dsh</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

function fakeCtxConnection() {
  let handler = null;
  const handle = (channel, fn) => {
    assert.equal(channel, POCKET_RPC_CHANNEL);
    handler = fn;
    return () => { handler = null; };
  };
  return { rpc: { handle }, get handler() { return handler; } };
}

test('真实链路：代理转发 + polyfill 注入 + 状态快照（无 stub）', async () => {
  const up = await fakeUpstream();
  const home = await mkdtemp(join(tmpdir(), 'smoke-'));
  const service = createPocketService({ dshPort: up.address().port, port: 0, home });
  try {
    await service.startProxy();
    const st = await service.status();
    assert.equal(st.proxyRunning, true);
    assert.ok(st.proxyPort > 0, '拿到真实监听端口');

    // 真实代理转发到假 dsh web，且 HTML 被注入 randomUUID polyfill
    const res = await fetch(`http://127.0.0.1:${st.proxyPort}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('real-dsh'), '代理转发到上游');
    assert.ok(html.includes('randomUUID'), '非安全上下文 polyfill 已注入');

    // 状态快照：局域网 URL + 真实 qrcode 生成的二维码
    assert.ok(st.lanUrl.startsWith('http://'), '局域网 URL');
    assert.ok(st.lanQr.startsWith('data:image/png;base64,'), '真实 qrcode 生成的二维码');
  } finally {
    await service.dispose();
    await new Promise((r) => up.close(r));
    await rm(home, { recursive: true, force: true });
  }
});

test('真实链路：RPC status 走真实 service（含 restartNotice）', async () => {
  const up = await fakeUpstream();
  const home = await mkdtemp(join(tmpdir(), 'smoke-rpc-'));
  const service = createPocketService({ dshPort: up.address().port, port: 0, home });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, { service, log: { error() {}, warn() {} } });
  try {
    await service.startProxy();
    const r = await conn.handler(POCKET_ENDPOINTS.status, {});
    assert.equal(r.ok, true);
    assert.equal(r.value.proxyRunning, true);
    assert.ok(r.value.proxyPort > 0);
    assert.ok(r.value.lanQr.startsWith('data:image/png;base64,'), 'RPC 返回真实二维码');
    assert.equal(r.value.restartNotice, null, '无重启标记');
  } finally {
    await service.dispose();
    await new Promise((r) => up.close(r));
    await rm(home, { recursive: true, force: true });
  }
});

test('client bundle 注入 React 绑定（PR #1 回归：mobile 组件曾 React is not defined）', async () => {
  // DSH 模块系统提供 react 为模块、非全局；esbuild classic JSX 生成 React.createElement，
  // 若 factory 不绑定 React，mobile 组件（抽屉布局）渲染即崩、移动端适配永远不激活。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.ok(src.includes('var React = require("react")'), 'factory 注入 React 绑定');
  // 匹配实际调用形式（带左括号），避免命中 build.mjs 注释里的字面量
  assert.ok(src.includes('React.createElement('), 'bundle 内存在 JSX 编译产物（需要 React 绑定）');
  const injectIdx = src.indexOf('var React = require("react")');
  const createIdx = src.indexOf('React.createElement(');
  assert.ok(injectIdx !== -1 && createIdx !== -1 && injectIdx < createIdx, 'React 声明先于使用');
});

test('client bundle：status 访问必须可选链（回归：1.9.0 白屏——首次渲染 status=null 时裸 status.lanAuthEnabled 抛 TypeError）', async () => {
  // load() 是异步的：首次渲染时 status 为 null。LAN 开关行渲染在 lanUrl 安全分支之外，
  // 1.9.0 在这里裸访问 status.lanAuthEnabled → React 整树崩溃 → 设置页白屏。
  // 修复：全部 status?.lanAuthEnabled。此测试防止再次出现裸访问（esbuild 会原样保留 ?.）。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('status.lanAuthEnabled'), 'bundle 不允许裸 status.lanAuthEnabled（必须可选链）');
  assert.ok(src.includes('status?.lanAuthEnabled'), 'bundle 存在可选链访问');
});

test('移动导航 backdrop（issue #38）：点击穿透不抢抽屉内点击 + 抽屉外点击关闭保留', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  // CSS：backdrop 必须 pointer-events: none（纯压暗层，不接收点击）
  const css = src.match(/\[data-mobile-nav="backdrop"\][^}]*}/)?.[0] ?? '';
  assert.ok(css.includes('pointer-events: none'), 'backdrop 点击穿透');
  // JSX：backdrop 是纯视觉 div（无 role/onClick）
  assert.ok(src.includes('"data-mobile-nav": "backdrop"'), 'backdrop 纯视觉渲染');
  // 关闭逻辑：抽屉内导航关闭 + 抽屉外点击关闭（两套 document capture contains 处理）
  assert.ok((src.match(/contains\(target\)/g) || []).length >= 2, '存在抽屉内外两套点击处理');
});

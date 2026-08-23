// 代理注入的浏览器 polyfill（RANDOM_UUID_POLYFILL）行为测试：
// 1. crypto.randomUUID（非安全上下文缺失时安装）
// 2. AbortSignal.any（issue #53：Android 厂商浏览器/WebView 无原生实现时安装）
// 用 node:vm 模拟浏览器全局执行脚本字符串（self 指向 node 全局，删除原生 any 模拟缺失）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

const { RANDOM_UUID_POLYFILL } = await import('../lib/proxy.mjs');

test('polyfill：注入内容带判重标记，且包含 AbortSignal.any 与 randomUUID 两个补丁', () => {
  assert.ok(RANDOM_UUID_POLYFILL.includes('data-dsh-pocket-polyfill="1"'), '带注入判重标记');
  assert.ok(RANDOM_UUID_POLYFILL.includes('AbortSignal.any'), '含 AbortSignal.any polyfill');
  assert.ok(RANDOM_UUID_POLYFILL.includes('randomUUID'), '含 crypto.randomUUID polyfill');
});

/** 在模拟浏览器上下文里执行 polyfill 脚本（self = node 全局，能访问 AbortSignal 等）。
 *  RANDOM_UUID_POLYFILL 是完整 <script> 标签，vm 只接受纯 JS——先提取 script 体。 */
function runPolyfill() {
  const js = RANDOM_UUID_POLYFILL.match(/<script[^>]*>([\s\S]*)<\/script>/)?.[1] ?? RANDOM_UUID_POLYFILL;
  const context = { self: globalThis, AbortController, AbortSignal, Uint8Array, Array, String, setTimeout, clearTimeout };
  runInNewContext(js, context);
}

test('polyfill：原生 AbortSignal.any 存在时不覆盖', () => {
  const orig = AbortSignal.any;
  try {
    runPolyfill(); // 原生存在（node 22 有）→ 脚本不安装
    assert.equal(AbortSignal.any, orig, '不覆盖原生实现');
  } finally {
    AbortSignal.any = orig;
  }
});

test('polyfill（issue #53）：缺失 AbortSignal.any 时安装且行为正确', () => {
  const orig = AbortSignal.any;
  try {
    delete AbortSignal.any; // 模拟 Android 厂商浏览器/WebView（无原生 any）
    runPolyfill();
    assert.equal(typeof AbortSignal.any, 'function', '缺失时安装 polyfill');

    // ① 任一输入 signal abort → 组合 signal 同步 abort
    const c1 = new AbortController();
    const c2 = new AbortController();
    const s1 = AbortSignal.any([c1.signal, c2.signal]);
    assert.equal(s1.aborted, false, '初始未中止');
    c1.abort('reason-x');
    assert.equal(s1.aborted, true, '任一 abort → 组合 abort');
    assert.equal(s1.reason, 'reason-x', '保留第一个 abort reason');

    // ② 输入 signal 已经 aborted → 立即返回 aborted signal
    const pre = new AbortController();
    pre.abort(new Error('pre-aborted'));
    const s2 = AbortSignal.any([pre.signal]);
    assert.equal(s2.aborted, true, '已 aborted 输入 → 立即 aborted');
    assert.equal(s2.reason.message, 'pre-aborted', '保留 reason');

    // ③ 第二个 signal 之后 abort → 同样生效（reason 保留第一个）
    const c3 = new AbortController();
    const c4 = new AbortController();
    const s3 = AbortSignal.any([c3.signal, c4.signal]);
    c4.abort('reason-y');
    assert.equal(s3.aborted, true, '任意位置的 signal abort 都生效');
    assert.equal(s3.reason, 'reason-y', 'reason 正确');
  } finally {
    AbortSignal.any = orig;
  }
});

test('polyfill：randomUUID 在缺失时安装（非安全上下文场景）', () => {
  const { crypto } = globalThis;
  if (!crypto) return; // node 22 有 webcrypto；无则跳过
  const orig = crypto.randomUUID;
  try {
    delete crypto.randomUUID;
    runPolyfill();
    assert.equal(typeof crypto.randomUUID, 'function', '缺失时安装 randomUUID');
    const id = crypto.randomUUID();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'v4 UUID 格式');
  } finally {
    crypto.randomUUID = orig;
  }
});

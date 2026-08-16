// dsh-pocket 核心：Host/Origin 改写反向代理
//
// 为什么需要它：DSH 的 /api 浏览器信任栅栏只认 loopback（127.0.0.1）或
// `--trusted-host` 白名单（且官方禁了 0.0.0.0 绑定，防止把远程执行代码暴露给网络）。
// 本代理把入站请求的 Host / Origin 统一改写成 loopback 权威（127.0.0.1:3080），
// 转发给本机 dsh web——栅栏永远看到 loopback，于是：
//   - 局域网：手机直接访问 http://<电脑IP>:端口
//   - 公网：cloudflared 隧道指到本代理，任意域名都能进
// 都不需要改 dsh 的任何配置。
//
// 同步保证：普通请求与 WebSocket upgrade（/api/events.host 流式推送）都原样透传，
// 手机看到的界面与电脑完全一致、实时。

import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const DEFAULT_UPSTREAM = { host: '127.0.0.1', port: 3080 };

/**
 * 非安全上下文（http://<LAN-IP>:端口）里浏览器没有 crypto.randomUUID，
 * 前端（DSH 连接层 mint RPC id 用）会直接抛 "crypto.randomUUID is not a function"。
 * 通过代理给 HTML 文档注入 polyfill（只在缺少时生效，用 getRandomValues 实现 v4）。
 * 带 data-dsh-pocket-polyfill 标记：注入判重用它，而不是搜索 "crypto.randomUUID"
 * 字样（dsh 页面源码里可能恰好出现该字符串，导致误判为已注入而跳过）。
 */
const RANDOM_UUID_POLYFILL = `<script data-dsh-pocket-polyfill="1">!function(){try{if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}}catch(e){}}();</script>`;

const INJECT_MARK = 'data-dsh-pocket-polyfill="1"';

/**
 * DSH Desktop（桌面版）渲染进程兼容补丁。
 *
 * 桌面版 profile 里的 dsh-plugin-desktop client 会在页面加载时从 URL query 读
 * `dsh-desktop-mode` 与 `dsh-desktop-platform`，缺失即抛
 * "invalid or missing dsh-desktop-mode null" → 页面崩（手机扫码访问桌面版时正是如此，
 * 见 issue #3/#4）。本脚本在页面加载前用 history.replaceState 把这两个参数补上
 * （无跳转、不重载），取最轻的 `compatibility` 模式——不激活桌面布局，避免与
 * 移动端适配叠加。
 * 仅宿主在桌面版（isDesktop）时由 lib/index.js 追加进 injectHtml。
 */
export function desktopEnvPatchScript(platform) {
  const p = ['darwin', 'win32', 'linux'].includes(platform) ? platform : 'linux';
  return `<script data-dsh-pocket-desktop-patch="1">!function(){try{var s=new URLSearchParams(location.search);if(!s.has('dsh-desktop-mode')||!s.has('dsh-desktop-platform')){s.set('dsh-desktop-mode','compatibility');s.set('dsh-desktop-platform','${p}');var u=new URL(location.href);u.search=s.toString();history.replaceState(null,'',u);}}catch(e){}}();</script>`;
}

/** 上游响应是否压缩过（压缩流不能做文本注入，会损坏页面）。 */
function isCompressed(headers) {
  return /(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers['content-encoding'] ?? ''));
}

/**
 * 桌面高级模式布局回插（零改动 desktop 的修复）。
 *
 * 桌面版 `dsh-desktop.mode: advanced` 时，宿主会把官方
 * `@deepseek-ai/dsh-client-ui-layout` 行从客户端插件图里禁用（layout 服务改由
 * 桌面自有 shell 提供，且只在 URL 带 `dsh-desktop-mode=advanced` 时提供）。
 * 手机经本代理访问时被上方补丁强制为 `compatibility`（避免桌面布局与移动端适配
 * 叠加）→ 两端都不提供 `layout` 服务 → 页面白屏
 * "web boot: N entries did not activate ... waiting for service: layout"。
 *
 * 修复：代理在转发给手机的 HTML 里把官方 ui-layout 行**回插**进
 * `window.__DSH_BOOT__.entries`，并**自托管**该包的 client bundle
 * （宿主对 disabled 行会 404）。手机收到的插件图与兼容模式逐行相同，
 * 官方 AppFrame 照常渲染，移动端适配原样生效；桌面窗口不经过代理，不受影响。
 * 护栏：图里已有该行（宿主未来自己实现按请求图时）→ 不插，自动退位。
 */

/** boot 注入脚本形态：`<script>window.__DSH_BOOT__ = <json></script>`（`<` 被转义为 \u003c）。 */
const BOOT_SCRIPT_RE = /(<script[^>]*>)window\.__DSH_BOOT__\s*=\s*(.*?)(<\/script>)/gs;

/**
 * 把 layout 插件行回插进 HTML 里的 boot 图（幂等：已存在或解析失败则原样返回）。
 * @param {string} html - 上游 HTML 文档。
 * @param {{id:string, rev:string}} layout - 待回插的插件行（包名 + bundle rev）。
 * @returns {string} 改写后的 HTML。
 */
export function restoreLayoutEntry(html, layout) {
  if (typeof html !== 'string' || !layout || typeof layout.id !== 'string' || typeof layout.rev !== 'string') return html;
  return html.replace(BOOT_SCRIPT_RE, (match, openTag, raw, closeTag) => {
    let graph;
    try { graph = JSON.parse(raw); } catch { return match; } // 非 JSON → 不是 boot 图，保持原样
    if (typeof graph !== 'object' || graph === null || !Array.isArray(graph.entries)) return match;
    if (graph.entries.some((entry) => entry && typeof entry === 'object' && entry.id === layout.id)) return match;
    const entries = [...graph.entries, { id: layout.id, url: `/plugins/${layout.id}/client.js?rev=${layout.rev}`, rev: layout.rev }];
    return `${openTag}window.__DSH_BOOT__ = ${JSON.stringify({ ...graph, entries }).replaceAll('<', '\\u003c')}${closeTag}`;
  });
}

/**
 * 校验并归一化 layout 回插配置：文件必须立即可读（否则整个功能降级关闭，不拦手机页面）。
 * @param {unknown} bundle - lib/index.js 传入的 { id, file, map } 或 null。
 * @param {((msg:string)=>void)|null} log
 * @returns {{id:string, file:string, map:string|null, rev:string}|null}
 */
function normalizeLayoutBundle(bundle, log) {
  if (!bundle || typeof bundle !== 'object') return null;
  const { id, file, map } = bundle;
  if (typeof id !== 'string' || id.length === 0 || typeof file !== 'string' || file.length === 0) return null;
  let rev = 'pocket';
  try {
    rev = createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 12);
  } catch (err) {
    log?.(`dsh-pocket: layout bundle unreadable, restore disabled | 布局包不可读，回插已禁用: ${err?.message ?? err}`);
    return null;
  }
  return { id, file, map: typeof map === 'string' ? map : null, rev };
}

/**
 * 自托管被宿主禁用的 layout client bundle（仅白名单路径，其余一律透传）。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{id:string, file:string, map:string|null}} layout
 * @returns {boolean} 是否已在本层应答（true 表示不再转发上游）。
 */
function serveLayoutEntry(req, res, layout) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = decodeURIComponent(String(req.url ?? '/').split('?')[0]);
  const base = `/plugins/${layout.id}`;
  let file = null;
  let type = '';
  if (pathname === `${base}/client.js`) {
    file = layout.file;
    type = 'text/javascript; charset=utf-8';
  } else if (pathname === `${base}/client.js.map`) {
    file = layout.map;
    type = 'application/json; charset=utf-8';
  } else {
    return false;
  }
  if (file === null) {
    res.writeHead(404);
    res.end();
    return true;
  }
  readFile(file).then((body) => {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }).catch(() => {
    res.writeHead(404);
    res.end();
  });
  return true;
}

/** 默认注入到经代理的 HTML 文档里：crypto.randomUUID polyfill（非安全上下文必需）。 */
export const DEFAULT_INJECT = RANDOM_UUID_POLYFILL;

/** 把浏览器可见的权威改写成 loopback 权威（Host 和 Origin 都改）。 */
function loopbackAuthority(headers, upstream) {
  const authority = `${upstream.host}:${upstream.port}`;
  headers.Host = authority;
  if (headers.origin) headers.origin = `http://${authority}`;
  if (headers.Origin) headers.Origin = `http://${authority}`;
  return headers;
}

/**
 * 启动 dsh-pocket 代理。
 * @param {object} opts
 * @param {number} [opts.port]      监听端口（默认 3081；dsh web 保持 3080）
 * @param {string} [opts.host]      监听地址（默认 0.0.0.0：LAN 与隧道都能到）
 * @param {{host:string,port:number}} [opts.upstream] 上游 dsh web（默认 127.0.0.1:3080）
 * @param {string} [opts.injectHtml] 注入 HTML 的内容（默认 polyfill + 移动端适配；传 '' 关闭）
 * @param {{id:string, file:string, map?:string}|null} [opts.layoutBundle] 桌面高级模式回插的官方布局包（lib/index.js 解析；null/不可读 = 关闭）
 * @returns {Promise<{server:import('node:http').Server, close:()=>Promise<void>}>}
 */
export function createPocketProxy({ port = 3081, host = '0.0.0.0', upstream = DEFAULT_UPSTREAM, log = null, injectHtml = DEFAULT_INJECT, layoutBundle = null } = {}) {
  const layout = normalizeLayoutBundle(layoutBundle, log);
  const server = createServer((req, res) => {
    // 白名单路径的 layout bundle 由本代理直接应答（宿主对 disabled 行 404），其余照常透传
    if (layout && serveLayoutEntry(req, res, layout)) return;
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    const proxyReq = httpRequest(
      { host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers, agent: false },
      (proxyRes) => {
        log?.(`${req.method} ${req.url} -> ${proxyRes.statusCode}`);
        const contentType = String(proxyRes.headers['content-type'] ?? '');
        // 只给**未压缩**的 HTML 文档注入（SSE/WS/JS/CSS 原样透传；压缩流注入会损坏页面）；
        // 注入后修正 Content-Length。layout 回插独立于 injectHtml（后者可能被显式关闭）。
        if ((injectHtml || layout) && contentType.includes('text/html') && !isCompressed(proxyRes.headers)) {
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            let html = Buffer.concat(chunks).toString('utf8');
            if (injectHtml && !html.includes(INJECT_MARK)) {
              html = html.replace(/<head[^>]*>/i, (m) => `${m}${injectHtml}`);
            }
            // 桌面高级模式：把官方 layout 行回插进 boot 图（幂等；见 restoreLayoutEntry）
            if (layout) html = restoreLayoutEntry(html, layout);
            const out = Buffer.from(html, 'utf8');
            const outHeaders = { ...proxyRes.headers };
            delete outHeaders['content-length'];
            delete outHeaders['transfer-encoding'];
            outHeaders['content-length'] = String(out.length);
            res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
            res.end(out);
          });
          proxyRes.on('error', () => res.destroy());
          return;
        }
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
        // 任一端断开都要清理另一端：客户端断连销毁上游流（不留僵尸），
        // 上游流中途断开也要掐断客户端（否则响应头已发、体没发完 → 悬挂）
        res.on('close', () => proxyRes.destroy());
        proxyRes.on('error', () => res.destroy());
        proxyRes.on('close', () => { if (!res.writableEnded) res.destroy(); });
      },
    );
    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`dsh-pocket: 无法连接上游 dsh web（${upstream.host}:${upstream.port}）——先启动 dsh web | ${err.message}`);
    });
    req.pipe(proxyReq);
  });

  // WebSocket upgrade（DSH 的 /api/events.mux + events.host 流式通道）原样透传
  server.on('upgrade', (req, socket, head) => {
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    const proxyReq = httpRequest({
      host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers, agent: false,
    });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      // 原样回传上游的 upgrade 头（Sec-WebSocket-Accept 等）
      const raw = [];
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      }
      socket.write(`${raw.join('\r\n')}\r\n\r\n`);
      if (proxyHead?.length) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
      // 任一端断开都要清理另一端（避免上游残留僵尸连接占用 dsh 连接槽）
      const teardown = () => { try { proxySocket.destroy(); } catch {} try { socket.destroy(); } catch {} };
      proxySocket.on('close', teardown);
      socket.on('close', teardown);
    });
    // 上游返回普通 HTTP 响应（非 101）：把状态码/头回写后断开，别让客户端永久挂起
    proxyReq.on('response', (proxyRes) => {
      if (proxyRes.statusCode === 101) return; // 理论上 101 走 upgrade 事件
      try {
        const raw = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ''}`.trim()];
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        }
        // end 会 flush 响应头再 FIN——不要紧跟 destroy()，否则排队的头会被丢弃
        socket.end(raw.join('\r\n') + '\r\n\r\n');
        proxyRes.resume(); // 消费掉上游响应体，释放连接
      } catch { socket.destroy(); }
    });
    proxyReq.on('error', () => socket.destroy());
    // 关键：浏览器在握手请求后可能立即发出首帧（如 mux 流的初始 RPC），
    // node 把它放在 upgrade 事件的 head 里。必须先于 end() 写入 proxyReq，
    // 让上游在 upgrade 事件里就拿到它（与直连行为一致）；等 101 之后再写
    // 会变成迟到的 socket 数据，DSH 的 mux 协议可能错过这个窗口。
    if (head?.length) proxyReq.write(head);
    proxyReq.end();
    socket.on('error', () => socket.destroy());
  });

  // 跟踪所有 TCP 连接（含 WebSocket upgrade 后的 socket——Node 的
  // closeAllConnections 不包含它们，不手动销毁 close() 会永远等）
  const clientSockets = new Set();
  server.on('connection', (sock) => {
    clientSockets.add(sock);
    sock.on('close', () => clientSockets.delete(sock));
    sock.on('error', () => {}); // 防未处理 error 崩进程
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        close: () => new Promise((r) => {
          for (const s of clientSockets) { try { s.destroy(); } catch { /* 忽略 */ } }
          server.close(() => r());
        }),
      });
    });
  });
}

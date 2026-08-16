// dsh-pocket 插件入口（单包单插件：手机扫码访问 DSH，全在这一个包里）
//
// 设置一级入口「手机访问」：
//   - 局域网二维码：自动显示（代理随插件启动）
//   - 公网二维码：点「开启公网」→ cloudflared 隧道 → 扫码即用，人在外面也能访问
//   - 更新提示：有新版本时显示一键更新按钮（dsh plugin update --latest）
// 手机看到的界面 = 电脑上的 dsh web，实时同步（WebSocket 透传）。
//
// 注：Web Push 已移除——浏览器推送依赖 Google FCM（Chrome）等境外服务，
// 国内直连被墙，普通用户用不了，且排障成本高。专注扫码同屏这一件事。

import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import { createPocketService } from './service.mjs';
import { installPocketRpc } from './web-rpc.js';
import { restartHost } from './restart.js';
import { desktopEnvPatchScript, DEFAULT_INJECT } from './proxy.mjs';

const name = 'dsh-pocket';
const inject = ['connection', 'webServer'];

/** 桌面高级模式下宿主从客户端插件图里禁用的官方布局包（回插用，见 proxy.mjs）。 */
const LAYOUT_PACKAGE = '@deepseek-ai/dsh-client-ui-layout';

/**
 * 解析某包的 `exports["./client"]` 磁盘路径（供代理自托管 bundle）。
 * 从本插件自身位置用 Node 标准提升解析（profile node_modules 里 web-app 的依赖链
 * 必然带该包）。解析失败返回 null——调用方降级关闭回插，手机页面保持现状。
 * @returns {{id:string, file:string, map:string}|null}
 */
function resolveLayoutBundle() {
  const require = createRequire(import.meta.url);
  try {
    const pkgPath = require.resolve(`${LAYOUT_PACKAGE}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const client = pkg?.exports?.['./client'];
    const rel = typeof client === 'string' ? client
      : client && typeof client === 'object' && typeof client.default === 'string' ? client.default
        : null;
    if (!rel) return null;
    const file = join(dirname(pkgPath), rel);
    return { id: LAYOUT_PACKAGE, file, map: `${file}.map` };
  } catch {
    return null;
  }
}

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));

/**
 * 本插件磁盘上的已安装版本。注意：**不能用 require 缓存**（进程内永远不变），
 * 必须实时读文件——一键更新会改写 package.json，「已更新未重启」靠它识别。
 */
function currentVersion() {
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

/** 进程启动时加载的版本（模块加载瞬间固化；用于识别「磁盘已更新但进程还是旧代码」）。 */
const loadedVersion = currentVersion();

const restartNoticeRel = join('dsh-pocket', 'restarted.json');
function restartNoticePath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), restartNoticeRel);
}
async function readRestartNotice() {
  try {
    const raw = JSON.parse(await readFile(restartNoticePath(), 'utf8'));
    if (!raw?.at) return null;
    if (Date.now() - raw.at > 30 * 60 * 1000) return null; // 30 分钟后过期
    return raw;
  } catch { return null; }
}
function writeRestartNotice() {
  return mkdir(dirname(restartNoticePath()), { recursive: true })
    .then(() => writeFile(restartNoticePath(), JSON.stringify({ at: Date.now(), pid: process.pid }), 'utf8'));
}
/**
 * 读重启标记并**删除**（一次性消费）：重启后首次打开设置页显示一次「已重启」横幅，
 * 之后不再出现——否则残留文件会让「已重启」一直显示（用户没点重启也误报）。
 */
async function consumeRestartNotice() {
  const notice = await readRestartNotice();
  if (notice) {
    await rm(restartNoticePath(), { force: true }).catch(() => {});
  }
  return notice;
}
/**
 * 自重启。
 * 顺序很重要：先拉起 helper（失败就如实返回，不写标记、不停隧道）→ 停公网隧道
 * （否则孤儿 cloudflared 让旧公网 URL 永活，与「重启即换 URL 作废」的宣传矛盾）→
 * 写重启标记（新进程据此显示一次「已重启」横幅）。
 */
function pocketRestart(service) {
  const result = restartHost();
  if (!result || result.helperPid == null) return result; // helper 都没 spawn 出来 → 失败
  try { service?.stopTunnel(); } catch { /* 忽略 */ }
  writeRestartNotice().catch(() => {});
  return result;
}

/** 执行更新：dsh plugin --profile <p> update dsh-pocket --latest -w（超时保护）。 */
function performUpdate(profile, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('dsh', ['plugin', '--profile', profile, 'update', 'dsh-pocket', '--latest', '-w'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (c) => { out += String(c); if (out.length > 4000) out = out.slice(-4000); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: out.slice(-800) });
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}

export function apply(ctx, config = {}, internals = {}) {
  const logger = ctx.logger?.(name) ?? console;
  const dshPort = internals.dshPort ?? ctx.webServer?.port;
  if (!dshPort) {
    logger.error('dsh-pocket: webServer port unavailable — cannot start proxy | 拿不到 dsh web 端口，无法启动代理');
    return () => {};
  }

  // 桌面端环境识别（官方兼容模式，见 desktop 的 plugin-development.md）：
  // desktopProfiles / desktopPnpm 只在 DSH Desktop（Electron）里存在。
  // 桌面端有自己的更新/进程管理，我们这两项功能在此环境**关闭**（不删除），
  // 避免与 desktopPnpm / Electron 进程模型冲突；扫码同屏等正常功能照常。
  const isDesktop = internals.isDesktop !== undefined
    ? internals.isDesktop === true
    : ctx.get?.('desktopProfiles') !== undefined || ctx.get?.('desktopPnpm') !== undefined;
  if (isDesktop) {
    logger.info('dsh-pocket: DSH Desktop detected — update/restart disabled here | 检测到桌面端环境，更新/重启已关闭');
  }

  // 桌面高级模式回插：宿主在 advanced 模式下禁用官方 ui-layout（客户端图里没有
  // layout 提供者），手机又被迫 compatibility（desktop client no-op）→ boot 报
  // "waiting for service: layout"。把官方布局包解析出来交给代理（回插 boot 图 +
  // 自托管 bundle），零改动 desktop 即恢复兼容模式的官方布局。解析失败只告警。
  const layoutBundle = isDesktop ? resolveLayoutBundle() : null;
  if (isDesktop) {
    if (layoutBundle) {
      logger.info('dsh-pocket: layout restore enabled (%s) | 桌面高级模式布局回插已启用', LAYOUT_PACKAGE);
    } else {
      logger.warn('dsh-pocket: %s not resolvable — advanced-mode phones keep showing "waiting for service: layout" | 布局包解析失败，高级模式手机访问仍会报错', LAYOUT_PACKAGE);
    }
  }

  const service = internals.service ?? createPocketService({
    dshPort,
    port: internals.port ?? config.port ?? 3081,
    home: internals.home,
    internals,
    // 桌面端：手机扫码访问的页面缺 dsh-desktop-mode/platform 参数会让 dsh-plugin-desktop
    // client 崩溃（issue #3/#4）。给代理注入「桌面参数补丁」（history.replaceState 补齐参数，
    // 无跳转；compatibility 模式不套桌面布局，避免移动端按钮叠加）。保留默认 polyfill。
    injectHtml: isDesktop ? DEFAULT_INJECT + desktopEnvPatchScript(process.platform) : undefined,
    ...(layoutBundle ? { layoutBundle } : {}),
  });

  const disposers = [];
  const disposeRpc = installPocketRpc(ctx, {
    service,
    desktop: isDesktop,
    runUpdate: internals.runUpdate ?? { currentVersion, perform: performUpdate, loadedVersion: () => loadedVersion },
    restart: internals.restart ?? (() => pocketRestart(service)),
    restartNotice: internals.restartNotice ?? consumeRestartNotice,
    log: logger,
  });
  disposers.push(disposeRpc);

  // 代理随插件自动启动（局域网二维码开箱即用，零配置）
  void service.startProxy().then((proxy) => {
    logger.info('dsh-pocket: proxy ready on :%d | 局域网代理已就绪', proxy.port);
  }).catch((err) => {
    logger.error('dsh-pocket: proxy start failed | 代理启动失败: %s', err?.message ?? err);
  });

  ctx.effect(() => async () => {
    for (const d of disposers.reverse()) { try { d(); } catch { /* 忽略 */ } }
    await service.dispose();
  }, 'dsh-pocket: stop proxy and tunnel');
}

export { name, inject, readRestartNotice, consumeRestartNotice };

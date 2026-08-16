<p align="center">
  <img src="docs/banner.jpg" alt="DSH Pocket" width="100%">
</p>

<h1 align="center">DSH Pocket</h1>

<p align="center"><a href="README.en.md">English</a> | <a href="README.md">中文</a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pocket"><img alt="npm" src="https://img.shields.io/npm/v/dsh-pocket?color=4d6bfe&label=npm"></a>
  <a href="https://www.npmjs.com/package/dsh-pocket"><img alt="downloads" src="https://img.shields.io/npm/dm/dsh-pocket?color=4d6bfe"></a>
  <a href="https://github.com/shaobeichen/dsh-pocket/actions"><img alt="CI" src="https://github.com/shaobeichen/dsh-pocket/actions/workflows/npm-publish.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-GPL--2.0-red.svg"></a>
  <a href="https://github.com/shaobeichen/dsh-pocket/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/shaobeichen/dsh-pocket"></a>
  <a href="https://awesome-dsh-plugin.com/zh/"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
</p>

> 把 **DeepSeek Harness 装进你的口袋**：一个包、一个设置页，手机扫二维码就实时看到电脑上的同一个界面——人在外面也能用。

## 这是什么

**你不在电脑前，也想用电脑上的 DeepSeek Harness。**

- 下班路上，agent 在电脑上跑任务，你想掏出手机看看它干到哪了、结果如何
- 出门在外，突然想让电脑上的 agent 查点资料、写段代码，但没有远程桌面、没有 SSH
- 电脑在宿舍/办公室，你人在外面，想随时"操控你的 DeepSeek Harness"——发任务、看输出、点审批

DSH Pocket 就是干这个的：**装上它，手机扫个码，就能实时看到并操控电脑上的 DeepSeek Harness 界面**——人在外面也能用。

实际效果——手机上的界面就是电脑上的界面，实时同步：

<p align="center">
  <img src="docs/interface.jpg" alt="手机上的 DSH 界面" width="100%">
</p>

## ✨ 特性

| 特性 | 说明 |
|---|---|
| 📶 局域网扫码 | 装好即用：设置 → 插件 → 手机访问，打开就有局域网二维码，手机连同一 WiFi 扫码即开 |
| 🌐 公网扫码（人在外面） | 点「开启公网访问」→ cloudflared 隧道 → 出公网二维码，4G/任何网络都能访问 |
| ⚡ 实时同步 | 流式输出走 WebSocket 全透传——**电脑上在输出，手机上同步在滚**，可双向操作 |
| 📱 移动端适配 | 窄屏自动变抽屉布局（移植 dsh-web-mobile，MIT）：侧栏抽屉、会话全宽、状态栏安全区、触控优化 |
| 🧩 零依赖安装 | 一个 npm 包、一个设置页，没有核心/适配器要分开装；无需账号、无需服务器 |
| 🔒 URL 即钥匙 | 无公网 URL 暴露给第三方（局域网模式）；公网 URL 每次重启自动换新 |

## 🚀 怎么用

**入口在哪**：安装完成并重启 `dsh web` 后，打开 **设置**，左侧边栏就能看到 **「手机访问」** 入口（和「通用设置」「模型」同级）：

<p align="center">
  <img src="docs/entry.jpg" alt="手机访问入口" width="70%">
</p>

**前提**：电脑上已装好 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。如果终端提示 `dsh: command not found`（找不到 dsh 命令），先安装：

```sh
npm install -g @deepseek-ai/dsh     # 全局安装；验证：dsh --version
# 不想全局装？每次命令前加 npx：npx @deepseek-ai/dsh <命令>
```

```sh
# 1. 装插件（一个包全都有）
dsh plugin --profile web add dsh-pocket -w

# 2. 重启 dsh web
npx @deepseek-ai/dsh web
```

### 局域网（同一 WiFi）

设置 → 插件 → **手机访问** → 手机扫「📶 局域网」二维码 → 打开的就是电脑上的 DSH，实时同步。

### 公网（人在外面）

同一页点「**开启公网访问**」→ 等隧道建立（首次会下载 cloudflared）→ 手机扫「🌐 公网」二维码 → 人在外面（4G/公司网）也能访问。

> 更新到新版本：`dsh plugin --profile web update dsh-pocket --latest -w`（跨大版本时 `--latest` 是必须的，`^0.x` 范围不会自动升到 1.x）。

## ⚠️ 安全（必读）

- **DSH 能执行你电脑上的代码**。二维码/URL 就是钥匙，**请勿把二维码或 URL 发给任何人**
- 公网 URL 由 cloudflared 随机分配，**每次重启会变化**（旧链接自动失效，相当于天然轮换）
- 局域网模式不暴露公网，只有同一网络内的设备能访问
- 适合个人自用；多设备/分享场景后续会加访问令牌

## 🩹 常见问题（别踩的坑）

| 现象 | 原因与解决 |
|---|---|
| `dsh: command not found` / 提示 DSH 未定义 | dsh CLI 没装：`npm install -g @deepseek-ai/dsh`，或命令前加 `npx @deepseek-ai/dsh` |
| `ERR_PNPM_ADDING_TO_ROOT` | pnpm 9 对 workspace 根的限制：安装/更新命令**末尾加 `-w`**（`--workspace-root`） |
| 装完/更新了但界面没变化 | **必须重启 `dsh web`** 才生效；运行中的进程仍加载旧代码 |
| `listen EADDRINUSE ... :3081` | 旧 dsh-pocket 进程还占着端口：macOS/Linux `lsof -ti :3081 \| xargs kill -9`；Windows `netstat -ano \| findstr :3081`（找 LISTENING 的 PID）→ `taskkill /PID <PID> /F`，后重试 |
| 版本停在 0.x 升不上去 | `^0.x` 范围不允许升到 1.x：更新用 `--latest`（`dsh plugin --profile web update dsh-pocket --latest -w`） |
| 公网 `error 1033` | 见下方「公网隧道常见问题」——多半是本机代理/VPN（Clash 等 TUN 模式）掐断了隧道 |
| 桌面版高级模式手机白屏 `Failed to load plugins` / `waiting for service: layout` | v1.4.8 起自动修复：桌面版 `dsh-desktop.mode: advanced` 会禁用官方布局插件，手机又被本插件强制 compatibility，两端都没有 layout 服务 → boot 失败。代理现在会把官方 `@deepseek-ai/dsh-client-ui-layout` 回插进手机页面的插件图并自托管其 bundle（**桌面端零改动**），手机恢复官方布局 + 完整移动端适配。v1.4.9 继续修复窄屏下会话标题、正文、composer 控件和状态行的横向溢出。更新到 ≥1.4.9 并重启即可 |
| 点「重启 dsh web」后页面提示进程在后台运行 | 自重启的新进程是 detached 后台进程（不挂终端），是页内更新的标准做法；停止它：macOS/Linux `lsof -ti :3080 \| xargs kill -9`；Windows `netstat -ano \| findstr :3080` → `taskkill /PID <PID> /F`（日志在 `$DSH_HOME` 下 `dsh-pocket-restart-*.log`） |

## ⚠️ 公网隧道常见问题（必读）

**现象**：点「开启公网访问」后，手机上打开公网地址报 `error 1033`（Tunnel error）。

**最常见原因：本机开着代理/VPN（Clash、Surge、v2ray、sing-box 等，尤其 TUN 模式）**。
这类工具会接管全部流量，并常常把 cloudflared 的隧道边缘连接
（`*.argotunnel.com`、Cloudflare 边缘 IP）掐断，导致隧道注册成功但数据面连不上。

**解决（从轻到重，按顺序试）**：

1. 先**只关闭代理的 TUN 模式**，不用退出代理软件——多数情况这一步就够：
   - Clash：设置里关掉「**TUN 模式**」开关（或右键菜单栏图标 → 取消勾选 TUN 模式）
   - Surge：关「**增强模式**」；v2ray/sing-box：关「**虚拟网卡/路由接管**」
   - 然后回设置页重新点「开启公网访问」
2. 仍不行就**彻底退出代理软件**（不只是关界面：Clash 要右键菜单栏图标 → 退出；若装有
   后台服务还要在服务管理器里停掉，`ps aux | grep clash` 确认进程消失），再重试
3. 给代理加**直连规则**，放行隧道域名与 Cloudflare 边缘（Clash 规则示例）：
   ```yaml
   - DOMAIN-SUFFIX,argotunnel.com,DIRECT
   - DOMAIN-SUFFIX,trycloudflare.com,DIRECT
   - IP-CIDR,198.41.192.0/24,DIRECT,no-resolve
   ```
4. 网络实在不通时，改用**局域网模式**：手机开热点 → 电脑连手机热点 → 扫局域网码，
   效果完全一样（人在外面也能用）

**其他可能**：企业防火墙/校园网拦截出站；此时请让 IT 放行或改用热点。

**首次开启时「下载 cloudflared」失败/卡住**：
- **macOS/Linux**：优先走**清华镜像**（实测 ~3MB/s，几秒下完）；失败自动回退官方 GitHub + 加速源。
- **Windows**：无清华镜像（Homebrew 不支持 Windows），走官方直连下载（约 50MB，**单线程会慢，属正常**，耐心等几分钟；也可挂代理加速）。
- 全部失败时设置页会给出提示。备选方案（任选其一）：
1. 手动装好命令行 cloudflared 后重试（装好后 dsh-pocket 直接用 PATH 里的，不再下载）：
   - macOS：`brew install cloudflared`；Linux：`sudo apt install cloudflared` 或官网下载
   - Windows：`winget install cloudflared` 或官网下载
   - 任何平台：`npm i -g cloudflared`
2. 挂代理（系统代理/Clash 等）后重新点「开启公网访问」
3. 手动下载二进制放到 `$DSH_HOME/dsh-pocket/bin/` 目录（`$DSH_HOME` 一般是 `~/.dsh`，Windows 是 `%USERPROFILE%\.dsh`）

## 🗂 架构（单包）

| 文件 | 说明 |
|---|---|
| `lib/index.js` | 插件入口：自动起代理 + 注册 RPC（`inject: connection, webServer`） |
| `lib/service.mjs` | 服务：代理生命周期、公网隧道、状态快照（含二维码 data URL） |
| `lib/proxy.mjs` | 改头反向代理：Host/Origin → loopback，HTTP + WebSocket 全透传 + polyfill 注入；桌面高级模式下回插官方 layout 插件行并自托管其 bundle |
| `lib/tunnel.mjs` | cloudflared 快速隧道：下载/解压/启动/解析公网 URL（HTTP/2） |
| `lib/web-rpc.js` | loopback RPC：`status` / `tunnel.start` / `tunnel.stop` / `version` / `update` / `restart` |
| `client/` | 设置页「手机访问」+ 移动端适配（dsh-web-mobile 移植） |
| `bin/dsh-pocket.mjs` | CLI：局域网/公网模式，打印 URL + 二维码 |

## 🛠 开发

```sh
npm install
node client/build.mjs   # 改 client/ 后重新打包
npm test                # 代理改写 / WS 透传 / 隧道 / 服务 / RPC（7 测试）
```

## 🤝 致谢

- 移动端适配移植自 [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)（MIT）
- 公网隧道基于 [cloudflared](https://github.com/cloudflare/cloudflared)

## 📄 License

[GPL-2.0](LICENSE) —— 自由软件许可：可自由使用、修改、分发，但**修改版必须同样以 GPL 开源**并保留版权声明；商用同样适用。

> 说明：移动端适配部分移植自 [dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)（MIT 许可，兼容 GPL），其版权声明保留在 `client/mobile/LICENSE.dsh-web-mobile`。

---

**有问题？欢迎反馈**：遇到 Bug、有想法、想提需求，请到 [GitHub Issues](https://github.com/shaobeichen/dsh-pocket/issues) 告诉我们 🙏

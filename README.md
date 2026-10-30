# Remote DSH Panel

把一台远程 Linux 机器上的 DeepSeek Harness **直接嵌进桌面应用的侧边栏面板**：左侧一个「远程 DSH」入口，点开选主机，远端那套会话 / 工作区 / 文件都在面板里，就像本地的一样。

> A DeepSeek Harness (DSH) plugin that runs a **remote** harness inside the desktop app's own window: SSH bootstrap, on-demand remote `dsh` install, loopback tunnel, and a same-machine gateway that serves the remote UI to a panel iframe.

---

## 为什么需要这层网关

DSH 桌面壳的页面来自自定义 scheme `dsh-app://app`，而远端 `dsh web` 是 `http://127.0.0.1:<port>`。直接把远端塞进 iframe 会遇到两个死结：

1. **登录 cookie 跨不过去**：远端的鉴权 cookie 是 `SameSite=Strict`，在 `dsh-app://` 的第三方上下文里根本不会被发送 → 页面 401；
2. **cookie 还绑定 authority**：`Set-Cookie` 的 payload 里写着 `127.0.0.1:<远端端口>`，端口一变就失效。

所以本插件不让浏览器碰 cookie：

```
桌面壳 (dsh-app://app)
  └─ iframe → http://127.0.0.1:<网关端口>/         ← 本机 http，无需任何 cookie
        └─ 网关（插件宿主进程内）
              ├─ 自己完成 ?token= → Set-Cookie 的换取
              ├─ 转发 HTTP（重写 Host/Origin/Referer，带上远端 cookie）
              ├─ 转发 WebSocket（/api/remote.mux，原样升级）
              └─ 注入 Esc 桥接脚本（见下）
                    └─ 本地隧道 127.0.0.1:<随机> → 远端 127.0.0.1:<dsh web 端口>
                          └─ SSH 连接 → ssh2.forwardOut()
```

所有远程操作都走 SSH，因此**远端只需要把 `dsh web` 绑在 127.0.0.1**，不需要暴露到局域网，也不需要额外装任何 helper。

## 功能

| 能力 | 说明 |
| --- | --- |
| 主机列表 | 自动复用 `~/.dsh/dsh-ssh.json` 里已配置的 SSH 主机（标记「SSH 插件」），也可以在面板里自己添加（标记「本面板」） |
| 添加主机 | 名称、主机/IP、SSH 端口、用户名、密码、远端 `dsh web` 端口、安装用代理（可选） |
| 连接测试 | 只探测、不安装不启动：SSH 是否通、Node 版本、远端 dsh 版本是否与本地一致、远端 dsh web 是否在跑，并给出耗时 |
| 删除主机 | 本面板添加的直接删除；来自 SSH 插件的会在确认后同时从 `~/.dsh/dsh-ssh.json` 移除 |
| 自动安装 | 远端没有 dsh 或版本不一致时，自动 `npm i -g --prefix "$HOME/.local" @deepseek-ai/dsh@<本地版本>`，安装过程有阶段提示与耗时 |
| 自动启动 | 确保远端 `dsh web` 在跑；没跑就 `nohup ... --host 127.0.0.1 --port <webPort> --no-open` 拉起来（最多等 40 秒） |
| 会话内嵌 | 面板里直接是远端 DSH，可重新加载 / 断开 |
| 放大 | 面板铺满整个窗口（保留 Windows 三个窗口按钮与任务栏），按 `Esc` 退出 |
| 剪贴板 | iframe 显式委派 `clipboard-read; clipboard-write`，远端「复制链接」可用；另外提供「在新窗口打开」作为兜底 |
| 自动恢复 | 远端 401（例如重启换了 token）时网关自动重读 token 并重试一次 |

## 安装

### 从 GitHub 安装（推荐）

```sh
dsh plugin --profile desktop add github:1583477320/remote-dsh
```

装完**完全退出 DSH 桌面应用**（托盘也要退）再打开，左侧出现「远程 DSH」。

- 依赖 `ssh2` 由安装器一并装好；
- 如果你的 dsh 版本不接受 git 规格，用下面的本地克隆方式；
- 本包**暂未发布到 npm**（registry 上的 `dsh-remote-panel` 属于另一位作者的不同项目），所以不要用 `add dsh-remote-panel`。

### 从本地克隆安装（开发 / 离线）

```sh
git clone https://github.com/1583477320/remote-dsh.git
cd remote-dsh
dsh plugin --profile desktop add link:$(pwd)
```

`link:` 会建软链指向仓库目录：改代码后**完全退出应用再打开**即生效（客户端 bundle 带 rev，必须重启才会刷新）。

### 手动安装（等价做法）

1. 把本仓库放到 profile 的 `node_modules` 下：

   ```sh
   cp -r . ~/.dsh/profiles/desktop/node_modules/dsh-remote-panel
   ```

2. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: remote-dsh
         name: dsh-remote-panel
   ```

3. 完全退出 DSH 桌面应用（托盘也要退）后重新打开，左侧出现「远程 DSH」。

> 插件依赖 `ssh2`。若手动拷贝，请确认 profile 的 `node_modules` 里能解析到 `ssh2`（`dsh plugin add` 会自己装依赖）。

## 使用

1. 左侧点「远程 DSH」；
2. 选一台主机，先点 **测试** 看环境（推荐，尤其新机器）：

   ```
   SSH 正常 · Node v24.18.0 · dsh 未安装（连接时会自动安装） · 远端 dsh web 未运行（连接时会启动） · 842ms
   ```

3. 点 **连接**，首次会经历：`SSH → 检查环境 → 安装 dsh（如需）→ 启动 dsh web → 建立通道`，面板会在每一步显示阶段与已用秒数；
4. 连上后：**重新加载** / **放大**（`Esc` 退出）/ **在新窗口打开** / **断开**；
5. 远端 DSH 是独立登录态，第一次需要在那套界面里登录一次 DeepSeek 账号（或用 API key）。

## 主机字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `label` | 主机地址 | 列表里显示的名称 |
| `host` / `sshPort` | — / `22` | SSH 目标 |
| `user` / `password` | — | SSH 凭据（也支持复用 dsh-ssh 的密钥条目） |
| `webPort` | `18080` | 远端 `dsh web` 监听端口（仅 127.0.0.1） |
| `installProxy` | 空 | 自动安装时使用的 HTTP 代理；留空会尝试探测远端 `127.0.0.1:7890` |
| `dshBin` | `~/.local/bin/dsh` | 远端 dsh 可执行文件（环境变量 `DSH_BIN` 可覆盖探测） |
| `webLog` | `~/.dsh/logs/dsh-web.log` | 远端 `dsh web` 日志（token 从这里读） |

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_REMOTE_HOST` / `DSH_REMOTE_PORT` | 覆盖内置示例主机（仅调试用） |
| `DSH_REMOTE_STATE_URL` | 覆盖远端 helper 地址（兼容早期的 `/state` 模式） |
| `DSH_BIN` | 远端 dsh 路径 |

## 数据与安全

- 面板添加的主机保存在 `~/.dsh/remote-dsh.json`，权限 **0600**，密码为明文（与 dsh-ssh 的 `~/.dsh/dsh-ssh.json` 同一套信任模型）；
- 远端 `dsh web` 只监听 `127.0.0.1`，不暴露到局域网；
- 网关只监听 `127.0.0.1:<随机端口>`，且**自身持有**远端 session cookie：访问该端口的本机进程等价于“已登录远端”，插件卸载/断开时随会话关闭；
- 启动令牌（`?token=`）只在宿主进程内使用，从不下发到浏览器；
- 远端 401 时网关自动重新换取 cookie。

## 已知限制

- 远端必须是 Linux（Windows/macOS 未验证），需要 Node `^22.19 || >=24` 与 `npm`；
- **远端 dsh 版本必须与本地 client 完全一致**：client 的 Remote 能力集合是构建期固定的，跨版本连不通，所以插件安装时会 pin 到本地版本；
- `npm` 默认跳过 install scripts 时，远端 DSH 的**终端**可能不可用（`node-pty` 原生模块未编译），Web UI 本身不受影响；
- 每个主机同一时刻只保留一条会话；断开只关本地隧道与网关，不杀远端进程；
- 剪贴板依赖 iframe 的权限委派；若桌面壳的安全策略仍拒绝，请用「在新窗口打开」或手动选中 + `Ctrl+C`；
- 放大模式的退出方式为 `Esc`（网关注入的桥接会把远端页面里的 Esc 传回外层）；远端弹窗打开时 Esc 归弹窗使用。

## 源码地图

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 宿主入口：`/api/remote-dsh/{hosts,connect,disconnect,state,test}` 路由、连接任务与阶段状态 |
| `lib/hosts.js` | 主机存储（`remote-dsh.json`）与 `dsh-ssh.json` 的读取/删除 |
| `lib/remote.js` | 一次会话：SSH 连接 → 环境检查 → 自动安装 → 启动/复用 `dsh web` → 读 token → 隧道 → 网关 |
| `lib/gateway.js` | 本机网关：cookie 换取、HTTP/WebSocket 转发、HTML 注入（Esc 桥接）、gzip 处理、401 自愈 |
| `lib/client.js` | 浏览器半区：侧边栏入口、主机列表/表单、连接阶段轮询、iframe 内嵌、放大与 Esc |

## 开发提示

- 客户端 bundle 是**经典脚本**，用 `window.__ModuleLoader__.load({ id, factory })` 包装，`factory` 里 `require('react')`，返回带 `apply` / `inject` 的 `module.exports`；
- 改了 `lib/client.js` 或宿主文件都需要**完全退出应用**再打开（客户端 bundle 带 rev，宿主在启动时加载插件）；
- 面板注册使用官方扩展点：`ctx.slots.inject('sidebar.panellist', …)` 与 `ctx.slots.inject('main', …)`。

## License

Apache-2.0

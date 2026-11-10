# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.1] - 2026-11-10

修复首次单屏试跑暴露的问题。核心是一条：**页面必须通过自定义协议加载，否则 PDF 永远打不开**。

### 修复

- **PDF 加载失败（DOMException）**：`file://` 页面的 origin 是 `null`，Chromium 拒绝从 `null` origin 构造 Worker，pdf.js 的 `new Worker(file:///.../pdf.worker.min.js)` 抛 SecurityError。
  改为注册标准协议 `screendeck://`，页面拥有真实 origin，Worker / fetch / CSP 全部正常。
  协议处理器做了路径越界校验（`realpath` + `isInside`），并内置正确的 MIME 映射。
- **CSP 收紧**：去掉 `file:`、`data:` 等宽松例外，改为 `default-src 'self'`，只保留 `blob:`（图片预览与 pdf.js 需要）。
- **中文 PDF 缺字**：补上 pdf.js 的 `cMapUrl` 与 `standardFontDataUrl`（指向本地 `node_modules/pdfjs-dist` 资源）。
- **大屏窗口被关掉后无法恢复**：单屏测试模式的输出窗口带边框和关闭按钮，关掉后「显示大屏」按钮会失效。
  现在 `toggleOutput()` 在窗口已销毁时负责重建。
- **单击映射窗看不到反馈**：激光点原先只画在大屏上，映射窗没有任何提示，容易被当成"单击无效"。
  现在映射窗内也绘制同一位置的点，两边同时出现。

### 改进

- 映射窗标题栏增加 ⠿ 抓取符号，高度 32→36px；空状态提示改为「拖动上方 ⠿ 标题栏可移动，拖边框缩放」。
- 单屏模式输出窗口改为 1024×576 带边框可拖动窗口（原先 960×540 无边框且不可缩放，单屏时无法挪开）。
- `Viewer` 支持传入自定义空状态提示文案。
- 补 `scripts/launcher.js`、`scripts/preflight.js` 与一键启动脚本。

## [0.1.0] - 2026-11-10

首个可用版本。模块 1~5 全部落地，架构以「主进程共享状态 + 双视图」为基石。

### 新增

**模块 1 · 双窗口与多屏定位**
- `screen.getAllDisplays()` 枚举显示器，主屏创建控制台窗口，面积最大的横屏副屏创建无边框全屏输出窗口。
- 显示器热插拔（`display-added` / `display-removed` / `display-metrics-changed`）时自动重新定位输出窗口。
- 两个窗口统一 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`。
- 单实例锁，避免两个进程抢同一块大屏、互相覆盖配置。

**模块 2 · 本地映射窗**
- 控制台内 HTML/CSS 浮层，可拖动标题栏移动、拖 8 个边角手柄缩放、双击标题栏最大化/还原。
- 映射窗内容是与大屏共享状态的第二个 `Viewer` 实例，不是截图；缩放后由矢量重渲染保证清晰。
- 位置、尺寸、最大化状态持久化，重启后恢复。

**模块 3 · 内部内容源**
- 集成 pdf.js（3.11.174，精确锁定）渲染 PDF，marked（4.3.0，UMD）渲染 Markdown，另支持常见图片格式。
- 大屏与映射窗从同一份状态读取页码 / 滚动位置 / 缩放，同步渲染。
- 映射窗手势：上下拖=滚动，左右拖=翻页（PDF）或切换章节（Markdown），滚轮=滚动，Ctrl+滚轮=缩放映射窗内容，单击=激光点。
- 激光点用 0~1 归一化坐标，主进程 2.2 秒后自动消退。
- 快捷键：`←/→` 或 `PageUp/PageDown` 翻页、`+/-` 缩放、`0` 复位、`Esc` 收起激光点。

**模块 4 · 外部窗口源（只读镜像）**
- `desktopCapturer.getSources()` 枚举窗口，带缩略图列表。
- 通过 `setDisplayMediaRequestHandler` 指定捕获源，大屏与映射窗复用同一路流。
- 捕获列表过滤 ScreenDeck 自身窗口，避免递归捕获。
- 映射窗内事件不注入第三方窗口。

**模块 5 · 内容源切换与持久化**
- 侧栏「文档 / 窗口」两个 Tab，点击即切换内容源，当前项高亮。
- 打开文档走系统文件对话框，支持多选，逐个校验并记录失败原因。
- 状态落盘 `userData/screendeck-state.json`：窗口布局、映射窗位置大小、上次内容源、偏好设置；写入用 tmp + rename 原子替换。
- 下次启动自动恢复上次的文档与阅读位置。

### 安全

- 所有用户文件路径先 `fs.realpath` 再校验，使用 `path.relative` 判断包含关系，禁止字符串前缀匹配。
- 每次读取文档重新 realpath + stat，规避 TOCTOU。
- 删除工具先扫描 junction / reparse point，发现链接即拒绝递归删除，只允许 `rmdir` 移除链接本身。
- `.npmrc` 设置 `install-strategy=hoisted`（npm 原生扁平安装策略，不创建链接；早期草稿用的 `nodeLinker=hoisted` 是 pnpm 配置，会让 npm 报警告，已替换）。
- 渲染层禁用 `window.open` 与新窗口导航。
- **junction 识别修正**：实测 Windows 上 junction 的 `lstat().isSymbolicLink()` 为 `false`、`readlink()` 报 `EINVAL`，原判据会漏判。改为「`realpath` 与自身路径不一致」判据，并同步修正 `paths.isLink`。
- **删除实现改造**：不再使用 `fs.rm({ recursive: true })`，改为自底向上逐项删除，每项删除前重新 `lstat` + `realpath` 复核，发现链接立即中止（fail-closed）。
- **删除禁区**：拒绝删除盘根、`%SystemRoot%`、Program Files、ProgramData、用户目录根等；支持 `allowRoots` 白名单。
- **读取改为句柄**：`readUserFile` 走 `open → fstat → read → close`，校验与读取作用于同一句柄，消除「校验后路径被换成链接」的窗口。
- **渲染串行化**：`Viewer.apply` 改为只渲染最新状态并串行排空，避免连续拖动时多帧争用同一 canvas。
- 控制台窗口关闭即退出应用，避免大屏窗口独自残留在副屏。
- 白屏自诊断：页面内置 `#boot-fallback` 静态提示，脚本加载失败时仍可见。

### 已知问题

- 映射窗事件不注入第三方窗口（模块 4 只读，符合设计）。
- 没有标题的 Markdown 文档，横向拖拽退化为整篇滚动。
- 单屏环境下大屏窗口为窗口模式，不是全屏。

### 依赖

| 包 | 版本 | 用途 |
|---|---|---|
| electron | 33.4.11 | 桌面运行时（devDependency） |
| pdfjs-dist | 3.11.174（精确锁定） | PDF 渲染；v4/v6 在渲染进程有 Web Streams 兼容问题 |
| marked | 4.3.0 | Markdown 渲染；v5+ 仅 ESM，本项目无打包器故锁 4.x 的 UMD 构建 |

## [未发布]

### 计划

- 映射窗事件注入第三方窗口（需平台级输入注入，涉及权限与安全评审）。
- Markdown 章节支持自定义锚点与目录侧栏。
- 演示者备注与计时器。
- 打包分发（electron-builder）。

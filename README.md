# ScreenDeck

> 跨屏演示控制台 —— 演讲者在一屏自由工作，内容干净地输出到另一屏。

当前版本：**0.1.0**

## 它解决什么问题

做演示时常见的尴尬：把 PDF 投到大屏，就得占住一台电脑；用屏幕镜像，又把桌面上的通知、聊天记录一起投出去。

ScreenDeck 的做法是：**内容只渲染一次，输出到两处**。主进程持有一份文档状态（当前页、滚动位置、缩放、激光点坐标），大屏输出窗口和本地映射窗都是这份状态的视图。你在映射窗里拖一下，改的是同一份状态，大屏立刻跟着变——全程没有任何截屏。

## 功能

| 模块 | 能力 |
|---|---|
| 1 · 双窗口多屏定位 | `screen.getAllDisplays()` 枚举显示器；主屏常规控制台窗口，副屏无边框全屏输出；两个窗口均 `nodeIntegration: false` + `contextIsolation: true` |
| 2 · 本地映射窗 | 控制台内可拖动、拖边缘缩放、双击标题栏最大化/还原的浮层；内容是与大屏共享状态的第二个渲染视图，正交缩放不糊 |
| 3 · 内部内容源 | PDF（pdf.js）、Markdown（marked）、图片；映射窗内上下拖=滚动、左右拖=翻页/换章、滚轮=滚动、Ctrl+滚轮=放大映射窗内容、单击=激光点 |
| 4 · 外部窗口源 | `desktopCapturer` 只读镜像第三方窗口到大屏，映射窗显示同一路流的缩小版；**映射窗事件不注入对方窗口** |
| 5 · 切换与持久化 | 文档/窗口列表快速切换；窗口布局、映射窗位置大小、上次内容源、偏好设置落盘 JSON |

## 快速开始

要求 Node.js `^22.19.0 || >=24.0.0`（本项目在 v24.22.2 上验证）。

```powershell
npm install
npm start        # 或 npm run dev（开启 DevTools）
npm run check    # 只做语法检查，不启动
npm test         # 逻辑冒烟测试（21 项，不需要 GUI）
```

> 启动脚本走 `scripts/launcher.js`：首次运行时会把 Electron 运行时复制到
> `D:\Softwares\ScreenDeck\electron-runtime\<版本>`（该位置不可写时退回
> `%LOCALAPPDATA%\ScreenDeck\runtime\<版本>`），之后从那里启动。
> 原因是 Chromium 在某些带特殊权限项的工作区目录里启动会断言失败（详见 NOTES.md）。
> 若你的环境没有这个问题，可以用 `npm run start:direct` 直连 `node_modules` 里的运行时。

### 一键启动（Windows）

不想记命令就直接双击：

| 文件 | 用途 |
|---|---|
| `ScreenDeck.cmd` | 正常启动 |
| `ScreenDeck-Dev.cmd` | 调试启动（自动打开 DevTools） |

脚本会自己 `cd` 到项目目录、检查 Node（PATH 里没有就用 `D:\Softwares\node\node.exe`）、
调用 launcher；失败时窗口会停住并打印退出码和启动日志路径，方便贴反馈。

想放到桌面：右键 `.cmd` → 发送到 → 桌面快捷方式。

单屏环境也能启动：检测不到第二块屏幕时，输出窗口退化为 1024×576 的**带边框可拖动窗口**，方便单屏调试和录屏。

## 目录结构

```
src/
├─ main/                 主进程
│  ├─ main.js            应用生命周期、单实例锁、启动日志
│  ├─ windows.js         控制台窗口 / 大屏输出窗口、显示器热插拔
│  ├─ state.js           共享文档状态（唯一真相来源）+ 数值夹紧
│  ├─ sources.js         PDF/Markdown/图片/外部窗口 的内容源注册表
│  ├─ ipc.js             IPC 白名单、激光点自动消退、捕获源选择
│  ├─ app-protocol.js    screendeck:// 自定义协议（worker/CSP 需要真实 origin）
│  ├─ store.js           状态持久化（tmp + rename 原子写）
│  ├─ paths.js           路径安全：realpath + 相对路径包含判断
│  └─ safe-remove.js     删除安全：先扫 junction/reparse point
├─ preload/              contextBridge 白名单 API（控制台 / 大屏各一份）
└─ renderer/
   ├─ common/viewer.js   两个视图共用的渲染器
   ├─ output/            大屏视图：内容 + 激光点
   └─ console/           控制台：内容源列表 + 映射窗浮层
```

## 关键设计决定

**为什么不用截屏。** `desktopCapturer` 抓自己的窗口会带来三重代价：延迟、分辨率损失、以及递归捕获（映射窗里出现映射窗）。共享状态 + 双视图在架构上就不存在这三个问题。

**为什么状态在主进程。** 两个渲染进程如果各存一份，就要处理冲突合并。放在主进程，写入只有一个入口，读取是广播，天然一致。

**为什么按钮手势要换算成归一化坐标。** 大屏和映射窗尺寸完全不同，激光点必须用 0~1 的相对坐标，才能在两处落到同一个位置。

**为什么不用 `file://` 加载页面。** `file://` 的 origin 是 `null`，Chromium 不允许从 `null` origin 构造 Worker，pdf.js 会直接抛 `SecurityError`（表现就是 PDF 打不开）。页面改由 `screendeck://` 自定义标准协议提供，origin 变成 `screendeck://local`，Worker、fetch、CSP `'self'` 全部正常；协议处理器对请求路径做 `realpath` 越界校验，只暴露仓库内的静态文件。

## 安全约束（代码里的硬规则）

- 渲染进程 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`，只通过 preload 暴露的白名单方法通信。
- 所有用户文件路径先 `fs.realpath` 再校验，用 `path.relative` 判断包含关系，**不用字符串前缀**（`C:\data\evil` 不是 `C:\data\e` 的子路径）。
- 每次读取文档都重新 realpath + stat，避免列表建立后路径被替换（TOCTOU）。
- 删除前扫描子树内的 junction / 符号链接；发现链接就拒绝递归删除，只允许 `rmdir` 摘掉链接本身。
- `.npmrc` 写 `install-strategy=hoisted`（npm 原生的扁平安装策略），不创建任何链接。

## 已知限制（0.1.0）

- 映射窗事件不注入第三方窗口，模块 4 是纯只读镜像。
- Markdown 的「章节」按 `h1/h2/h3` 识别；没有标题的文档横向拖拽退化为整篇滚动。
- 大屏窗口在单屏环境是窗口模式，不是全屏。
- 依赖体积较大（Electron 运行时约 190MB），这是选型代价而非 bug。

## 版本

- 0.1.0 —— 首个可用版本，模块 1~5 全部落地，详见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

MIT

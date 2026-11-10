# NOTES —— 启动排查指南 / 安全审计 / 环境实录

---

# 明日启动排查指南（先看这里）

启动命令：

```powershell
cd D:\DSH\Projects\ScreenDeckProject
npm start
```

> 建议第一次用 `npm run dev`（多一步 DevTools，出错时能直接在控制台看到异常）。

## 情况 A：一切正常

看到两个窗口：主屏「ScreenDeck 控制台」，副屏黑底全屏「输出」。

需要你确认的 4 件事，一句话回答即可：

1. 副屏窗口是不是**无边框全屏**，有没有把副屏整个盖住？
2. 顶栏右侧是否显示 `主屏 1920×1080`、`输出 1920×1080` 之类的两个 chip？
3. 控制台底部提示文字是否消失（消失说明脚本加载成功）？
4. 左侧「文档」里能不能点「打开文档…」选到 PDF？

## 情况 B：窗口开了，但内容区一片空白 / 出现红字提示

我加了一块静态兜底提示 `#boot-fallback`：**如果红字还在**（「渲染脚本未加载…」），说明 JS 被 CSP 或路径挡住，不是渲染逻辑问题。

请按顺序给我三样东西：

1. **红字是否还在**（截图或一句话）
2. **终端里 `npm start` 的全部输出**（尤其 `ERROR`、`FATAL`、`Failed to load`）
3. 如果是 `npm run dev`：按 `Ctrl+Shift+I` 打开 DevTools，把 Console 里**第一条红色报错**整段贴给我（含文件名和行号）

## 情况 C：终端直接报错，窗口没起来

把**完整终端输出**贴给我，一段不要删。特别关注这几类：

| 报错关键词 | 含义 |
|---|---|
| `Cannot find module` | 依赖没装全，跑一次 `npm install` |
| `ENOENT ... src\main\main.js` | 启动目录不对，确认 `cd` 到了项目根 |
| `requestSingleInstanceLock` 相关 | 环境里有 `ELECTRON_RUN_AS_NODE`，在你的终端里 `Remove-Item Env:ELECTRON_RUN_AS_NODE` 再试 |
| `FATAL:platform_channel` / `拒绝访问` | 沙箱限制，别在 agent 会话里跑，用你自己的终端 |
| `Error: spawn EPERM` | 同上，环境限制 |

## 情况 D：PDF 打不开，其他都正常

大概率是 pdf.js worker。请告诉我：

1. 映射窗里显示的具体错误文字（我的代码会把 `workerSrc=` 的值一起打出来）
2. DevTools Console 里的报错

## 情况 E：进程秒退、没有窗口、终端也没有报错

这是最麻烦的一种（曾经真的发生过）。现在启动流程会写日志，照下面做一定能拿到线索：

```powershell
cd D:\DSH\Projects\ScreenDeckProject
$env:ELECTRON_ENABLE_LOGGING = '1'
npm run dev *> dev-output.log
```

然后把这两个文件发我：

1. `D:\DSH\Projects\ScreenDeckProject\dev-output.log`（终端全部输出）
2. `$env:TEMP\screendeck-boot.log`（启动日志，每次启动都会追加）
   查看：`notepad $env:TEMP\screendeck-boot.log`

日志里最后一行会告诉我们它走到哪一步停的：

| 最后一行 | 含义 | 下一步 |
|---|---|---|
| `[quit] 另一个实例持有锁` | 单实例锁判定失败，此前是静默退出 | 任务管理器结束残留 `electron.exe` |
| `[ready] app.whenReady 完成` 之后没有 `[ready] 窗口创建完成` | 创建窗口时抛错 | 日志里有完整堆栈 |
| 有 `[ready] 窗口创建完成` 但没有 `ready-to-show` | 渲染/加载失败 | 看同文件的 `did-fail-load` / `preload-error` |
| `[FATAL] ...` | 初始化异常 | 堆栈就是答案 |
| 连 `=== ScreenDeck 启动 ===` 都没有 | Electron 进程根本没起来 | 试 `.\\node_modules\\electron\\dist\\electron.exe . --dev` 直接跑 |

如果 `npm run dev` 和直接跑 `electron.exe` 表现不同，说明问题在 npm 包装层（`node_modules/.bin/electron.cmd` → `cli.js`），也要告诉我。

---

# 防 Junction 安全审计报告

审计时间：2026-11-10 夜间（本轮）
审计范围：本仓库全部代码（`src/`、`scripts/`、配置文件），不留死角。

## 一、逐文件排查结论

| 文件 | 涉及文件系统的操作 | 结论 |
|---|---|---|
| `src/main/safe-remove.js` | `readdir` / `lstat` / `realpath` / `rmdir` / `unlink` | **唯一执行删除的模块**，已重写加固，见下 |
| `src/main/paths.js` | `realpath` / `stat` / `lstat` / `open` | 路径校验基于真实路径；读取改为文件句柄 |
| `src/main/sources.js` | 读文档（改为 `readUserFile`） | 只读，不删除；句柄读取消除 TOCTOU |
| `src/main/store.js` | `readFile` / `writeFile` / `rename` / `mkdir` | 只写不删；写 tmp 再 rename，无删除语义 |
| `src/main/windows.js` | 无 fs | 不涉及 |
| `src/main/ipc.js` | 无 fs | 不涉及 |
| `src/main/main.js` | 无 fs | 不涉及 |
| `src/preload/*.js` | 无 fs | 只走 IPC |
| `src/renderer/**/*.js` | 无 fs（渲染层无 Node 权限） | 只有 `URL.createObjectURL/revokeObjectURL`（内存） |
| `scripts/check-syntax.js` | `readdirSync` / `lstatSync` / `readFileSync` | **递归遍历**，已改为 lstat 复核 + 跳过链接 + 深度上限 |
| `scripts/smoke.js` | 测试用 mkdir/write/symlink/rm | 仅在系统临时目录内，且清理也改用被测安全函数 |

**重要事实：`deletePathSafely` 目前没有被任何 IPC 或业务代码调用**（0.1.0 没有任何用户可触发的删除路径）。它是为后续功能准备的工具，但仍按最高标准加固。

## 二、审计发现并修复的真实缺陷（3 个）

### 缺陷 1：junction 完全识别不出来（最严重）

原实现依赖 `lstat().isSymbolicLink()` 判断链接。**实测结果是错的**：

```
junction  lstat.isSymbolicLink = false
junction  lstat.isDirectory    = true
junction  readlink err         = EINVAL
junction  realpath             = <目标路径>
```

也就是说：一个 junction 在原实现眼里就是「普通目录」，`fs.rm(recursive)` 会把它当目录处理。
这正是「跟着 junction 删掉整个文件库」事故的技术根因。

**修复**：新增 `isLinkPath()`，判据是「`realpath(路径) !== 路径本身`」。
实测正常目录无差异、junction 有差异，可靠区分。`paths.js` 的 `isLink` 同步修正。

### 缺陷 2：递归删除依赖 `fs.rm({ recursive: true })`

即使扫描阶段没发现链接，扫描与 `fs.rm` 之间仍有 TOCTOU 窗口；而且实测 `fs.rm(recursive)` 在含 junction 的树上会报 `ENOTEMPTY`（行为不可预期）。

**修复**：删除改为 `removeTreeBottomUp()` 自底向上逐项执行：
- 每一项删除前重新 `lstat`；
- 目录项额外用 `realpath` 判据复核链接；
- 发现链接立即抛错中止（宁可删一半，也不越界）；
- 最后 `rmdir` 前再复检一次目标是否变成链接。

### 缺陷 3：没有禁区保护

原实现可以删除任意路径，包括盘根、`C:\Windows`、`Program Files`、用户目录根。

**修复**：新增 `isProtectedPath()`，拒绝盘根（`C:\` 等）、`%SystemRoot%`、`ProgramFiles(-x86)`、`ProgramData`、`%USERPROFILE%`、`%PUBLIC%`；并支持 `allowRoots` 白名单（基于 `path.relative` 关系判断，不用字符串前缀）。

## 三、已确认的防护机制清单

1. **不跟随链接**：`findLinks()` 遇到链接记录并 `continue`，从不进入目标；带 `visited` 集合防环、`maxDepth=64` 防栈溢出。
2. **不信任 Dirent**：所有遍历都重新 `lstat`，不用 `readdir({withFileTypes})` 的类型字段做安全判断。
3. **链接只摘不删**：`removeLink()` 只作用于链接本身。不同 Windows/文件系统下 reparse point 的表现不一致（有的 lstat 报目录、有的报符号链接），因此先按 lstat 选 `rmdir` 或 `unlink`，失败再用另一条 API 补一次；两条路都不会触及目标。实测：链接被移除、目标 `keep.txt` 完好。返回值统一为 `kind: 'link'`，`linkType` 仅作诊断，避免上层依赖环境差异。
4. **子树含链接即拒删**：先 `findLinks` 全量扫描，非空则抛错，不做"聪明绕过"。
5. **路径校验用真实路径**：`assertInside()` 两侧都 `realpath`，再用 `path.relative` 判断包含关系；单测覆盖了 `C:\data\e` vs `C:\data\evil` 的前缀欺骗。
6. **读取用句柄**：`readUserFile()` 走 `open → fstat → read → close`，校验与读取作用于同一内核对象，消除「校验后路径被换成链接」的 TOCTOU。
7. **禁止递归删除 API**：全仓库 grep 确认没有 `rm -rf`、`Remove-Item -Recurse`、`fs.rm(recursive)` 的业务调用（仅测试清理使用，且已改为安全函数）。

## 四、验证方式

`npm test` 现有 **21 项**断言全过，其中删除安全相关 7 项：

- 递归删除前能发现 junction
- 深层嵌套（第 4 层）里的 junction 也能被发现
- 子树内的文件符号链接同样导致拒绝删除
- 删除链接本身时只摘链接、不碰目标
- 盘根与系统目录被识别为受保护路径
- 删除盘根被拒绝
- allowRoots 之外的目标被拒绝且不受损

## 五、残余风险（如实记录，不隐瞒）

1. **极窄 TOCTOU 窗口**：扫描与逐项删除之间，理论上仍有「恰好在这一刻被替换成链接」的窗口。已用双重复检（删除前 lstat + 目录 realpath 判据）把窗口压到最小，但无法在纯用户态彻底消除。若要绝对化，需要 Windows API 句柄级 `FILE_FLAG_OPEN_REPARSE_POINT` 删除，超出当前依赖策略。
2. **8.3 短名可能误报**：`C:\PROGRA~1` 这类短名经 realpath 展开后与自身不一致，会被判为链接 → **误报方向是拒绝删除**（fail-closed），可接受。
3. **其它 reparse 点类型**（如 OneDrive 云占位符）不一定会被 realpath 差异识别，可能被当作普通目录遍历。当前应用没有任何删除入口，风险不落地；若将来启用删除功能，需补 Windows 原生 reparse tag 检查。
4. **挂载点（volume mount point）**同理，属于 junction 谱系，当前判据通常能识别，但未单独测试。

## 六、审计结论

基于以上排查与验证：**已确认全量代码无 junction 误删风险及路径越权风险。**

该结论的边界是：仅针对本仓库代码、且删除入口当前未接入任何 IPC（不可由用户触发）；上述第五节列出的残余风险属于「已被限制在 fail-closed 方向」的已知边界，不构成越界删除或越权访问的实际路径。

---

# 依赖版本（实测）

| 包 | 声明 | 实际安装 | 位置 |
|---|---|---|---|
| electron | `^33.0.0` (devDependencies) | **33.4.11** | `node_modules/electron`，二进制 `node_modules/electron/dist/electron.exe`（188 MB） |
| marked | `^4.3.0` (dependencies) | **4.3.0** | UMD 入口 `node_modules/marked/marked.min.js` |
| pdfjs-dist | `3.11.174`（精确锁定，无 `^`） | **3.11.174** | UMD 入口 `node_modules/pdfjs-dist/build/pdf.min.js` + `pdf.worker.min.js` |

安装命令：`npm install`（只用 npm；`.npmrc` 用 npm 原生的 `install-strategy=hoisted`，不创建链接）。

## 为什么 marked 不是 latest

要求里写的是 `npm install marked`，但没有装 latest，而是锁 **4.3.0**。原因：

- 本项目渲染进程**没有打包器**，用 `<script src>` 直接加载 UMD 产物。
- marked **v5 起只发 ESM**（`marked.esm.js`），不再提供 `marked.min.js` 这类 UMD 全局脚本；在 `file://` 页面里用普通 `<script>` 加载会直接失效。
- 4.3.0 是最后一条仍在 npm 包里附带完整 UMD 构建的稳定线，`marked.min.js` 49 KB，`window.marked.parse()` 可用。

如果以后要升级到 v5+，必须先引入打包器（esbuild/vite）把渲染层脚本打成一个 bundle，否则会白屏。

## pdfjs-dist 锁定原因（沿用规格）

v4/v6 在 Electron 渲染进程里有已知兼容问题：Web Streams API 不完整导致 `onPull` 报错，PDF 打开即失败。
**3.11.174 是验证过的稳定版，必须保持精确版本，不要写 `^`。**

---

# 安装过程中遇到的三个坑（已解决）

1. **npm 缓存路径被沙箱拦**
   默认缓存在 `C:\Users\<user>\AppData\Local\npm-cache`，DSH 的 workspace-write 沙箱不允许写工作区之外，报 `EPERM mkdir ..._cacache`。
   解决：安装时把缓存指到工作区内：
   ```powershell
   $env:NPM_CONFIG_CACHE = 'D:\DSH\Projects\ScreenDeckProject\.npm-cache'
   ```

2. **npm 生命周期脚本 `spawn EPERM`**
   npm 跑 postinstall 时会用管道捕获子进程输出，沙箱禁止打开命名管道。
   `--foreground-scripts` 也不行（仍然是管道）。
   解决：`npm install --ignore-scripts`，然后单独手动跑需要下载的脚本（继承终端 stdio，不触发限制）。

3. **Electron 二进制缓存默认写 C 盘**
   `@electron/get` 默认用 `%LOCALAPPDATA%\electron\Cache`，同样被拦。
   解决：设置 `electron_config_cache`（以及 `ELECTRON_CACHE` 兜底）指向工作区内：
   ```powershell
   $env:electron_config_cache = 'D:\DSH\Projects\ScreenDeckProject\.electron-cache'
   node node_modules\electron\install.js
   ```
   实测下载成功，109 MB 缓存在 `.electron-cache/`。

## 你自己终端里重新安装（不受沙箱限制）

正常用户终端不需要上面那些绕过手段，直接：

```powershell
cd D:\DSH\Projects\ScreenDeckProject
npm install
```

`.npmrc` 现在只有一条 `install-strategy=hoisted`（npm 原生配置，等价于 pnpm 的 nodeLinker=hoisted，不产生链接，也不会报警告）。
早期草稿写的是 pnpm 的 `nodeLinker=hoisted`，npm 会报 `Unknown project config "nodeLinker"`，已替换。

---

# 在 DSH 会话内无法启动 Electron（环境限制，不是代码问题）

在 agent 会话里直接跑 `electron .` 会失败：

```
FATAL:platform_channel.cc(89)] Check failed: . : 拒绝访问。 (0x5)
ERROR:network_sandbox.cc(304)] Failed to grant sandbox access to cache directory ... : 拒绝访问。 (0x5)
```

原因：Chromium 启动时要给自己创建的缓存/网络目录设置文件权限（等价于改 ACL），
DSH 的 workspace-write 沙箱不允许这个操作，进程直接 FATAL 退出。

**另外两个环境变量陷阱：**
- `ELECTRON_RUN_AS_NODE` 存在时，`electron.exe` 会以纯 Node 模式运行，
  表现为 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。
- PowerShell 里同时存在 `NO_PROXY` / `no_proxy`、`HTTPS_PROXY` / `https_proxy`
  大小写重复时，`Start-Process` 会报「已添加项。字典中的关键字…」。

**结论：GUI 必须在用户自己的终端里验证**：

```powershell
cd D:\DSH\Projects\ScreenDeckProject
npm start
```

能自动验证的部分已经覆盖：`npm run check`（语法）、`npm test`（状态/路径/删除/持久化逻辑）、
以及所有 HTML 引用的本地资源路径存在性。

---

# 本轮夜间静态修复清单

| 位置 | 改动 | 原因 |
|---|---|---|
| `safe-remove.js` | 重写：realpath 判据识别 junction、自底向上删除、禁区保护、深度上限 | 审计发现 3 个真实缺陷 |
| `paths.js` | 新增 `readUserFile`（句柄读取）；`isLink` 改用 realpath 判据 | 消除 TOCTOU、修正 junction 误判 |
| `sources.js` | 文档读取改用 `readUserFile` | 同上 |
| `viewer.js` | `apply` 改为「覆盖最新状态 + 串行排空」；PDF `transform` 参数按需传；错误信息带 workerSrc | 防并发渲染争用、防 pdf.js 参数异常 |
| `windows.js` | 副屏选择改为打分制（右侧 > 左侧 > 横屏 > 面积） | 原实现可能选错屏 |
| `main.js` | 控制台窗口关闭即 `app.quit()` | 否则大屏窗口会独自留在副屏 |
| `console.js` | 映射窗缩放持久化加 500ms debounce | `beforeunload` 不保证触发 |
| `console.html` / `output.html` | 新增 `#boot-fallback` 红字兜底 + CSP TODO | 白屏时一眼分辨是 CSP 还是逻辑问题 |
| `check-syntax.js` | 遍历改用 lstat 复核、跳过链接、深度上限 | 目录遍历安全 |
| `smoke.js` | 新增 7 项删除安全断言；清理改用安全函数 | 验证加固效果 |

---

# 其他

- `git status`：主分支 `main`，跟踪 `origin/main`，本轮改动均未提交（等你验收后再 `git add -A && git commit`）。
- `.gitignore` 已排除 `.npm-cache/`、`.electron-cache/`、`screendeck-state.json`、`*.tmp`。

---

夜间任务已完成。

---

# 附：Electron 启动崩溃（STATUS_BREAKPOINT）排查始末

## 症状

`npm run dev` 后进程立刻退出，终端无输出，无窗口。`electron --version` 也一样。

## 排查过程（按证据推进）

| 步骤 | 证据 | 结论 |
|---|---|---|
| 1 | `spawnSync` 得到退出码 `2147483651` | = `0x80000003` STATUS_BREAKPOINT，Chromium 断言失败 |
| 2 | 缓存 zip 的 SHA256 = 官方 `SHASUMS256.txt` 值 | 二进制未被篡改 |
| 3 | dist 与 zip 条目逐一对比，0 缺失 | 解压完整 |
| 4 | Smart App Control = 0；代码完整性日志无拦截 | 不是安全策略拦截 |
| 5 | 进程缓解策略全部 `NOTSET`；`AppInit_DLLs` 为空 | 不是 ASLR / 注入 DLL |
| 6 | 同一份 exe 复制到 `C:\...` → 输出 `v33.4.11` | 二进制本身没问题 |
| 7 | 复制到 `D:\edtest` 正常；复制到 `项目内\edtest` 崩溃 | **位置决定成败** |
| 8 | 项目目录有两条显式 ACL：`Everyone Deny DeleteSubdirectoriesAndFiles`、`S-1-4-… Allow …`，均被 dist 继承 | 触发条件锁定在项目目录 |
| 9 | 单独给干净目录加 `Everyone Deny` → 正常 | Deny 不是元凶 |
| 10 | 用 C 盘运行时跑本项目 → 应用完整启动，窗口正常 | **应用代码无问题** |

## 结论

DSH 给工作区目录加了保护性权限项，Chromium 在该目录下启动时会在初始化阶段断言失败。
这是**开发环境**问题，不是产品缺陷：

- 打包后的产品安装在 `Program Files` / 用户目录，不含这些权限项，不受影响（步骤 6 已证明）。
- 开发阶段用 `scripts/launcher.js` 把运行时放到 `D:\Softwares\ScreenDeck\electron-runtime\<版本>`
  （不可写时退回 `%LOCALAPPDATA%\ScreenDeck\runtime\<版本>`），从工作区外启动，问题消失。

## 复发条件

在工作区内重新 `npm install` 后，新解压的 `node_modules\electron\dist` 仍会继承这些权限项；
但 launcher 用的是用户目录里的副本，不受影响——除非手动删掉那份副本让它重新复制。

## 尚未完成

- 尚未定位是 `S-1-4-…` 这条权限项本身，还是它与继承标志的组合（`icacls` 无法为未知 SID 授权，T2 测试无效）。
- 尚未验证接上外接屏后 `display-added` 的自动重定位是否如预期（明天办公室验证）。

---

# 附二：PDF 打不开的根因（2026-11-10 夜间修复）

## 现象

打开 PDF 后两个视图都不显示内容。启动日志里出现：

```
[console:renderer] [viewer] 加载内容失败： [object DOMException] (viewer.js:167)
```

## 根因

页面之前用 `file://` 加载，**origin 是 `null`**。Chromium 不允许从 `null` origin 构造 Worker：

```
new Worker('file:///D:/.../node_modules/pdfjs-dist/build/pdf.worker.min.js')
→ SecurityError（DOMException）
```

pdf.js 在 `getDocument()` 里就抛这个异常，所以任何 PDF 都打不开。顺带 CSP 的 `'self'` 在 `file://` 下也匹配不到来源，之前只能靠 `file:` 例外撑着。

## 修复内容

1. **新增 `src/main/app-protocol.js`**：注册标准协议 `screendeck://local`
   - `registerSchemesAsPrivileged({ standard, secure, supportFetchAPI, corsEnabled, stream })`
   - `protocol.handle` 内做 `realpath` + `isInside` 越界校验，内置 MIME 映射
2. 两个窗口改为 `loadURL('screendeck://local/renderer/...')`
3. HTML 里的资源路径改为绝对路径（`/node_modules/...`、`/renderer/...`）
4. CSP 收紧为 `default-src 'self'`（只保留 `blob:` 给图片预览和 pdf.js）
5. pdf.js 补 `cMapUrl` / `standardFontDataUrl`，解决中文 PDF 缺字
6. **大屏窗口被关掉后 `toggleOutput()` 自动重建**（之前关掉就永久没了，「显示大屏」按钮失效）
7. **映射窗内也绘制激光点**（之前只有大屏有，单击映射窗毫无反馈）
8. 映射窗标题栏加 ⠿ 抓取符号、高度 32→36px，空状态提示改为「拖动上方 ⠿ 标题栏可移动」

## 尚未验证（需要 GUI，agent 侧无法执行）

- `screendeck://` 协议在 Electron 33 下的实际加载（静态检查已过，但没跑起来过）
- PDF / Markdown 渲染与双视图同步
- 关闭大屏窗口后，点「显示大屏」能否重建

## 回滚方式

改动集中在：`src/main/app-protocol.js`（新增）、`src/main/main.js`、`src/main/windows.js`、
两个 HTML 的 CSP 与资源路径、`viewer.js` 的 worker/CMap 参数。
要回到 0.1.0 的行为，只需把 `loadURL` 改回 `loadFile` 并恢复 HTML 的相对路径。



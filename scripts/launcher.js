'use strict';

/**
 * 开发启动器。
 *
 * 背景：DSH 工作区目录带有特殊的文件权限项，Chromium 在**工作区内**启动时会断言失败
 * （STATUS_BREAKPOINT，退出码 0x80000003），任何 electron.exe 放在工作区里都一样。
 * 把运行时放到工作区之外就正常，这一点已用 D:\edtest 与 C:\ 两份副本验证过。
 *
 * 所以：本脚本在**第一次运行时**把 node_modules/electron/dist 复制到用户目录
 * （%LOCALAPPDATA%\ScreenDeck\runtime\<版本>），之后每次直接启动那份副本。
 *
 * 好处：
 *   - 不需要每次手动设 ELECTRON_OVERRIDE_DIST_PATH
 *   - 不修改工作区权限，不与 DSH 的沙箱保护冲突
 *   - 换机器/正常工作环境下同样可用；若环境无此问题，可用 npm run start:direct 直连
 *
 * 用法：
 *   node scripts/launcher.js            → 等价 npm start
 *   node scripts/launcher.js --dev      → 等价 npm run dev
 *   SCREENDECK_ELECTRON_RUNTIME=D:\x    → 自定义运行时目录
 *   npm run start:direct                → 不经过本脚本
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_PKG = path.join(ROOT, 'node_modules', 'electron', 'package.json');
const SOURCE_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const EXE_NAME = process.platform === 'win32' ? 'electron.exe' : 'electron';

function fail(message) {
  console.error(`[launcher] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(SOURCE_DIST)) {
  fail(`找不到 Electron 运行时目录：${SOURCE_DIST}\n请先执行 npm install`);
}

let version = 'unknown';
try {
  version = JSON.parse(fs.readFileSync(ELECTRON_PKG, 'utf8')).version;
} catch {
  // 版本读不到不影响启动
}

const baseDir =
  process.env.SCREENDECK_ELECTRON_RUNTIME ||
  path.join(process.env.LOCALAPPDATA || os.homedir(), 'ScreenDeck', 'runtime', version);
const runtimeExe = path.join(baseDir, EXE_NAME);

/**
 * 运行时放哪里。
 * 优先级：
 *   1. SCREENDECK_ELECTRON_RUNTIME 环境变量（完全自定义）
 *   2. D:\Softwares\ScreenDeck\electron-runtime\<版本>（用户偏好的软件目录）
 *   3. %LOCALAPPDATA%\ScreenDeck\runtime\<版本>（兜底）
 * 前一个位置不可写时自动换下一个。
 */
function candidateDirs() {
  const dirs = [];
  if (process.platform === 'win32') {
    dirs.push(path.join('D:\\Softwares', 'ScreenDeck', 'electron-runtime', version));
  }
  dirs.push(path.join(process.env.LOCALAPPDATA || os.homedir(), 'ScreenDeck', 'runtime', version));
  return dirs;
}

function ensureRuntime() {
  if (process.env.SCREENDECK_ELECTRON_RUNTIME) {
    const custom = path.join(process.env.SCREENDECK_ELECTRON_RUNTIME, EXE_NAME);
    if (fs.existsSync(custom)) return custom;
    return copyInto(process.env.SCREENDECK_ELECTRON_RUNTIME);
  }

  const dirs = candidateDirs();
  for (const dir of dirs) {
    const exe = path.join(dir, EXE_NAME);
    if (fs.existsSync(exe)) {
      console.log(`[launcher] 复用已有运行时：${exe}`);
      return exe;
    }
  }

  const errors = [];
  for (const dir of dirs) {
    try {
      return copyInto(dir);
    } catch (err) {
      errors.push(`  ${dir}\n    → ${err.message}`);
      console.warn(`[launcher] 该位置不可用，换下一个：${dir}`);
    }
  }
  fail(`所有候选位置都写入失败：\n${errors.join('\n')}`);
  return null;
}

function copyInto(dir) {
  console.log(`[launcher] 首次运行，把 Electron ${version} 复制到：${dir}`);
  console.log('[launcher] 约 180MB，只发生一次……');
  const started = Date.now();
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(SOURCE_DIST, dir, { recursive: true, force: true });

  const exe = path.join(dir, EXE_NAME);
  if (!fs.existsSync(exe)) throw new Error(`复制完成但仍找不到 ${exe}`);
  console.log(`[launcher] 复制完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return exe;
}

const exe = ensureRuntime();
const args = ['.', ...process.argv.slice(2)];

console.log(`[launcher] 运行时 = ${exe}`);
console.log(`[launcher] 命令     = electron ${args.join(' ')}`);
console.log(`[launcher] 启动日志 = ${path.join(os.tmpdir(), 'screendeck-boot.log')}`);

const child = spawn(exe, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env },
});

child.on('error', (err) => {
  fail(`启动失败：${err.message}`);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[launcher] 进程被信号终止：${signal}`);
    process.exitCode = 1;
    return;
  }
  if (code === 0x80000003 || code === -2147483645 || code === 2147483651) {
    console.error('[launcher] Electron 在初始化阶段崩溃（STATUS_BREAKPOINT）。');
    console.error(`[launcher] 当前运行时：${exe}`);
    console.error('[launcher] 若运行时仍在 DSH 工作区内，请改用本脚本启动（它会把运行时放到用户目录）。');
    process.exitCode = 1;
    return;
  }
  process.exitCode = code == null ? 1 : code;
});

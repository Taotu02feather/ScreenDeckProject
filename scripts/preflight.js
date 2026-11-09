'use strict';

/**
 * 启动预检：在用户终端里跑，专门排查「electron 静默秒退」。
 *
 * 它不依赖应用代码，只回答四个问题：
 *   1. 项目结构对不对（package.json 的 main 文件是否存在）
 *   2. electron 模块指向的可执行文件是否存在、大小多少
 *   3. electron --version 能不能跑起来（会暴露 ELECTRON_RUN_AS_NODE）
 *   4. electron . --dev 的真实退出码 / stdout / stderr
 *
 * 用法：node scripts/preflight.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function line(...args) {
  console.log(...args);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

section('环境');
line('node        =', process.version);
line('cwd         =', process.cwd());
line('projectRoot =', ROOT);
line('ELECTRON_RUN_AS_NODE =', JSON.stringify(process.env.ELECTRON_RUN_AS_NODE || null));
line('TEMP        =', process.env.TEMP);
line('OS          =', `${process.arch} / ${process.platform}`);

section('项目结构');
let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  line('package.name =', pkg.name, ' version =', pkg.version);
  line('package.main =', pkg.main);
  const mainPath = path.join(ROOT, pkg.main || '');
  line('main 文件存在 =', pkg.main ? fs.existsSync(mainPath) : false);
} catch (err) {
  line('读取 package.json 失败：', err.message);
}

section('electron 模块');
let electronPath = null;
try {
  electronPath = require(path.join(ROOT, 'node_modules', 'electron'));
  line('require(electron) =', electronPath);
} catch (err) {
  line('require(electron) 失败：', err.message);
}

if (electronPath && fs.existsSync(electronPath)) {
  const stat = fs.statSync(electronPath);
  line('exe 存在 =', true);
  line('exe 大小 =', `${(stat.size / 1024 / 1024).toFixed(1)} MB`);
} else {
  line('exe 存在 =', false);
}

function run(args, timeoutMs) {
  line(`\n$ electron ${args.join(' ')}`);
  const started = Date.now();
  const result = spawnSync(electronPath, args, {
    cwd: ROOT,
    timeout: timeoutMs,
    encoding: 'utf8',
    env: { ...process.env },
  });
  const cost = Date.now() - started;
  line('  exit   =', result.status, '  signal =', result.signal, `  耗时 = ${cost}ms`);
  if (result.error) line('  spawn error =', result.error.message);
  const out = (result.stdout || '').trim();
  const err = (result.stderr || '').trim();
  line('  stdout =', out ? JSON.stringify(out.slice(0, 1200)) : '(空)');
  line('  stderr =', err ? JSON.stringify(err.slice(0, 1200)) : '(空)');
}

if (electronPath && fs.existsSync(electronPath)) {
  section('探针 1：electron --version（正常应输出 v33.4.11）');
  run(['--version'], 20000);

  section('探针 2：electron . --dev（会尝试开窗口，最多等 12 秒）');
  line('注意：如果窗口正常出现，说明问题只在 npm 包装层；脚本会在 12 秒后结束进程。');
  run(['.', '--dev'], 12000);
}

section('结论提示');
line('· 探针 1 输出 v20.x/24.x 之类 → 说明 ELECTRON_RUN_AS_NODE 生效，electron 退化成 Node');
line('· 探针 1 输出 v33.4.11 且探针 2 秒退 exit=0 → 问题在应用启动流程，请把 %TEMP%\\screendeck-boot.log 发我');
line('· 探针 2 能开窗口 → 问题在 npm 包装层（node_modules\\.bin\\electron.cmd）');
line('· 两条都 spawn error → electron 包损坏，删掉 node_modules\\electron 重装');

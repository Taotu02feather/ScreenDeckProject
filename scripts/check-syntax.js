'use strict';

/**
 * 语法自检：不启动 Electron，只解析所有 JS 文件。
 * 用 vm.Script 在进程内解析，不 spawn 子进程（沙箱下 spawn 管道会被拦）。
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.npm-cache', '.electron-cache', 'dist']);

const failures = [];
let checked = 0;
let jsonChecked = 0;

function checkScript(file) {
  checked += 1;
  const source = fs.readFileSync(file, 'utf8');
  try {
    new vm.Script(source, { filename: file });
  } catch (err) {
    failures.push(`${path.relative(ROOT, file)} → ${err.message}`);
  }
}

function walk(dir, depth = 0) {
  if (depth > 32) return; // 防止异常深的目录把栈打爆
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);

    // 不信任 Dirent：用 lstat 复核，遇到链接直接跳过，绝不跟随（避免环与越权遍历）
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walk(full, depth + 1);
    else if (stat.isFile() && entry.name.endsWith('.js')) checkScript(full);
  }
}

function checkJson(file) {
  jsonChecked += 1;
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    failures.push(`${path.relative(ROOT, file)} → ${err.message}`);
  }
}

walk(ROOT);
checkJson(path.join(ROOT, 'package.json'));

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 个文件有问题：\n`);
  for (const line of failures) console.error(`  ${line}`);
  console.error('');
  process.exit(1);
}

console.log(`✓ ${checked} 个 JS 文件、${jsonChecked} 个 JSON 文件通过检查`);

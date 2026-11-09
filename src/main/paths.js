'use strict';

/**
 * 路径安全工具。
 *
 * 硬约束：任何涉及用户文件路径的判断，必须先用 fs.realpath 解析出真实路径，
 * 再基于真实路径做范围校验；禁止用字符串前缀比较（`p.startsWith(root)` 之类的写法
 * 会把 `C:\data\evil` 误判为在 `C:\data\e` 之内）。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FILE_BYTES = 300 * 1024 * 1024;

/** 基于 path.relative 的包含判断，两侧都必须是已解析的真实路径。 */
function isInside(root, target) {
  if (!root || !target) return false;
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/** realpath，失败时抛出带上下文的错误，避免上层拿到 undefined 继续跑。 */
async function realpathStrict(target) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new Error('路径为空');
  }
  if (!path.isAbsolute(target)) {
    throw new Error(`必须是绝对路径：${target}`);
  }
  try {
    return await fs.realpath(target);
  } catch (err) {
    const e = new Error(`无法解析路径（可能不存在或无权限）：${target}`);
    e.cause = err;
    throw e;
  }
}

/** 校验 candidate 是否落在 root 之内，返回 candidate 的真实路径。 */
async function assertInside(root, candidate) {
  const [realRoot, realTarget] = await Promise.all([realpathStrict(root), realpathStrict(candidate)]);
  if (!isInside(realRoot, realTarget)) {
    throw new Error(`路径越界：${realTarget} 不在 ${realRoot} 之内`);
  }
  return realTarget;
}

/**
 * 校验一个“用户选中的文件”：真实路径解析 -> 必须是普通文件 -> 大小上限。
 * 返回真实路径，后续所有读写都必须使用这个真实路径。
 */
async function assertUserFile(candidate) {
  const real = await realpathStrict(candidate);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error(`不是普通文件：${real}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`文件超过上限 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB：${real}`);
  }
  return { realPath: real, size: stat.size };
}

/**
 * 读取用户文件：用文件句柄读取，而不是"先校验路径、再按路径读"。
 *
 * 只校验路径再 readFile(realPath) 存在 TOCTOU 窗口：两次调用之间，路径可能被换成
 * 符号链接指向别处。这里先 open 拿到句柄，再对句柄 fstat + 读，校验和读取作用于
 * 同一个内核对象，窗口消失。
 */
async function readUserFile(candidate) {
  const real = await realpathStrict(candidate);
  let handle;
  try {
    handle = await fs.open(real, 'r');
  } catch (err) {
    const e = new Error(`无法打开文件：${real}`);
    e.cause = err;
    throw e;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`不是普通文件：${real}`);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`文件超过上限 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB：${real}`);
    }
    const buffer = await handle.readFile();
    return { realPath: real, size: stat.size, buffer };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * 是否链接 / junction / reparse point。
 *
 * 注意实测结论（Windows + Node 24）：junction 的 lstat().isSymbolicLink() 为 **false**，
 * isDirectory() 为 true，readlink() 报 EINVAL。因此不能只用 lstat 判断，
 * 必须补一条「realpath 与自身路径不一致」的判据。
 * 详见 safe-remove.js 的 isLinkPath 与 NOTES.md 审计报告。
 */
async function isLink(target) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink()) return true;
  if (!stat.isDirectory()) return false;
  try {
    const real = await fs.realpath(target);
    const norm = (value) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
    return norm(real) !== norm(target);
  } catch {
    return false;
  }
}

module.exports = {
  isInside,
  realpathStrict,
  assertInside,
  assertUserFile,
  readUserFile,
  isLink,
  MAX_FILE_BYTES,
};

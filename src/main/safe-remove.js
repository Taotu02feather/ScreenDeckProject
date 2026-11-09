'use strict';

/**
 * 删除安全 —— 本项目最高优先级的安全红线。
 *
 * 背景：Windows 上 junction（目录联接）/ symlink / 其它 reparse point 被误跟随，
 * 曾多次造成「删一个缓存目录，结果清空整个文件库甚至 C 盘」的事故。
 * 因此本模块遵守五条不可妥协的规则：
 *
 *  1. 绝不对整棵树使用 `fs.rm({ recursive: true })`、`rm -rf`、`Remove-Item -Recurse`。
 *     删除一律自底向上逐项执行，每一项删除前重新判定是否为链接。
 *  2. 不信任 `readdir({ withFileTypes: true })` 的 Dirent 类型，一律再 lstat 一次。
 *  3. 递归遍历遇到链接立即跳过并记录，绝不进入链接目标；
 *     子树中发现链接时直接拒绝删除，而不是"聪明地绕开"。
 *  4. 拒绝删除磁盘根目录、系统目录、用户配置目录根，以及不在允许范围内的路径。
 *  5. 链接判定不依赖 lstat().isSymbolicLink() —— 见下方 isLinkPath 的实测说明。
 *
 * 移除链接本身只用 `fs.rmdir`（等价于不带 /S 的 rmdir），它只摘链接，不碰目标。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_MAX_DEPTH = 64;

function normalizePathForCompare(target) {
  return path.resolve(target).replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * 判断「这个路径本身」是不是链接（junction / 目录符号链接 / 文件符号链接）。
 *
 * 实测（Node 24 / Windows 11，见 NOTES.md 审计报告）：
 *   - junction：lstat().isSymbolicLink() === false，isDirectory() === true，readlink() 报 EINVAL。
 *   - 目录符号链接 / 文件符号链接：lstat().isSymbolicLink() === true。
 * 所以只靠 lstat 会漏判 junction（历史事故的根因），必须再加一条 realpath 判据：
 * 真实路径与自身路径不一致，说明这一层被 reparse point 重定向过。
 *
 * 该判据可能对 8.3 短名（如 PROGRA~1）产生误报，误报方向是「拒绝删除」，
 * 属于 fail-closed，可接受。
 */
async function isLinkPath(target) {
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
    return normalizePathForCompare(real) !== normalizePathForCompare(target);
  } catch {
    return false;
  }
}

/** 系统级禁区：这些路径任何情况下都不允许被本模块删除。 */
function protectedRoots() {
  const roots = new Set();
  const env = process.env;

  const add = (value) => {
    if (typeof value === 'string' && value.trim() !== '') roots.add(normalizePathForCompare(value));
  };

  add(env.SystemRoot || env.windir || 'C:\\Windows');
  add(env.ProgramFiles);
  add(env['ProgramFiles(x86)']);
  add(env.ProgramData);
  add(env.USERPROFILE);
  add(env.PUBLIC);

  for (const drive of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    roots.add(normalizePathForCompare(`${drive}:\\`));
  }

  return roots;
}

function isProtectedPath(target) {
  const normalized = normalizePathForCompare(target);
  const parsed = path.parse(path.resolve(target));
  if (normalizePathForCompare(parsed.root) === normalized) return true; // 盘根
  for (const root of protectedRoots()) {
    if (normalized === root) return true;
  }
  return false;
}

/** 若给了 allowRoots，目标必须落在其中之一（基于路径关系，不使用字符串前缀拼接）。 */
function isInsideAny(roots, target) {
  if (!Array.isArray(roots) || roots.length === 0) return true;
  return roots.some((root) => {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
  });
}

async function lstatOrThrow(target) {
  try {
    return await fs.lstat(target);
  } catch (err) {
    const e = new Error(`无法读取路径状态：${target}（${err.code || err.message}）`);
    e.cause = err;
    throw e;
  }
}

/**
 * 递归扫描链接（只读，不删除）。
 * 遇到链接就记录并跳过，绝不进入；有深度上限与访问集合，防止环与栈溢出。
 */
async function findLinks(root, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const links = [];
  const errors = [];
  const visited = new Set();

  async function walk(dir, depth) {
    if (depth > maxDepth) {
      errors.push({ path: dir, error: 'MAX_DEPTH' });
      return;
    }
    let real;
    try {
      real = await fs.realpath(dir);
    } catch (err) {
      errors.push({ path: dir, error: err.code || String(err) });
      return;
    }
    if (visited.has(normalizePathForCompare(real))) return;
    visited.add(normalizePathForCompare(real));

    let names;
    try {
      names = await fs.readdir(real);
    } catch (err) {
      errors.push({ path: real, error: err.code || String(err) });
      return;
    }

    for (const name of names) {
      const full = path.join(real, name);
      let stat;
      try {
        stat = await fs.lstat(full); // 不依赖 Dirent
      } catch (err) {
        errors.push({ path: full, error: err.code || String(err) });
        continue;
      }

      if (stat.isSymbolicLink()) {
        links.push(full);
        continue;
      }
      if (!stat.isDirectory()) continue;

      // junction 在这里表现为普通目录，只能靠 realpath 判据识别
      let isReparse = false;
      try {
        const realChild = await fs.realpath(full);
        isReparse = normalizePathForCompare(realChild) !== normalizePathForCompare(full);
      } catch {
        isReparse = false;
      }
      if (isReparse) {
        links.push(full);
        continue;
      }
      await walk(full, depth + 1);
    }
  }

  await walk(root, 0);
  return links;
}

async function scanLinks(root) {
  const real = await fs.realpath(path.resolve(root));
  if (await isLinkPath(path.resolve(root))) return [path.resolve(root)];
  const stat = await lstatOrThrow(real);
  if (!stat.isDirectory()) return [];
  return findLinks(real);
}

/**
 * 只移除链接本身。
 *
 * 用什么 API 取决于该 reparse point 的表现形式，而这一点在不同 Windows 版本 /
 * 文件系统（NTFS vs ReFS vs Dev Drive）上并不一致：
 *   - 有的环境里 junction 的 lstat 报 isDirectory()=true → 用 rmdir
 *   - 有的环境里报 isSymbolicLink()=true / isDirectory()=false → 用 unlink
 * 因此这里先按 lstat 选主要路径，失败再按另一条路径补一次；
 * 两条路都只作用在链接本身，不会触及目标。
 *
 * 返回值统一为 kind: 'link'（linkType 仅作诊断信息），
 * 避免调用方/测试依赖环境相关的差异。
 */
async function removeLink(linkPath) {
  const stat = await lstatOrThrow(linkPath);
  const looksLikeLink =
    stat.isSymbolicLink() ||
    (stat.isDirectory() &&
      normalizePathForCompare(await fs.realpath(linkPath)) !== normalizePathForCompare(linkPath));

  if (!looksLikeLink) {
    // 调用方是依据 realpath 差异进来的，说明它被判定为重定向；
    // 这里再确认不是链接，最常见的原因是 8.3 短名（如 PROGRA~1）造成的误报。
    throw new Error(
      `不是链接，拒绝按链接方式移除：${linkPath}` +
        `（若路径含 8.3 短名，realpath 展开会造成误判；请改用完整长路径重试）`
    );
  }

  const preferDirectoryApi = stat.isDirectory();
  try {
    if (preferDirectoryApi) await fs.rmdir(linkPath);
    else await fs.unlink(linkPath);
  } catch (err) {
    // 换另一条 API 再试一次（仍然只作用于链接本身）
    if (preferDirectoryApi) {
      await fs.unlink(linkPath);
    } else {
      await fs.rmdir(linkPath);
    }
  }

  return { kind: 'link', linkType: preferDirectoryApi ? 'dir' : 'file', removed: linkPath };
}

/**
 * 自底向上逐项删除目录树。
 * 每个条目删除前重新判定链接；发现链接立即抛错停止（宁可删一半，也不越界）。
 */
async function removeTreeBottomUp(dir, options = {}, depth = 0) {
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH;
  if (depth > maxDepth) {
    throw new Error(`目录层级超过上限 ${maxDepth}，拒绝继续删除：${dir}`);
  }

  const names = await fs.readdir(dir);
  for (const name of names) {
    const full = path.join(dir, name);
    const stat = await lstatOrThrow(full);

    if (stat.isSymbolicLink()) {
      throw new Error(`递归删除过程中发现链接，已中止：${full}`);
    }

    if (stat.isDirectory()) {
      const real = await fs.realpath(full);
      if (normalizePathForCompare(real) !== normalizePathForCompare(full)) {
        throw new Error(`递归删除过程中发现 junction/目录链接，已中止：${full} → ${real}`);
      }
      await removeTreeBottomUp(full, options, depth + 1);
      continue;
    }

    await fs.unlink(full);
  }

  if (await isLinkPath(dir)) {
    throw new Error(`删除前发现目标已变成链接，已中止：${dir}`);
  }
  await fs.rmdir(dir);
}

/**
 * 删除一个路径。
 * - 链接：只摘链接本身，绝不触及目标。
 * - 普通文件：unlink。
 * - 普通目录：先全量扫描链接；有任何链接即拒绝；否则自底向上逐项删除。
 *
 * @param {string} target
 * @param {{ allowRoots?: string[], maxDepth?: number }} [options]
 */
async function deletePathSafely(target, options = {}) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new Error('删除目标为空');
  }
  const abs = path.resolve(target);
  const before = await lstatOrThrow(abs);

  if (isProtectedPath(abs)) {
    throw new Error(`拒绝对受保护路径执行删除：${abs}`);
  }

  // 判据 1：lstat 明确报告是符号链接
  if (before.isSymbolicLink()) {
    const result = await removeLink(abs);
    return { ...result, note: '仅移除链接本身，未触及链接目标' };
  }

  // 判据 2（兜底，也是 junction 的可靠判据）：
  // realpath 解析到别处，说明这一层被 reparse point 重定向过。
  // 这一条能覆盖「lstat 把 junction 报成普通目录」的环境，堵死检测失败后误删目标的路。
  const real = await fs.realpath(abs);
  if (normalizePathForCompare(real) !== normalizePathForCompare(abs)) {
    const result = await removeLink(abs);
    return { ...result, note: '仅移除链接本身，未触及链接目标' };
  }

  if (isProtectedPath(real)) {
    throw new Error(`拒绝删除：真实路径属于受保护位置 ${real}`);
  }
  if (!isInsideAny(options.allowRoots, real)) {
    throw new Error(`拒绝删除：${real} 不在允许范围内`);
  }

  // 到这里 real 与 abs 指向同一位置，且未被重定向：可以按普通条目处理
  if (before.isFile()) {
    await fs.unlink(abs);
    return { kind: 'file', removed: abs };
  }

  if (!before.isDirectory()) {
    throw new Error(`拒绝删除非常规条目：${abs}`);
  }

  const links = await findLinks(abs, options);
  if (links.length > 0) {
    throw new Error(
      `拒绝递归删除：${abs} 内含 ${links.length} 个链接（junction / 符号链接），` +
        `例如 ${links.slice(0, 5).join(', ')}。请先单独用 rmdir 移除链接本身，或人工确认后再删。`
    );
  }

  await removeTreeBottomUp(abs, options);
  return { kind: 'tree', removed: abs };
}

module.exports = {
  deletePathSafely,
  removeLink,
  scanLinks,
  findLinks,
  isLinkPath,
  isProtectedPath,
  isInsideAny,
  DEFAULT_MAX_DEPTH,
};

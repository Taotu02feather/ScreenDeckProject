'use strict';

/**
 * 冒烟测试：只测不依赖 Electron 运行时的纯逻辑模块。
 * 覆盖共享状态的夹紧、路径安全、删除安全（junction）、持久化原子写。
 *
 * 运行：npm test
 */

const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { DocState } = require('../src/main/state');
const { isInside, assertInside, assertUserFile } = require('../src/main/paths');
const { deletePathSafely, scanLinks, findLinks, removeLink, isProtectedPath } = require('../src/main/safe-remove');
const { Store } = require('../src/main/store');

const results = [];
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    results.push(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    results.push(`  ✗ ${name}\n      ${err.message}`);
  }
}

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'screendeck-test-'));

  // ── 共享状态 ──────────────────────────────────────────────
  await test('状态初始值合法', () => {
    const state = new DocState();
    const snap = state.snapshot();
    assert.strictEqual(snap.page, 1);
    assert.strictEqual(snap.scroll, 0);
    assert.strictEqual(snap.zoom, 1);
    assert.strictEqual(snap.source.type, 'none');
  });

  await test('越界数值被夹紧', () => {
    const state = new DocState();
    state.patch({ pageCount: 10 });
    const snap = state.patch({ page: 999, scroll: 5, zoom: 999, laser: { x: -3, y: 7 } });
    assert.strictEqual(snap.page, 10, '页码应夹到 pageCount');
    assert.strictEqual(snap.scroll, 1, '滚动应夹到 1');
    assert.strictEqual(snap.zoom, 6, '缩放应夹到上限 6');
    assert.strictEqual(snap.laser.x, 0, '激光 x 应夹到 0');
    assert.strictEqual(snap.laser.y, 1, '激光 y 应夹到 1');
  });

  await test('非法 source 类型被拒绝', () => {
    const state = new DocState();
    const snap = state.patch({ source: { type: 'javascript:' } });
    assert.strictEqual(snap.source.type, 'none');
  });

  await test('切源会复位页码与滚动', () => {
    const state = new DocState();
    state.patch({ pageCount: 20, page: 7, scroll: 0.8, laser: { visible: true } });
    const snap = state.switchSource({ type: 'internal', id: 'abc', kind: 'pdf', title: 'x.pdf' });
    assert.strictEqual(snap.page, 1);
    assert.strictEqual(snap.scroll, 0);
    assert.strictEqual(snap.laser.visible, false);
    assert.strictEqual(snap.source.id, 'abc');
  });

  await test('撤销/恢复持久化字段', () => {
    const state = new DocState();
    state.patch({ pageCount: 12, page: 5, zoom: 1.5, scroll: 0.25 });
    const saved = state.persistable();
    assert.strictEqual(saved.rev, undefined, 'rev 不应持久化');
    const restored = new DocState();
    restored.restore(saved);
    const snap = restored.snapshot();
    assert.strictEqual(snap.page, 5);
    assert.strictEqual(snap.zoom, 1.5);
  });

  await test('广播事件携带快照', () => {
    const state = new DocState();
    let received = null;
    state.once('changed', (snap) => {
      received = snap;
    });
    state.patch({ page: 3 });
    assert.ok(received);
    assert.strictEqual(received.page, 1, 'pageCount 为 0 时页码仍被夹到 1');
  });

  // ── 路径安全 ──────────────────────────────────────────────
  await test('isInside 不把同前缀兄弟目录误判为子路径', () => {
    assert.strictEqual(isInside('C:\\data\\e', 'C:\\data\\e\\file.pdf'), true);
    assert.strictEqual(isInside('C:\\data\\e', 'C:\\data\\evil\\file.pdf'), false, '前缀匹配陷阱');
    assert.strictEqual(isInside('C:\\data\\e', 'C:\\data\\e'), true);
    assert.strictEqual(isInside('C:\\data\\e', 'C:\\data'), false);
  });

  await test('assertInside 用真实路径判断，拒绝对外越界', async () => {
    const inside = path.join(tmpRoot, 'inside');
    const outside = path.join(tmpRoot, 'outside');
    await fsp.mkdir(inside);
    await fsp.mkdir(outside);
    const file = path.join(outside, 'secret.txt');
    await fsp.writeFile(file, 'x');

    const ok = await assertInside(inside, path.join(inside));
    assert.ok(ok);

    await assert.rejects(
      () => assertInside(inside, file),
      /越界/,
      '外部文件必须被拒绝'
    );
  });

  await test('assertUserFile 拒绝目录与不存在路径', async () => {
    const dir = path.join(tmpRoot, 'adir');
    await fsp.mkdir(dir);
    await assert.rejects(() => assertUserFile(dir), /不是普通文件/);
    await assert.rejects(() => assertUserFile(path.join(tmpRoot, 'nope.txt')), /无法解析路径/);
    await assert.rejects(() => assertUserFile('relative.txt'), /绝对路径/);
  });

  await test('assertUserFile 返回真实路径（解析符号链接）', async () => {
    const realDir = path.join(tmpRoot, 'real');
    await fsp.mkdir(realDir);
    const realFile = path.join(realDir, 'doc.pdf');
    await fsp.writeFile(realFile, '%PDF-1.4');
    const link = path.join(tmpRoot, 'link.pdf');
    try {
      await fsp.symlink(realFile, link, 'file');
    } catch {
      return; // 无权限创建符号链接时跳过
    }
    const { realPath } = await assertUserFile(link);
    assert.strictEqual(realPath.toLowerCase(), realFile.toLowerCase());
  });

  // ── 删除安全 ──────────────────────────────────────────────
  await test('递归删除前能发现 junction', async () => {
    const target = path.join(tmpRoot, 'junction-target');
    const container = path.join(tmpRoot, 'container');
    await fsp.mkdir(target);
    await fsp.mkdir(container);
    await fsp.writeFile(path.join(target, 'keep.txt'), 'important');

    const junction = path.join(container, 'link-dir');
    try {
      await fsp.symlink(target, junction, 'junction');
    } catch {
      return; // 环境不允许创建 junction 时跳过
    }

    const links = await scanLinks(container);
    assert.strictEqual(links.length, 1, '应扫描到一个链接');

    await assert.rejects(
      () => deletePathSafely(container),
      /拒绝递归删除/,
      '含链接的目录必须拒绝递归删除'
    );

    const stillThere = fs.existsSync(path.join(target, 'keep.txt'));
    assert.strictEqual(stillThere, true, '链接目标不得被波及');
  });

  await test('清理普通目录可以成功', async () => {
    const dir = path.join(tmpRoot, 'plain');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'a.txt'), 'a');
    const result = await deletePathSafely(dir);
    assert.strictEqual(result.kind, 'tree');
    assert.strictEqual(fs.existsSync(dir), false);
  });

  await test('深层嵌套里的 junction 也能被发现', async () => {
    const target = path.join(tmpRoot, 'deep-target');
    const deep = path.join(tmpRoot, 'deep', 'a', 'b', 'c');
    await fsp.mkdir(target, { recursive: true });
    await fsp.mkdir(deep, { recursive: true });
    try {
      await fsp.symlink(target, path.join(deep, 'link'), 'junction');
    } catch {
      return;
    }
    const links = await scanLinks(path.join(tmpRoot, 'deep'));
    assert.strictEqual(links.length, 1, '第 4 层目录里的 junction 也应被发现');
    await assert.rejects(() => deletePathSafely(path.join(tmpRoot, 'deep')), /拒绝递归删除/);
    assert.strictEqual(fs.existsSync(target), true, '链接目标不得被删除');
  });

  await test('子树内的文件符号链接同样导致拒绝删除', async () => {
    const container = path.join(tmpRoot, 'container2');
    await fsp.mkdir(container, { recursive: true });
    const outsideFile = path.join(tmpRoot, 'outside-file.txt');
    await fsp.writeFile(outsideFile, 'keep');
    try {
      await fsp.symlink(outsideFile, path.join(container, 'link.txt'), 'file');
    } catch {
      return;
    }
    await assert.rejects(() => deletePathSafely(container), /拒绝递归删除/);
    assert.strictEqual(fs.existsSync(outsideFile), true, '链接指向的文件必须完好');
  });

  await test('删除链接本身时只摘链接、不碰目标', async () => {
    const target = path.join(tmpRoot, 'link-target2');
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(target, 'data.txt'), 'x');
    const link = path.join(tmpRoot, 'a-junction');
    try {
      await fsp.symlink(target, link, 'junction');
    } catch {
      return;
    }
    const result = await deletePathSafely(link);
    // kind 统一为 'link'；linkType 只是诊断信息，不同 Windows/文件系统下可能是 dir 或 file
    assert.strictEqual(result.kind, 'link', '链接应走「只摘链接」分支');
    assert.ok(result.linkType === 'dir' || result.linkType === 'file', `linkType 异常：${result.linkType}`);
    assert.strictEqual(fs.existsSync(link), false, '链接本身应被移除');
    assert.strictEqual(fs.existsSync(path.join(target, 'data.txt')), true, '链接目标内容必须完好');
  });

  await test('盘根与系统目录被识别为受保护路径', () => {
    const root = path.parse(tmpRoot).root;
    assert.strictEqual(isProtectedPath(root), true, '盘根必须受保护');
    assert.strictEqual(isProtectedPath(path.join(root, 'Windows')), true, 'Windows 目录必须受保护');
  });

  await test('删除盘根被拒绝', async () => {
    const root = path.parse(tmpRoot).root;
    await assert.rejects(() => deletePathSafely(root), /受保护|拒绝/);
  });

  await test('allowRoots 之外的目标被拒绝且不受损', async () => {
    const dir = path.join(tmpRoot, 'not-allowed');
    const zone = path.join(tmpRoot, 'allowed-zone');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.mkdir(zone, { recursive: true });
    await assert.rejects(() => deletePathSafely(dir, { allowRoots: [zone] }), /不在允许范围内/);
    assert.strictEqual(fs.existsSync(dir), true, '拒绝后目录必须还在');
  });

  await test('多层目录可正常删除且不留残留', async () => {
    const deep = path.join(tmpRoot, 'plain-deep', 'x', 'y', 'z');
    await fsp.mkdir(deep, { recursive: true });
    await fsp.writeFile(path.join(deep, 'f.txt'), 'f');
    const result = await deletePathSafely(path.join(tmpRoot, 'plain-deep'));
    assert.strictEqual(result.kind, 'tree');
    assert.strictEqual(fs.existsSync(path.join(tmpRoot, 'plain-deep')), false);
  });

  // ── 持久化 ────────────────────────────────────────────────
  await test('Store 能写入并重新读回', async () => {
    const dir = path.join(tmpRoot, 'userdata');
    const store = new Store();
    store.init(dir);
    await store.load();
    store.setLayout({ mirror: { x: 10, y: 20, width: 300, height: 200 } });
    store.setDocuments([{ id: 'a1', title: 'demo.md', path: 'D:\\x\\demo.md', kind: 'markdown' }]);
    await store.flush();

    const again = new Store();
    again.init(dir);
    const data = await again.load();
    assert.strictEqual(data.layout.mirror.width, 300);
    assert.strictEqual(data.documents.length, 1);
    assert.strictEqual(data.documents[0].id, 'a1');
  });

  await test('损坏的配置文件不会让启动崩溃（会打印一条预期的告警）', async () => {
    const dir = path.join(tmpRoot, 'broken');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'screendeck-state.json'), '{ not json');
    const store = new Store();
    store.init(dir);

    // 这个用例故意喂坏 JSON 验证降级；store 会打一条 warn，属于预期输出，
    // 测试期间静音，避免它混进测试结果被误读成"环境配置坏了"。
    const originalError = console.error;
    console.error = () => {};
    let data;
    try {
      data = await store.load();
    } finally {
      console.error = originalError;
    }
    assert.ok(data && data.layout, '应回退到默认值');
  });

  // 清理：必须先摘掉所有链接，再删目录。
  // 直接 fs.rm(recursive) 会试图穿过 junction（实测报 ENOTEMPTY，且可能删到目标里），
  // 所以这里正好用被测代码来收尾（dogfooding）。
  try {
    const leftover = await findLinks(tmpRoot);
    for (const link of leftover) {
      await removeLink(link).catch(() => {});
    }
    await deletePathSafely(tmpRoot, { allowRoots: [path.parse(tmpRoot).root] }).catch(() => {});
  } catch {
    // 清理失败不影响测试结论
  }

  console.log('\nScreenDeck 冒烟测试\n');
  console.log(results.join('\n'));
  console.log(failed === 0 ? `\n✓ 全部通过（${results.length} 项）\n` : `\n✗ ${failed} 项失败\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试运行器崩溃：', err);
  process.exit(1);
});

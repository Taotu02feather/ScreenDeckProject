'use strict';

/**
 * 内容源注册表。
 *
 * 两类源：
 *  - internal：PDF / Markdown / 图片，由主进程读文件后交给两个视图各自渲染（不走截屏）。
 *  - external：第三方应用窗口，通过 desktopCapturer 只读镜像到大屏。
 *
 * 路径处理一律先 realpath 再校验，且每次读取都重新解析，防止 TOCTOU。
 */

const path = require('node:path');
const crypto = require('node:crypto');
const { dialog, desktopCapturer } = require('electron');

const { assertUserFile, readUserFile } = require('./paths');

const EXT_KIND = {
  '.pdf': 'pdf',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'markdown',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
};

const DIALOG_FILTERS = [
  { name: '演示文档（PDF / Markdown）', extensions: ['pdf', 'md', 'markdown', 'txt'] },
  { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
  {
    name: '全部支持的文件',
    extensions: ['pdf', 'md', 'markdown', 'txt', 'png', 'jpg', 'jpeg', 'webp', 'gif'],
  },
];

class SourceRegistry {
  constructor({ docState, wm, store }) {
    this.docState = docState;
    this.wm = wm;
    this.store = store;
    /** id -> { id, title, path, kind, addedAt } */
    this.documents = new Map();
  }

  hydrate(list) {
    for (const doc of Array.isArray(list) ? list : []) {
      if (!doc || typeof doc.id !== 'string' || typeof doc.path !== 'string') continue;
      if (!EXT_KIND[path.extname(doc.path).toLowerCase()]) continue;
      this.documents.set(doc.id, {
        id: doc.id,
        title: typeof doc.title === 'string' ? doc.title : path.basename(doc.path),
        path: doc.path,
        kind: doc.kind || EXT_KIND[path.extname(doc.path).toLowerCase()],
        addedAt: doc.addedAt || Date.now(),
      });
    }
  }

  list() {
    return [...this.documents.values()].map((d) => ({
      id: d.id,
      title: d.title,
      path: d.path,
      kind: d.kind,
    }));
  }

  async addFile(filePath) {
    const { realPath } = await assertUserFile(filePath);
    const ext = path.extname(realPath).toLowerCase();
    const kind = EXT_KIND[ext];
    if (!kind) throw new Error(`不支持的文件类型：${ext || '(无扩展名)'}`);
    const id = crypto.createHash('sha1').update(realPath).digest('hex').slice(0, 12);
    const doc = { id, title: path.basename(realPath), path: realPath, kind, addedAt: Date.now() };
    this.documents.set(id, doc);
    this.store.setDocuments(this.list());
    return { id, title: doc.title, kind: doc.kind };
  }

  async openDialog(parentWindow) {
    const result = await dialog.showOpenDialog(parentWindow, {
      title: '选择要演示的文档',
      properties: ['openFile', 'multiSelections'],
      filters: DIALOG_FILTERS,
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, added: [] };

    const added = [];
    const errors = [];
    for (const filePath of result.filePaths) {
      try {
        added.push(await this.addFile(filePath));
      } catch (err) {
        errors.push({ path: filePath, message: err.message });
      }
    }
    if (added.length > 0) {
      const last = added[added.length - 1];
      this.selectDocument(last.id);
    }
    return { canceled: false, added, errors };
  }

  /**
   * 读取文档内容给渲染层。
   * 用句柄读取（open -> fstat -> read），而不是先校验路径再按路径读，
   * 避免校验与读取之间路径被替换成指向别处的链接（TOCTOU）。
   */
  async load(id) {
    const doc = this.documents.get(id);
    if (!doc) throw new Error(`文档不存在：${id}`);
    const { buffer } = await readUserFile(doc.path);
    return {
      id: doc.id,
      kind: doc.kind,
      title: doc.title,
      data: buffer,
    };
  }

  selectDocument(id) {
    const doc = this.documents.get(id);
    if (!doc) throw new Error(`文档不存在：${id}`);
    this.wm.captureWindowId = null;
    return this.docState.switchSource({ type: 'internal', id: doc.id, kind: doc.kind, title: doc.title });
  }

  removeDocument(id) {
    this.documents.delete(id);
    this.store.setDocuments(this.list());
    return { documents: this.list(), currentSource: this.docState.snapshot().source };
  }

  /** 外部窗口列表：带缩略图，供控制台侧栏展示。 */
  async listWindows() {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 480, height: 270 },
      fetchWindowIcons: true,
    });

    return sources
      .filter((s) => s.name && s.id)
      // 不把自己（控制台/大屏）列进可投送窗口，避免自捕获
      .filter((s) => !/ScreenDeck/i.test(s.name))
      .map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
        appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '',
      }));
  }

  selectWindow({ id, name }) {
    if (typeof id !== 'string' || !id) throw new Error('无效的窗口 id');
    this.wm.captureWindowId = id;
    return this.docState.switchSource({
      type: 'external',
      windowId: id,
      kind: 'window',
      title: typeof name === 'string' ? name : '外部窗口',
    });
  }

  async resolveCaptureSource(windowId) {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1, height: 1 },
    });
    return sources.find((s) => s.id === windowId) || null;
  }

  /** 重启后恢复上次内容源；文档已被移动/删除时静默跳过。 */
  async restoreLast(source) {
    if (!source || source.type !== 'internal' || !source.id) return;
    if (!this.documents.has(source.id)) return;
    try {
      await this.load(source.id);
      const doc = this.documents.get(source.id);
      this.docState.switchSource({ type: 'internal', id: doc.id, kind: doc.kind, title: doc.title });
    } catch (err) {
      console.warn('[sources] 上次的内容源无法恢复：', err.message);
    }
  }
}

module.exports = { SourceRegistry };

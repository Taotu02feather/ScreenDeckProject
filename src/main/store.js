'use strict';

/**
 * 配置持久化：窗口布局、映射窗位置/大小、上次内容源、偏好设置。
 * 落盘在 app.getPath('userData')/screendeck-state.json，写入用 tmp + rename，
 * 避免写到一半断电留下半个 JSON 把下次启动搞崩。
 */

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const SCHEMA = 1;

function defaultData() {
  return {
    schema: SCHEMA,
    docState: {},
    documents: [],
    layout: {
      console: null,
      mirror: null,
      mirrorMaximized: false,
    },
    prefs: {
      laserDurationMs: 2200,
      openOnStart: true,
    },
  };
}

class Store {
  constructor() {
    this.file = null;
    this.data = defaultData();
    this.timer = null;
  }

  init(userDataDir) {
    this.file = path.join(userDataDir, 'screendeck-state.json');
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const base = defaultData();
        this.data = {
          ...base,
          ...parsed,
          layout: { ...base.layout, ...(parsed.layout || {}) },
          prefs: { ...base.prefs, ...(parsed.prefs || {}) },
        };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[store] 读取配置失败，使用默认值：', err.message);
      }
    }
    return this.data;
  }

  setDocState(value) {
    this.data.docState = value;
    this.schedule();
  }

  setDocuments(list) {
    this.data.documents = list;
    this.schedule();
  }

  setLayout(partial) {
    this.data.layout = { ...this.data.layout, ...partial };
    this.schedule();
  }

  setPrefs(partial) {
    this.data.prefs = { ...this.data.prefs, ...partial };
    this.schedule();
  }

  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err) => console.error('[store] 写入失败：', err.message));
    }, 400);
  }

  async flush() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      await fs.rename(tmp, this.file);
    } catch (err) {
      console.error('[store] 原子写失败：', err.message);
    }
  }

  /** 退出时同步落盘，避免 debounce 未触发就退出丢配置。 */
  flushSync() {
    if (!this.file || !this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    try {
      fsSync.mkdirSync(path.dirname(this.file), { recursive: true });
      fsSync.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fsSync.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] 退出前落盘失败：', err.message);
    }
  }
}

module.exports = { Store };

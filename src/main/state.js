'use strict';

/**
 * 共享文档状态 —— ScreenDeck 的唯一真相来源（single source of truth）。
 *
 * 大屏输出窗口和本地映射窗都是这份状态的“视图”，谁都不持有自己的副本：
 * 主进程 patch -> 广播 -> 两个视图各自重渲染。
 * 因此永远不需要 desktopCapturer 去抓自己的大屏窗口。
 */

const { EventEmitter } = require('node:events');

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 6;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

const finite = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function blankSource() {
  return { type: 'none', id: null, kind: null, title: '', windowId: null };
}

function pickSource(src) {
  const out = {};
  if (src.type !== undefined) {
    out.type = ['none', 'internal', 'external'].includes(src.type) ? src.type : 'none';
  }
  if (src.id !== undefined) out.id = typeof src.id === 'string' ? src.id : null;
  if (src.kind !== undefined) out.kind = typeof src.kind === 'string' ? src.kind : null;
  if (src.title !== undefined) out.title = typeof src.title === 'string' ? src.title.slice(0, 200) : '';
  if (src.windowId !== undefined) out.windowId = typeof src.windowId === 'string' ? src.windowId : null;
  return out;
}

function createState() {
  return {
    rev: 0,
    source: blankSource(),
    page: 1,
    pageCount: 0,
    scroll: 0,
    zoom: 1,
    mirrorZoom: 1,
    laser: { x: 0.5, y: 0.5, visible: false, at: 0 },
  };
}

class DocState extends EventEmitter {
  constructor() {
    super();
    this.state = createState();
  }

  snapshot() {
    return {
      ...this.state,
      source: { ...this.state.source },
      laser: { ...this.state.laser },
    };
  }

  /**
   * 只接受白名单字段；所有数值都夹紧到合法区间。
   * 渲染层拿到的状态永远可用，不会因为一次坏数据白屏。
   */
  patch(input) {
    if (!input || typeof input !== 'object') return this.snapshot();
    const s = this.state;

    if (input.source && typeof input.source === 'object') {
      s.source = { ...s.source, ...pickSource(input.source) };
    }

    if (input.pageCount !== undefined) {
      s.pageCount = Math.max(0, Math.trunc(finite(input.pageCount, s.pageCount)));
      s.page = clamp(s.page, 1, Math.max(1, s.pageCount));
    }

    if (input.page !== undefined) {
      const max = Math.max(1, s.pageCount);
      s.page = clamp(Math.round(finite(input.page, s.page)), 1, max);
    }

    if (input.scroll !== undefined) {
      s.scroll = clamp(finite(input.scroll, s.scroll), 0, 1);
    }

    if (input.zoom !== undefined) {
      s.zoom = clamp(finite(input.zoom, s.zoom), ZOOM_MIN, ZOOM_MAX);
    }

    if (input.mirrorZoom !== undefined) {
      s.mirrorZoom = clamp(finite(input.mirrorZoom, s.mirrorZoom), ZOOM_MIN, ZOOM_MAX);
    }

    if (input.laser && typeof input.laser === 'object') {
      const l = input.laser;
      s.laser = {
        x: clamp(finite(l.x, s.laser.x), 0, 1),
        y: clamp(finite(l.y, s.laser.y), 0, 1),
        visible: l.visible !== false,
        at: Date.now(),
      };
    }

    s.rev += 1;
    const snap = this.snapshot();
    this.emit('changed', snap);
    return snap;
  }

  /** 换内容源时复位与“旧文档”绑定的状态，避免跨文档残留页码/滚动/激光点/缩放。 */
  switchSource(source) {
    const s = this.state;
    s.source = { ...blankSource(), ...pickSource(source) };
    s.page = 1;
    s.pageCount = 0;
    s.scroll = 0;
    // 缩放必须复位：否则上一份文档调大的倍数会带过来，新文档一打开就只看到一角
    s.zoom = 1;
    s.mirrorZoom = 1;
    s.laser = { x: 0.5, y: 0.5, visible: false, at: 0 };
    s.rev += 1;
    const snap = this.snapshot();
    this.emit('changed', snap);
    return snap;
  }

  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    const s = this.state;
    if (saved.source) s.source = { ...blankSource(), ...pickSource(saved.source) };
    if (saved.pageCount !== undefined) s.pageCount = Math.max(0, Math.trunc(finite(saved.pageCount, 0)));
    if (saved.page !== undefined) s.page = clamp(Math.round(finite(saved.page, 1)), 1, Math.max(1, s.pageCount));
    if (saved.scroll !== undefined) s.scroll = clamp(finite(saved.scroll, 0), 0, 1);
    if (saved.zoom !== undefined) s.zoom = clamp(finite(saved.zoom, 1), ZOOM_MIN, ZOOM_MAX);
    if (saved.mirrorZoom !== undefined) s.mirrorZoom = clamp(finite(saved.mirrorZoom, 1), ZOOM_MIN, ZOOM_MAX);

    // 启动一律回到 100%：残留的大缩放会让文档一打开就只显示一角，是最容易误解成"渲染坏了"的情况
    s.zoom = 1;
    s.mirrorZoom = 1;
    s.scroll = 0;
  }

  /** 只持久化“重启后还该存在”的字段，rev/laser 是瞬时量。 */
  persistable() {
    const s = this.state;
    return {
      source: { ...s.source },
      page: s.page,
      pageCount: s.pageCount,
      scroll: s.scroll,
      zoom: s.zoom,
      mirrorZoom: s.mirrorZoom,
    };
  }
}

module.exports = { DocState, ZOOM_MIN, ZOOM_MAX };

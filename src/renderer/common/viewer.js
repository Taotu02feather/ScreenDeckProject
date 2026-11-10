'use strict';

/**
 * 共享渲染器。
 *
 * 大屏输出窗口和本地映射窗加载的是同一份 viewer.js，输入都是主进程广播的同一份状态，
 * 所以两边永远显示同样的内容 —— 不需要截屏，也不需要同步两份 DOM。
 *
 * 内容按矢量方式重渲染（PDF 用 canvas 按目标分辨率重画，Markdown/图片直接缩放），
 * 因此映射窗放大缩小后依然清晰。
 */

(function attachViewer(global) {
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 6;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function toText(data) {
    if (typeof data === 'string') return data;
    if (data instanceof Uint8Array) return new TextDecoder('utf-8').decode(data);
    if (data instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(new Uint8Array(data));
    return '';
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(0);
  }

  class Viewer {
    constructor(root, options = {}) {
      this.root = root;
      this.options = options;
      this.root.classList.add('sd-viewer');
      this.stage = el('div', 'sd-stage');
      this.root.appendChild(this.stage);

      this.kind = 'none';
      this.docKey = null;
      this.token = 0;
      this.renderToken = 0;
      this.geomKey = '';
      this.pdf = null;
      this.pageCount = 0;
      this.chapters = [];
      this.contentHeight = 0;
      this.localZoom = 1;
      this.lastState = null;
      this.reportedPageCount = 0;

      this.canvas = null;
      this.canvasWrap = null;
      this.mdInner = null;
      this.imgEl = null;
      this.imageUrl = null;
      this.videoEl = null;
      this.stream = null;

      this.showPlaceholder('尚未选择内容源');
      this.pending = null;
      this.applying = false;
      this.current = Promise.resolve();

      if (typeof ResizeObserver === 'function') {
        this.resizeObserver = new ResizeObserver(() => {
          this.geomKey = '';
          if (this.lastState) this.paint(this.lastState).catch(() => {});
        });
        this.resizeObserver.observe(this.stage);
      }
    }

    // ── 公共 API ────────────────────────────────────────────

    setLocalZoom(value) {
      this.localZoom = clamp(value, ZOOM_MIN, ZOOM_MAX);
    }

    getLocalZoom() {
      return this.localZoom;
    }

    getChapters() {
      return this.chapters;
    }

    /** 可滚动像素高度（内容高 - 视口高）。映射窗的手势换算需要它。 */
    getScrollRange() {
      return Math.max(0, this.contentHeight - this.stage.clientHeight);
    }

    getPageCount() {
      return this.pageCount;
    }

    destroy() {
      this.token += 1;
      this.teardown();
      if (this.resizeObserver) this.resizeObserver.disconnect();
      this.root.replaceChildren();
    }

    // ── 生命周期 ────────────────────────────────────────────

    /**
     * 状态驱动入口。
     * 用「覆盖最新状态 + 串行排空」代替并发 apply：连续拖动会产生大量状态，
     * 只渲染最后一次，且 PDF 不会有两帧同时争用同一个 canvas。
     */
    apply(state) {
      this.lastState = state;
      this.pending = state;
      if (!this.applying) {
        this.applying = true;
        this.current = this.drain().finally(() => {
          this.applying = false;
        });
      }
      return this.current;
    }

    async drain() {
      while (this.pending) {
        const state = this.pending;
        this.pending = null;
        const source = state.source || {};
        // captureNonce 变化时强制重建（用于捕获画面异常时重连）
        const key = [source.type, source.id || '', source.windowId || '', source.kind || '', state.captureNonce || 0].join('|');
        if (key !== this.docKey) {
          this.docKey = key;
          await this.mount(source);
        }
        await this.paint(state);
      }
    }

    async mount(source) {
      const token = ++this.token;
      this.teardown();
      this.kind = 'none';
      this.pageCount = 0;
      this.chapters = [];
      this.contentHeight = 0;
      this.geomKey = '';

      try {
        if (source.type === 'internal' && source.id) {
          const doc = await global.screenDeck.loadDocument(source.id);
          if (token !== this.token) return;
          if (doc.kind === 'pdf') await this.mountPdf(doc, token);
          else if (doc.kind === 'markdown') this.mountMarkdown(doc);
          else if (doc.kind === 'image') this.mountImage(doc);
          else this.showPlaceholder(`不支持的内容类型：${doc.kind}`);
        } else if (source.type === 'external' && source.windowId) {
          await this.mountStream(token);
        } else {
          this.showPlaceholder('尚未选择内容源');
        }
      } catch (err) {
        if (token !== this.token) return;
        console.error('[viewer] 加载内容失败：', err);
        this.showPlaceholder(`加载失败：${err.message}`);
        return;
      }

      if (this.pageCount > 0 && this.pageCount !== this.reportedPageCount && global.screenDeck.patch) {
        this.reportedPageCount = this.pageCount;
        global.screenDeck.patch({ pageCount: this.pageCount });
      }
    }

    showPlaceholder(text) {
      this.stage.replaceChildren();
      const box = el('div', 'sd-placeholder');
      const title = el('div', 'sd-placeholder-title');
      title.textContent = text;
      const hint = el('div', 'sd-placeholder-hint');
      hint.textContent = this.options.hint || '从左侧「文档」或「窗口」选择内容源';
      box.append(title, hint);
      this.stage.appendChild(box);
      this.contentHeight = 0;
    }

    // ── PDF ────────────────────────────────────────────────

    async mountPdf(doc, token) {
      if (!global.pdfjsLib) throw new Error('pdf.js 未加载，请确认已执行 npm install');
      const bytes = toBytes(doc.data);

      // TODO: 明天重点排查 —— file:// 页面下 pdf.worker.min.js 能否加载。
      // 若 worker 拉不起来，pdf.js 会抛 DOMException；届时检查 workerSrc 与协议 origin。
      let pdf;
      const base = global.location ? global.location.origin : '';
      try {
        pdf = await global.pdfjsLib.getDocument({
          data: bytes,
          isEvalSupported: false,
          // 中文等非嵌入式字体 / CMap 需要从本地加载，否则部分 PDF 会缺字
          cMapUrl: `${base}/node_modules/pdfjs-dist/cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${base}/node_modules/pdfjs-dist/standard_fonts/`,
        }).promise;
      } catch (err) {
        const workerSrc = global.pdfjsLib.GlobalWorkerOptions.workerSrc || '(未设置)';
        throw new Error(`PDF 加载失败：${err && err.message ? err.message : err}；workerSrc=${workerSrc}`);
      }

      if (token !== this.token) {
        pdf.destroy();
        return;
      }
      this.pdf = pdf;
      this.pageCount = pdf.numPages;
      this.kind = 'pdf';

      this.stage.replaceChildren();
      this.canvasWrap = el('div', 'sd-page');
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'sd-canvas';
      this.canvasWrap.appendChild(this.canvas);
      this.stage.appendChild(this.canvasWrap);
    }

    async paintPdf(state, token) {
      if (!this.pdf || !this.canvas) return;
      const width = this.stage.clientWidth;
      const height = this.stage.clientHeight;
      if (width < 2 || height < 2) return;

      const pageNo = clamp(Math.round(state.page || 1), 1, this.pageCount || 1);
      const scaleFactor = clamp(state.zoom || 1, ZOOM_MIN, ZOOM_MAX) * this.localZoom;
      const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
      const geomKey = `${pageNo}|${width}|${height}|${scaleFactor.toFixed(4)}|${dpr}`;

      if (geomKey === this.geomKey) {
        this.applyScrollOffset(state);
        return;
      }
      this.geomKey = geomKey;
      const renderToken = ++this.renderToken;

      const page = await this.pdf.getPage(pageNo);
      if (renderToken !== this.renderToken || token !== this.token) return;

      const base = page.getViewport({ scale: 1 });
      // 按宽度铺满：整页宽度充满视口，纵向可滚动。想整页看全就按 F 或点「适配」。
      const fitScale = width / base.width;
      const viewport = page.getViewport({ scale: fitScale * scaleFactor });

      const canvas = this.canvas;
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const context = canvas.getContext('2d', { alpha: false });
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);

      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
      // pdf.js 的 render 参数里 transform 必须是数组或完全不传；传 null 在部分版本会抛错
      const renderParams = { canvasContext: context, viewport };
      if (transform) renderParams.transform = transform;
      await page.render(renderParams).promise;
      if (renderToken !== this.renderToken || token !== this.token) return;

      this.contentHeight = Math.floor(viewport.height);

      console.log(
        `[viewer] pdf canvas=${Math.floor(viewport.width)}x${Math.floor(viewport.height)} stage=${width}x${height} scale=${scaleFactor.toFixed(3)} scroll=${(state.scroll || 0).toFixed(3)}`
      );

      this.applyScrollOffset(state);
    }

    applyScrollOffset(state) {
      if (!this.canvasWrap) return;
      const height = this.stage.clientHeight;
      const overflow = Math.max(0, this.contentHeight - height);
      const scroll = clamp(state.scroll || 0, 0, 1);

      let offset;
      if (overflow > 0) {
        offset = -(scroll * overflow);
      } else {
        // 内容比视口矮时垂直居中，避免贴着顶部
        offset = Math.max(0, (height - this.contentHeight) / 2);
      }
      this.canvasWrap.style.transform = `translateY(${offset.toFixed(1)}px)`;
    }

    // ── Markdown ───────────────────────────────────────────

    mountMarkdown(doc) {
      if (!global.marked) throw new Error('marked 未加载，请确认已执行 npm install');
      const text = toText(doc.data);
      const html = global.marked.parse(text, { mangle: false, headerIds: true });

      this.kind = 'markdown';
      this.stage.replaceChildren();
      this.mdInner = el('div', 'sd-markdown');
      this.mdInner.innerHTML = html;
      this.stage.appendChild(this.mdInner);

      this.chapters = [...this.mdInner.querySelectorAll('h1, h2, h3')].map((node, index) => ({
        index,
        level: Number(node.tagName.slice(1)),
        title: node.textContent || '',
        top: node.offsetTop,
      }));
      this.contentHeight = this.mdInner.scrollHeight;
    }

    paintMarkdown(state) {
      if (!this.mdInner) return;
      this.contentHeight = this.mdInner.scrollHeight;
      const overflow = Math.max(0, this.contentHeight - this.stage.clientHeight);
      const offset = clamp(state.scroll || 0, 0, 1) * overflow;
      this.mdInner.style.transform = `translateY(${-offset.toFixed(1)}px)`;
    }

    // ── 图片 ───────────────────────────────────────────────

    mountImage(doc) {
      if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
      this.kind = 'image';
      const bytes = toBytes(doc.data);
      const blob = new Blob([bytes]);
      this.imageUrl = URL.createObjectURL(blob);

      this.stage.replaceChildren();
      this.imgEl = document.createElement('img');
      this.imgEl.className = 'sd-image';
      this.imgEl.src = this.imageUrl;
      this.imgEl.alt = doc.title || '';
      this.stage.appendChild(this.imgEl);
      this.contentHeight = 0;
    }

    paintImage(state) {
      if (!this.imgEl) return;
      const zoom = clamp(state.zoom || 1, ZOOM_MIN, ZOOM_MAX) * this.localZoom;
      this.imgEl.style.transform = `scale(${zoom.toFixed(3)})`;
    }

    // ── 外部窗口（只读镜像）─────────────────────────────────

    async mountStream(token) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        throw new Error('当前环境不支持窗口捕获');
      }

      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 },
          audio: false,
        });
      } catch (err) {
        const name = err && err.name ? err.name : 'Error';
        const message = err && err.message ? err.message : String(err);
        throw new Error(`窗口捕获失败（${name}）：${message}`);
      }
      if (token !== this.token) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.stream = stream;
      this.kind = 'window';
      this.stage.replaceChildren();
      this.videoEl = document.createElement('video');
      this.videoEl.className = 'sd-video';
      this.videoEl.muted = true;
      this.videoEl.autoplay = true;
      this.videoEl.playsInline = true;
      this.videoEl.srcObject = stream;
      this.stage.appendChild(this.videoEl);
      this.videoEl.play().catch(() => {});
      this.contentHeight = 0;

      const track = stream.getVideoTracks()[0];
      if (track) {
        track.addEventListener('ended', () => {
          this.stream = null;
          this.showPlaceholder('窗口捕获已结束');
        });
      }
    }

    paintStream(state) {
      if (!this.videoEl) return;
      // 外部窗口只跟随共享缩放，不叠加映射窗的本地缩放：
      // 否则映射窗和实时大屏的取景会不一致，点击换算也会错位。
      const zoom = clamp(state.zoom || 1, ZOOM_MIN, ZOOM_MAX);
      this.videoEl.style.transform = `scale(${zoom.toFixed(3)})`;
    }

    // ── 分发 ───────────────────────────────────────────────

    async paint(state) {
      const token = this.token;
      if (this.kind === 'pdf') await this.paintPdf(state, token);
      else if (this.kind === 'markdown') this.paintMarkdown(state);
      else if (this.kind === 'image') this.paintImage(state);
      else if (this.kind === 'window') this.paintStream(state);
    }

    teardown() {
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      if (this.videoEl) {
        this.videoEl.srcObject = null;
        this.videoEl = null;
      }
      if (this.imageUrl) {
        URL.revokeObjectURL(this.imageUrl);
        this.imageUrl = null;
      }
      if (this.pdf) {
        this.pdf.destroy().catch(() => {});
        this.pdf = null;
      }
      this.canvas = null;
      this.canvasWrap = null;
      this.mdInner = null;
      this.imgEl = null;
      this.renderToken += 1;
    }
  }

  global.Viewer = Viewer;
})(window);

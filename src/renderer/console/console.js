'use strict';

/**
 * 控制台窗口。
 *
 * 这里不渲染“大屏的截图”，而是挂载同一份 Viewer —— 读者看到的映射窗，
 * 是大屏那份共享状态的第二个渲染实例。所有手势都只改共享状态，由主进程广播回两边。
 */

(function main() {
  const sd = window.screenDeck;

  const dom = {
    stage: document.getElementById('stage'),
    mirror: document.getElementById('mirror'),
    mirrorHeader: document.getElementById('mirror-header'),
    mirrorBody: document.getElementById('mirror-body'),
    mirrorTitle: document.getElementById('mirror-title'),
    mirrorStatus: document.getElementById('mirror-status'),
    docList: document.getElementById('doc-list'),
    windowList: document.getElementById('window-list'),
    displays: document.getElementById('displays'),
    sourceSummary: document.getElementById('source-summary'),
    statusSource: document.getElementById('status-source'),
    statusPage: document.getElementById('status-page'),
    statusZoom: document.getElementById('status-zoom'),
    btnOpenDocs: document.getElementById('btn-open-docs'),
    btnRefreshWindows: document.getElementById('btn-refresh-windows'),
    btnToggleOutput: document.getElementById('btn-toggle-output'),
  };

  if (window.pdfjsLib) {
    const buildBase = new URL('../../../node_modules/pdfjs-dist/build/', document.baseURI).href;
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.js', buildBase).href;
  }

  const viewer = new window.Viewer(dom.mirrorBody);

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  let state = null;
  let layout = { mirror: null, mirrorMaximized: false };
  let localZoom = 1;
  let pendingPatch = null;
  let patchRaf = 0;
  let contentDrag = null;
  let panelDrag = null;
  let panelResize = null;

  // ── 状态读写 ─────────────────────────────────────────────

  function queuePatch(patch) {
    pendingPatch = Object.assign(pendingPatch || {}, patch);
    if (patchRaf) return;
    patchRaf = requestAnimationFrame(() => {
      patchRaf = 0;
      const payload = pendingPatch;
      pendingPatch = null;
      if (!payload) return;
      sd.patch(payload)
        .then(applyState)
        .catch((err) => console.error('[console] 状态更新失败', err));
    });
  }

  function applyState(next) {
    if (!next) return;
    state = next;
    viewer.apply(next).catch((err) => console.error('[console] 渲染失败', err));
    updateStatus(next);
    updateSelection(next);
  }

  // 映射窗本地缩放要持久化；beforeunload 在强制退出时不一定触发，所以改动后延迟存一次
  let prefsTimer = 0;
  function savePrefsSoon() {
    if (prefsTimer) clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => {
      prefsTimer = 0;
      sd.setPrefs({ mirrorLocalZoom: localZoom }).catch(() => {});
    }, 500);
  }

  // ── 状态栏 ───────────────────────────────────────────────

  function chapterIndexAt(scroll) {
    const chapters = viewer.getChapters();
    if (chapters.length === 0) return 0;
    const offset = (scroll || 0) * viewer.getScrollRange();
    let index = 0;
    for (let i = 0; i < chapters.length; i += 1) {
      if (chapters[i].top <= offset + 12) index = i;
      else break;
    }
    return index;
  }

  function updateStatus(snapshot) {
    const source = snapshot.source || {};
    const hasSource = Boolean(source.type && source.type !== 'none');
    const title = hasSource ? source.title || '(未命名)' : '未选择';

    dom.sourceSummary.textContent = title;
    dom.statusSource.textContent = `内容源：${title}`;
    dom.mirrorTitle.textContent = hasSource ? source.title || '映射窗' : '映射窗';
    dom.mirrorStatus.textContent = `映射 ${Math.round(localZoom * 100)}%`;

    if (source.kind === 'pdf') {
      const total = Math.max(1, viewer.getPageCount() || snapshot.pageCount || 1);
      dom.statusPage.textContent = `页 ${snapshot.page} / ${total}`;
    } else if (source.kind === 'markdown') {
      const chapters = viewer.getChapters();
      dom.statusPage.textContent = chapters.length > 0
        ? `章节 ${chapterIndexAt(snapshot.scroll) + 1} / ${chapters.length}`
        : '文档';
    } else if (source.kind === 'window') {
      dom.statusPage.textContent = '外部窗口（只读）';
    } else {
      dom.statusPage.textContent = '页 —';
    }

    dom.statusZoom.textContent = `缩放 ${Math.round((snapshot.zoom || 1) * 100)}%`;
  }

  function updateSelection(snapshot) {
    const source = (snapshot && snapshot.source) || {};
    for (const item of dom.docList.querySelectorAll('.source-item')) {
      item.classList.toggle('active', Boolean(source.id) && item.dataset.id === source.id);
    }
    for (const item of dom.windowList.querySelectorAll('.source-item')) {
      item.classList.toggle('active', Boolean(source.windowId) && item.dataset.id === source.windowId);
    }
  }

  // ── 内容源列表 ───────────────────────────────────────────

  const KIND_LABEL = { pdf: 'PDF', markdown: 'MD', image: 'IMG', window: 'WIN' };

  function emptyItem(text) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = text;
    return li;
  }

  async function refreshDocuments() {
    try {
      const docs = await sd.listDocuments();
      dom.docList.replaceChildren();
      if (docs.length === 0) {
        dom.docList.appendChild(emptyItem('还没有文档。点上面「打开文档…」添加 PDF / Markdown / 图片。'));
        return;
      }
      for (const doc of docs) {
        const li = document.createElement('li');
        li.className = 'source-item';
        li.dataset.id = doc.id;

        const kind = document.createElement('span');
        kind.className = 'kind';
        kind.textContent = KIND_LABEL[doc.kind] || 'DOC';

        const title = document.createElement('span');
        title.className = 'title';
        title.textContent = doc.title;
        title.title = doc.path;

        li.append(kind, title);
        li.addEventListener('click', () => {
          sd.selectDocument(doc.id).then(applyState).catch(showError);
        });
        dom.docList.appendChild(li);
      }
      updateSelection(state);
    } catch (err) {
      showError(err);
    }
  }

  async function refreshWindows() {
    dom.windowList.replaceChildren(emptyItem('正在枚举窗口…'));
    try {
      const windows = await sd.listWindows();
      dom.windowList.replaceChildren();
      if (windows.length === 0) {
        dom.windowList.appendChild(emptyItem('没有可投送的窗口。先打开第三方应用再刷新。'));
        return;
      }
      for (const win of windows) {
        const li = document.createElement('li');
        li.className = 'source-item';
        li.dataset.id = win.id;

        const thumb = document.createElement('img');
        thumb.className = 'thumb';
        thumb.alt = '';
        if (win.thumbnail) thumb.src = win.thumbnail;

        const title = document.createElement('span');
        title.className = 'title';
        title.textContent = win.name;

        li.append(thumb, title);
        li.addEventListener('click', () => {
          sd.selectWindow({ id: win.id, name: win.name }).then(applyState).catch(showError);
        });
        dom.windowList.appendChild(li);
      }
      updateSelection(state);
    } catch (err) {
      showError(err);
    }
  }

  function showError(err) {
    const message = err && err.message ? err.message : String(err);
    console.error('[console]', message);
    dom.statusSource.textContent = `错误：${message}`;
  }

  // ── 映射窗几何 ───────────────────────────────────────────

  function stageSize() {
    return { width: dom.stage.clientWidth, height: dom.stage.clientHeight };
  }

  function currentRect() {
    return {
      x: dom.mirror.offsetLeft,
      y: dom.mirror.offsetTop,
      width: dom.mirror.offsetWidth,
      height: dom.mirror.offsetHeight,
    };
  }

  function defaultRect() {
    const size = stageSize();
    const width = Math.round(size.width * 0.46);
    const height = Math.round(size.height * 0.68);
    return { x: size.width - width - 28, y: 24, width, height };
  }

  function clampRect(rect) {
    const size = stageSize();
    const width = clamp(rect.width, 220, size.width);
    const height = clamp(rect.height, 160, size.height);
    const x = clamp(rect.x, 0, Math.max(0, size.width - width));
    const y = clamp(rect.y, 0, Math.max(0, size.height - height));
    return { x, y, width, height };
  }

  function applyRect(rect) {
    dom.mirror.style.left = `${rect.x}px`;
    dom.mirror.style.top = `${rect.y}px`;
    dom.mirror.style.width = `${rect.width}px`;
    dom.mirror.style.height = `${rect.height}px`;
  }

  function persistMirror() {
    if (dom.mirror.classList.contains('maximized')) return;
    sd.setLayout({ mirror: currentRect(), mirrorMaximized: false }).catch(() => {});
  }

  function setMaximized(flag, persist = true) {
    if (flag) {
      dom.mirror.dataset.restore = JSON.stringify(currentRect());
      dom.mirror.classList.add('maximized');
      dom.mirror.style.left = '0px';
      dom.mirror.style.top = '0px';
      dom.mirror.style.width = '100%';
      dom.mirror.style.height = '100%';
    } else {
      dom.mirror.classList.remove('maximized');
      const saved = JSON.parse(dom.mirror.dataset.restore || 'null');
      applyRect(clampRect(saved || defaultRect()));
    }
    if (persist) {
      const restoreRect = dom.mirror.dataset.restore ? JSON.parse(dom.mirror.dataset.restore) : currentRect();
      sd.setLayout({ mirror: restoreRect, mirrorMaximized: flag }).catch(() => {});
    }
    if (state) viewer.apply(state).catch(() => {});
  }

  // ── 窗口拖动 / 缩放 ──────────────────────────────────────

  dom.mirrorHeader.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (dom.mirror.classList.contains('maximized')) return;
    dom.mirrorHeader.setPointerCapture(event.pointerId);
    panelDrag = { dx: event.clientX - dom.mirror.offsetLeft, dy: event.clientY - dom.mirror.offsetTop };
  });

  dom.mirrorHeader.addEventListener('pointermove', (event) => {
    if (!panelDrag) return;
    applyRect(clampRect({
      x: event.clientX - panelDrag.dx,
      y: event.clientY - panelDrag.dy,
      width: dom.mirror.offsetWidth,
      height: dom.mirror.offsetHeight,
    }));
  });

  dom.mirrorHeader.addEventListener('pointerup', () => {
    if (!panelDrag) return;
    panelDrag = null;
    persistMirror();
  });

  dom.mirrorHeader.addEventListener('dblclick', () => {
    setMaximized(!dom.mirror.classList.contains('maximized'));
  });

  for (const handle of document.querySelectorAll('.resize-handle')) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (dom.mirror.classList.contains('maximized')) return;
      event.stopPropagation();
      handle.setPointerCapture(event.pointerId);
      panelResize = { dir: handle.dataset.dir, startX: event.clientX, startY: event.clientY, rect: currentRect() };
    });

    handle.addEventListener('pointermove', (event) => {
      if (!panelResize) return;
      const dx = event.clientX - panelResize.startX;
      const dy = event.clientY - panelResize.startY;
      const rect = { ...panelResize.rect };
      const dir = panelResize.dir;
      if (dir.includes('e')) rect.width = panelResize.rect.width + dx;
      if (dir.includes('s')) rect.height = panelResize.rect.height + dy;
      if (dir.includes('w')) {
        rect.width = panelResize.rect.width - dx;
        rect.x = panelResize.rect.x + dx;
      }
      if (dir.includes('n')) {
        rect.height = panelResize.rect.height - dy;
        rect.y = panelResize.rect.y + dy;
      }
      applyRect(clampRect(rect));
    });

    handle.addEventListener('pointerup', () => {
      if (!panelResize) return;
      panelResize = null;
      persistMirror();
    });
  }

  window.addEventListener('resize', () => {
    if (dom.mirror.classList.contains('maximized')) return;
    applyRect(clampRect(currentRect()));
  });

  // ── 映射窗内容手势 ───────────────────────────────────────

  function stepContent(delta) {
    if (!state || delta === 0) return;
    const source = state.source || {};

    if (source.kind === 'pdf') {
      const total = Math.max(1, viewer.getPageCount() || state.pageCount || 1);
      const next = clamp((state.page || 1) + delta, 1, total);
      if (next !== state.page) queuePatch({ page: next, scroll: 0 });
      return;
    }

    if (source.kind === 'markdown') {
      const chapters = viewer.getChapters();
      const range = viewer.getScrollRange();
      if (chapters.length === 0 || range <= 0) {
        queuePatch({ scroll: clamp((state.scroll || 0) + delta * 0.2, 0, 1) });
        return;
      }
      const next = clamp(chapterIndexAt(state.scroll) + delta, 0, chapters.length - 1);
      queuePatch({ scroll: clamp(chapters[next].top / range, 0, 1) });
    }
  }

  dom.mirrorBody.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dom.mirrorBody.setPointerCapture(event.pointerId);
    contentDrag = {
      startX: event.clientX,
      startY: event.clientY,
      startScroll: state ? state.scroll : 0,
      axis: null,
      moved: 0,
      step: 0,
    };
  });

  dom.mirrorBody.addEventListener('pointermove', (event) => {
    if (!contentDrag) return;
    const dx = event.clientX - contentDrag.startX;
    const dy = event.clientY - contentDrag.startY;
    contentDrag.moved = Math.max(contentDrag.moved, Math.hypot(dx, dy));

    if (!contentDrag.axis && contentDrag.moved > 6) {
      contentDrag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }

    if (contentDrag.axis === 'y') {
      const range = viewer.getScrollRange();
      if (range <= 0) return;
      queuePatch({ scroll: clamp(contentDrag.startScroll - dy / range, 0, 1) });
      return;
    }

    if (contentDrag.axis === 'x') {
      const step = Math.trunc(dx / 80);
      if (step !== contentDrag.step) {
        const delta = step - contentDrag.step;
        contentDrag.step = step;
        stepContent(delta);
      }
    }
  });

  dom.mirrorBody.addEventListener('pointerup', (event) => {
    if (!contentDrag) return;
    const wasClick = contentDrag.moved < 6;
    contentDrag = null;
    if (!wasClick) return;

    const rect = dom.mirrorBody.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    queuePatch({
      laser: {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
        visible: true,
      },
    });
  });

  dom.mirrorBody.addEventListener('wheel', (event) => {
    event.preventDefault();

    if (event.ctrlKey) {
      localZoom = clamp(localZoom * (1 - event.deltaY * 0.0015), 0.2, 6);
      viewer.setLocalZoom(localZoom);
      if (state) {
        viewer.apply(state).catch(() => {});
        updateStatus(state);
      }
      savePrefsSoon();
      return;
    }

    const base = state ? state.scroll : 0;
    queuePatch({ scroll: clamp(base + event.deltaY / 900, 0, 1) });
  }, { passive: false });

  // ── 快捷键 ───────────────────────────────────────────────

  window.addEventListener('keydown', (event) => {
    if (event.target && /^(input|textarea|select)$/i.test(event.target.tagName)) return;

    switch (event.key) {
      case 'ArrowRight':
      case 'PageDown':
        event.preventDefault();
        stepContent(1);
        break;
      case 'ArrowLeft':
      case 'PageUp':
        event.preventDefault();
        stepContent(-1);
        break;
      case '=':
      case '+':
        event.preventDefault();
        queuePatch({ zoom: clamp((state ? state.zoom : 1) + 0.1, 0.2, 6) });
        break;
      case '-':
        event.preventDefault();
        queuePatch({ zoom: clamp((state ? state.zoom : 1) - 0.1, 0.2, 6) });
        break;
      case '0':
        queuePatch({ zoom: 1 });
        break;
      case 'Escape':
        queuePatch({ laser: { visible: false } });
        break;
      default:
        break;
    }
  });

  // ── 侧栏 Tab / 按钮 ─────────────────────────────────────

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) {
        other.classList.toggle('active', other === tab);
      }
      document.getElementById('panel-docs').classList.toggle('hidden', tab.dataset.tab !== 'docs');
      document.getElementById('panel-windows').classList.toggle('hidden', tab.dataset.tab !== 'windows');
    });
  }

  dom.btnOpenDocs.addEventListener('click', async () => {
    try {
      const result = await sd.openDocuments();
      if (result && result.errors && result.errors.length > 0) {
        showError(new Error(result.errors.map((e) => e.message).join('；')));
      }
      await refreshDocuments();
    } catch (err) {
      showError(err);
    }
  });

  dom.btnRefreshWindows.addEventListener('click', () => {
    refreshWindows();
  });

  dom.btnToggleOutput.addEventListener('click', async () => {
    try {
      const result = await sd.toggleOutput();
      dom.btnToggleOutput.textContent = result && result.visible ? '隐藏大屏' : '显示大屏';
    } catch (err) {
      showError(err);
    }
  });

  // ── 显示器信息 ───────────────────────────────────────────

  async function refreshDisplays() {
    try {
      const info = await sd.listDisplays();
      dom.displays.replaceChildren();
      for (const display of info.displays) {
        const chip = document.createElement('span');
        const isOutput = !display.primary && display.id === info.secondaryId;
        chip.className = `display-chip${display.primary ? ' primary' : ''}${isOutput ? ' output' : ''}`;
        const tag = display.primary ? '主屏' : isOutput ? '输出' : '副屏';
        chip.textContent = `${tag} ${display.bounds.width}×${display.bounds.height}`;
        dom.displays.appendChild(chip);
      }
      if (!info.secondaryId) {
        const warn = document.createElement('span');
        warn.className = 'display-chip';
        warn.textContent = '未检测到第二块屏幕，大屏以窗口模式运行';
        dom.displays.appendChild(warn);
      }
    } catch (err) {
      showError(err);
    }
  }

  // ── 启动 ─────────────────────────────────────────────────

  async function init() {
    try {
      // 脚本成功执行就移除静态兜底提示（见 console.html 里的 #boot-fallback）
      const fallback = document.getElementById('boot-fallback');
      if (fallback) fallback.remove();

      await refreshDisplays();

      const savedLayout = await sd.getLayout();
      layout = savedLayout || layout;

      if (layout && layout.mirrorMaximized) {
        setMaximized(true, false);
      } else {
        applyRect(clampRect((layout && layout.mirror) || defaultRect()));
      }

      const prefs = await sd.getPrefs();
      if (prefs && typeof prefs.mirrorLocalZoom === 'number') {
        localZoom = clamp(prefs.mirrorLocalZoom, 0.2, 6);
        viewer.setLocalZoom(localZoom);
      }

      const initial = await sd.getState();
      applyState(initial);
      sd.onState(applyState);

      await refreshDocuments();
    } catch (err) {
      showError(err);
    }
  }

  window.addEventListener('beforeunload', () => {
    sd.setPrefs({ mirrorLocalZoom: localZoom }).catch(() => {});
  });

  init();
})();

'use strict';

/**
 * IPC 注册。
 *
 * 约定：渲染进程只通过 preload 暴露的白名单方法调用；主进程对所有入参重新校验，
 * 不信任渲染层传来的任何路径或数值。
 */

const { ipcMain, session, desktopCapturer, BrowserWindow, app, screen } = require('electron');
const { Injector } = require('./injector');

function registerIpc({ wm, docState, sources, store, injector }) {
  let laserTimer = null;

  const scheduleLaserHide = () => {
    if (laserTimer) clearTimeout(laserTimer);
    const duration = Math.max(300, Number(store.data.prefs.laserDurationMs) || 2200);
    laserTimer = setTimeout(() => {
      laserTimer = null;
      if (docState.snapshot().laser.visible) {
        docState.patch({ laser: { visible: false } });
      }
    }, duration);
  };

  // ── 共享状态 ─────────────────────────────────────────────
  ipcMain.handle('state:get', () => docState.snapshot());

  ipcMain.handle('state:patch', (_event, patch) => {
    const snapshot = docState.patch(patch);
    store.setDocState(docState.persistable());
    if (patch && patch.laser && patch.laser.visible) scheduleLaserHide();
    return snapshot;
  });

  // ── 内部内容源 ────────────────────────────────────────────
  ipcMain.handle('doc:load', (_event, id) => sources.load(id));
  ipcMain.handle('docs:list', () => sources.list());

  ipcMain.handle('docs:open', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return sources.openDialog(win);
  });

  ipcMain.handle('docs:select', (_event, id) => {
    const snapshot = sources.selectDocument(id);
    store.setDocState(docState.persistable());
    return snapshot;
  });

  ipcMain.handle('docs:remove', (_event, id) => sources.removeDocument(id));

  // ── 外部窗口源（只读镜像）────────────────────────────────
  ipcMain.handle('windows:list', () => sources.listWindows());

  ipcMain.handle('windows:select', (_event, payload) => {
    // 切换目标时清掉旧的捕获方案，避免沿用上一次的裁剪参数
    wm.capturePlan = null;
    const snapshot = sources.selectWindow(payload || {});
    store.setDocState(docState.persistable());
    return snapshot;
  });

  // ── 显示器 / 布局 / 偏好 ──────────────────────────────────
  ipcMain.handle('display:list', () => wm.displayInfo());
  ipcMain.handle('layout:get', () => store.data.layout);
  ipcMain.handle('layout:set', (_event, partial) => {
    store.setLayout(partial || {});
    return store.data.layout;
  });
  ipcMain.handle('prefs:get', () => store.data.prefs);
  ipcMain.handle('prefs:set', (_event, partial) => {
    store.setPrefs(partial || {});
    return store.data.prefs;
  });

  ipcMain.handle('output:toggle', () => wm.toggleOutput());
  ipcMain.handle('output:size', () => wm.outputSize());
  ipcMain.handle('output:viewport', (_event, size) => {
    wm.setOutputViewport(size);
    return true;
  });

  /**
   * 外部窗口的捕获方案。
   *
   * Windows 的窗口捕获（WGC）在部分机器上会出现绿色伪影/色度错位，
   * 而屏幕捕获走另一条管线，通常正常。所以这里计算「窗口在屏幕上的位置」，
   * 让捕获整屏、渲染层再裁剪到窗口区域。
   *
   * 返回：{ mode: 'screen', displayId, crop:{x,y,w,h} } 或 { mode: 'window' }
   */
  ipcMain.handle('capture:info', async () => {
    const source = docState.snapshot().source;
    if (source.type !== 'external') return { mode: 'window' };

    const hwnd = Injector.hwndFromSourceId(source.windowId);
    if (!hwnd) {
      wm.log('[capture] 无法从 source id 解析窗口句柄：', source.windowId);
      return { mode: 'window' };
    }
    if (!injector) return { mode: 'window' };

    const ready = await injector.ensure();
    if (!ready) {
      wm.log('[capture] 注入器不可用，无法获取窗口矩形，退回窗口捕获');
      return { mode: 'window' };
    }

    const rect = await injector.clientRect(hwnd); // 物理像素、屏幕坐标
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      wm.log('[capture] 获取窗口矩形失败（hwnd =', hwnd, '），退回窗口捕获');
      return { mode: 'window' };
    }

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const displays = screen.getAllDisplays();
    const display =
      displays.find((d) => {
        const b = d.bounds;
        const sf = d.scaleFactor || 1;
        return (
          centerX >= b.x * sf && centerX < (b.x + b.width) * sf && centerY >= b.y * sf && centerY < (b.y + b.height) * sf
        );
      }) || screen.getPrimaryDisplay();

    // 目标窗口在副屏（也就是我们自己的大屏）上时，屏幕捕获会把我们自己也拍进去，
    // 造成递归画面，这里退回窗口捕获。
    const plan = wm.plan();
    if (plan.secondary && display.id === plan.secondary.id) {
      wm.log('[capture] 目标窗口位于副屏，退回窗口捕获以避免自捕获');
      wm.capturePlan = { mode: 'window' };
      return { mode: 'window' };
    }

    const sf = display.scaleFactor || 1;
    const displayWidth = display.bounds.width * sf;
    const displayHeight = display.bounds.height * sf;

    const crop = {
      x: (rect.left - display.bounds.x * sf) / displayWidth,
      y: (rect.top - display.bounds.y * sf) / displayHeight,
      w: rect.width / displayWidth,
      h: rect.height / displayHeight,
    };

    wm.capturePlan = { mode: 'screen', displayId: display.id };
    wm.log('[capture] 使用屏幕捕获 + 裁剪', JSON.stringify(crop), 'displayId =', display.id);
    return { mode: 'screen', displayId: display.id, crop };
  });
  // 不写入配置：每次启动都必须是关闭状态，必须由用户当次手动开启。
  let injectionArmed = false;

  const injectionEnabled = () => injectionArmed === true;

  const clamp01 = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
  };

  const currentTarget = () => {
    const source = docState.snapshot().source;
    if (source.type !== 'external' || !source.windowId) return null;
    const hwnd = Injector.hwndFromSourceId(source.windowId);
    return hwnd ? { hwnd, source } : null;
  };

  ipcMain.handle('inject:status', () => ({
    enabled: injectionEnabled(),
    available: Boolean(injector && injector.child && !injector.dead),
  }));

  /** 显式开启：只对本次会话有效，不落盘。 */
  ipcMain.handle('inject:enable', () => {
    injectionArmed = true;
    wm.log('[inject] 已被用户开启（仅本次会话）');
    return { ok: true, enabled: true };
  });

  /** 紧急关闭：解绑注入并停掉注入器进程。Esc 快捷键会调用这里。 */
  ipcMain.handle('inject:disable', () => {
    injectionArmed = false;
    try {
      if (injector) injector.stop();
    } catch {
      // 忽略
    }
    wm.log('[inject] 已被用户关闭（紧急停止）');
    return { ok: true, enabled: false };
  });

  ipcMain.handle('inject:click', async (_event, payload) => {
    if (!injectionEnabled()) return { ok: false, reason: 'disabled' };
    const target = currentTarget();
    if (!target) return { ok: false, reason: 'not-external' };
    if (!injector) return { ok: false, reason: 'no-injector' };

    const ready = await injector.ensure();
    if (!ready) return { ok: false, reason: 'injector-unavailable' };

    const result = await injector.click(target.hwnd, clamp01(payload && payload.nx), clamp01(payload && payload.ny));
    // 留痕：出问题时能查到到底点到了哪个窗口、什么位置
    wm.log(
      '[inject] click hwnd =',
      target.hwnd,
      'target =',
      target.source.title,
      'nx =',
      clamp01(payload && payload.nx).toFixed(3),
      'ny =',
      clamp01(payload && payload.ny).toFixed(3),
      '=>',
      result.ok ? 'ok' : result.reason
    );
    return result;
  });

  ipcMain.handle('inject:wheel', async (_event, payload) => {
    if (!injectionEnabled()) return { ok: false, reason: 'disabled' };
    const target = currentTarget();
    if (!target) return { ok: false, reason: 'not-external' };
    if (!injector) return { ok: false, reason: 'no-injector' };

    const ready = await injector.ensure();
    if (!ready) return { ok: false, reason: 'injector-unavailable' };

    const result = await injector.wheel(
      target.hwnd,
      clamp01(payload && payload.nx),
      clamp01(payload && payload.ny),
      Number(payload && payload.delta) || 0
    );
    wm.log(
      '[inject] wheel hwnd =',
      target.hwnd,
      'target =',
      target.source.title,
      '=>',
      result.ok ? 'ok' : result.reason
    );
    return result;
  });
  ipcMain.handle('app:quit', () => {
    app.quit();
    return true;
  });

  /**
   * 外部窗口捕获：渲染进程调用 navigator.mediaDevices.getDisplayMedia() 时，
   * 由主进程决定给哪一路 source —— 这样既能复用同一路流给大屏和映射窗，
   * 也能保证永远不会把 ScreenDeck 自己的窗口交出去。
   */
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const plan = wm.capturePlan;

      // 方案 A：屏幕捕获 + 渲染层裁剪（规避窗口捕获的绿色伪影）
      if (plan && plan.mode === 'screen') {
        const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
        const match = screens.find((s) => String(s.display_id) === String(plan.displayId)) || screens[0];
        wm.log('[capture] 屏幕捕获命中 =', match ? `${match.id} (${match.name})` : '(无)');
        if (match) {
          callback({ video: match });
          return;
        }
      }

      const wanted = wm.captureWindowId || docState.snapshot().source.windowId;
      wm.log('[capture] 收到 getDisplayMedia 请求，目标 =', wanted || '(空)');
      if (wanted) {
        const source = await sources.resolveCaptureSource(wanted);
        if (source) {
          wm.log('[capture] 命中窗口源：', source.id, source.name);
          callback({ video: source });
          return;
        }
        wm.log('[capture] 目标窗口已不存在，回退到整屏');
      }
      const fallback = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
      });
      wm.log('[capture] 回退整屏源数量 =', fallback.length);
      callback(fallback[0] ? { video: fallback[0] } : {});
    } catch (err) {
      console.error('[ipc] 解析捕获源失败：', err);
      callback({});
    }
  });

  // getDisplayMedia 在某些版本里会走权限检查，显式放行屏幕/窗口捕获，其余保持默认
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'display-capture' || permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'display-capture' || permission === 'media');
}

module.exports = registerIpc;

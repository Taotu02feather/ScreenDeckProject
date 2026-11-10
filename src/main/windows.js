'use strict';

/**
 * 窗口管理：主屏控制台窗口 + 扩展屏无边框全屏输出窗口。
 * 两个窗口共享同一份主进程状态，任何一方都不需要截屏。
 */

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

const { ORIGIN } = require('./app-protocol');

const ROOT = path.join(__dirname, '..', '..');
const PRELOAD_DIR = path.join(ROOT, 'src', 'preload');

function debounce(fn, wait) {
  let timer = null;
  return function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

function intersectsAnyDisplay(bounds) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;
  return screen.getAllDisplays().some((display) => {
    const b = display.bounds;
    return (
      bounds.x < b.x + b.width &&
      bounds.x + bounds.width > b.x &&
      bounds.y < b.y + b.height &&
      bounds.y + bounds.height > b.y
    );
  });
}

class WindowManager {
  constructor({ docState, store, isDev, log }) {
    this.docState = docState;
    this.store = store;
    this.isDev = isDev;
    this.log = typeof log === 'function' ? log : () => {};
    this.console = null;
    this.output = null;
    /** 当前选中的外部窗口捕获源 id（desktopCapturer source id） */
    this.captureWindowId = null;
    this.outputViewport = null;
    /** 外部窗口的捕获方案：{ mode: 'window' } 或 { mode: 'screen', displayId } */
    this.capturePlan = null;
    this._onStateChanged = (snapshot) => this.broadcast('state:event', snapshot);
  }

  /**
   * 窗口级诊断：加载失败、preload 报错、渲染进程崩溃、渲染层 console 报错，
   * 全部写进启动日志。没有这些，"窗口没出来"就完全没有线索。
   */
  wireDiagnostics(win, tag) {
    const log = this.log;
    win.webContents.on('preload-error', (_event, preloadPath, error) => {
      log(`[${tag}] preload-error ${preloadPath} :: ${error.message}`);
    });
    win.webContents.on('console-message', (_event, level, message, line, source) => {
      // 开发模式下全部记录，方便看清脚本是否加载、CSP 是否拦了什么
      const threshold = this.isDev ? 0 : 2;
      if (level >= threshold) log(`[${tag}:renderer] ${message} (${source}:${line})`);
    });
    win.webContents.on('dom-ready', () => log(`[${tag}] dom-ready url=${win.webContents.getURL()}`));
    win.webContents.on('did-finish-load', async () => {
      log(`[${tag}] did-finish-load url=${win.webContents.getURL()}`);
      try {
        // 页面到底加载成了什么？这条诊断能把"空白页"变成可读的事实
        const probe = await win.webContents.executeJavaScript(
          `JSON.stringify({
             title: document.title,
             bodyLen: document.body ? document.body.innerHTML.length : -1,
             headLen: document.head ? document.head.innerHTML.length : -1,
             scripts: Array.from(document.scripts).map((s) => s.src),
             styles: Array.from(document.querySelectorAll('link[rel=stylesheet]')).map((l) => l.href),
             firstText: document.body ? (document.body.innerText || '').slice(0, 80) : ''
           })`,
          true
        );
        log(`[${tag}] 页面快照 ${probe}`);
      } catch (err) {
        log(`[${tag}] 读取页面内容失败：${err.message}`);
      }
    });
    win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      log(`[${tag}] did-fail-load code=${code} ${description} url=${url} mainFrame=${isMainFrame}`);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      log(`[${tag}] render-process-gone ${JSON.stringify(details)}`);
    });
    win.webContents.on('unresponsive', () => log(`[${tag}] unresponsive`));
    win.on('closed', () => log(`[${tag}] closed`));
  }

  get layout() {
    return this.store.data.layout;
  }

  /** 枚举显示器：主屏给控制台，副屏给输出。 */
  plan() {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const others = displays.filter((d) => d.id !== primary.id);

    // TODO: 明天重点排查 —— 副屏判定是否符合实际接线（右侧 > 左侧 > 横屏 > 面积大）
    // 镜像模式（两块屏同坐标）下无法真正区分，只能退回窗口模式。
    const score = (display) => {
      let value = 0;
      const b = display.bounds;
      const p = primary.bounds;
      if (b.x >= p.x + p.width - 8) value += 1000; // 主屏右侧
      else if (b.x + b.width <= p.x + 8) value += 500; // 主屏左侧
      if (b.width >= b.height) value += 100;
      value += (b.width * b.height) / 1_000_000;
      return value;
    };

    const secondary = others.length > 0 ? others.slice().sort((a, b) => score(b) - score(a))[0] : null;
    return { displays, primary, secondary };
  }

  webPrefs(preloadFile) {
    return {
      preload: path.join(PRELOAD_DIR, preloadFile),
      nodeIntegration: false, // 硬约束
      contextIsolation: true, // 硬约束
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: this.isDev,
    };
  }

  consoleBounds() {
    const saved = this.layout.console;
    if (saved && intersectsAnyDisplay(saved)) return saved;
    const workArea = screen.getPrimaryDisplay().workArea;
    const width = Math.min(1360, Math.round(workArea.width * 0.82));
    const height = Math.min(880, Math.round(workArea.height * 0.86));
    return {
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + Math.round((workArea.height - height) / 2),
      width,
      height,
    };
  }

  createAll() {
    this.createConsole();
    this.createOutput();
    this.docState.on('changed', this._onStateChanged);
    screen.on('display-added', () => this.repositionOutput());
    screen.on('display-removed', () => this.repositionOutput());
    screen.on('display-metrics-changed', () => this.repositionOutput());
  }

  createConsole() {
    const bounds = this.consoleBounds();
    this.log('[console] 创建窗口 bounds =', JSON.stringify(bounds));
    this.console = new BrowserWindow({
      ...bounds,
      minWidth: 940,
      minHeight: 620,
      title: 'ScreenDeck 控制台',
      backgroundColor: '#0e1014',
      show: false,
      webPreferences: this.webPrefs('console-preload.js'),
    });
    this.wireDiagnostics(this.console, 'console');

    const persistBounds = debounce(() => {
      if (!this.console || this.console.isDestroyed()) return;
      if (this.console.isMaximized() || this.console.isMinimized() || this.console.isFullScreen()) return;
      this.store.setLayout({ console: this.console.getBounds() });
    }, 400);

    this.console.on('resize', persistBounds);
    this.console.on('move', persistBounds);
    this.console.on('closed', () => {
      this.console = null;
    });

    this.console.once('ready-to-show', () => {
      this.log('[console] ready-to-show → show()');
      if (this.console && !this.console.isDestroyed()) this.console.show();
    });

    // 兜底：ready-to-show 在极少数环境（GPU 初始化失败等）不会触发，
    // 窗口就永远不会显示，但进程还活着 —— 用户看到的就是"没窗口"。
    setTimeout(() => {
      if (this.console && !this.console.isDestroyed() && !this.console.isVisible()) {
        this.log('[console] ready-to-show 未触发，强制 show()');
        this.console.show();
      }
    }, 2500);

    this.console.loadURL(`${ORIGIN}/src/renderer/console/console.html`).catch((err) => {
      this.log('[console] loadURL 失败：', err.message);
    });

    if (this.isDev) this.console.webContents.openDevTools({ mode: 'detach' });
  }

  createOutput() {
    const { primary, secondary } = this.plan();
    const workArea = primary.workArea;
    const singleScreen = !secondary;

    // 没有扩展屏时退化为「可交互窗口」：带边框、可拖动缩放，
    // 否则无边框 + 不可缩放会让单屏开发和录屏时完全没法摆弄它。
    const target = secondary
      ? secondary.bounds
      : {
          x: workArea.x + Math.round(workArea.width * 0.1),
          y: workArea.y + Math.round(workArea.height * 0.1),
          width: Math.min(1024, Math.round(workArea.width * 0.7)),
          height: Math.min(576, Math.round(workArea.height * 0.55)),
        };

    this.output = new BrowserWindow({
      x: target.x,
      y: target.y,
      width: target.width,
      height: target.height,
      frame: singleScreen ? true : false,
      resizable: singleScreen,
      show: false,
      skipTaskbar: singleScreen ? false : true,
      backgroundColor: '#000000',
      title: singleScreen ? 'ScreenDeck 输出（单屏测试模式）' : 'ScreenDeck 输出',
      webPreferences: this.webPrefs('output-preload.js'),
    });

    this.output.setMenuBarVisibility(false);
    this.wireDiagnostics(this.output, 'output');
    this.output.on('closed', () => {
      this.output = null;
    });

    this.log('[output] 创建窗口 target =', JSON.stringify(target), 'fullscreen =', Boolean(secondary));

    this.output.once('ready-to-show', () => {
      if (!this.output || this.output.isDestroyed()) return;
      this.log('[output] ready-to-show → showInactive()');
      this.output.showInactive();
      if (secondary) this.output.setFullScreen(true);
    });

    setTimeout(() => {
      if (this.output && !this.output.isDestroyed() && !this.output.isVisible()) {
        this.log('[output] ready-to-show 未触发，强制 showInactive()');
        this.output.showInactive();
      }
    }, 3000);

    this.output.loadURL(`${ORIGIN}/src/renderer/output/output.html`).catch((err) => {
      this.log('[output] loadURL 失败：', err.message);
    });
  }

  /** 显示器插拔/分辨率变化时，把输出窗口挪到新的副屏（或退回窗口模式）。 */
  repositionOutput() {
    if (!this.output || this.output.isDestroyed()) return;
    const { primary, secondary } = this.plan();
    if (secondary) {
      this.output.setFullScreen(false);
      this.output.setBounds(secondary.bounds);
      this.output.setFullScreen(true);
      this.log('[output] 已移动到副屏', JSON.stringify(secondary.bounds));
      return;
    }
    this.output.setFullScreen(false);
    const workArea = primary.workArea;
    this.output.setBounds({
      x: workArea.x + Math.round(workArea.width * 0.1),
      y: workArea.y + Math.round(workArea.height * 0.1),
      width: Math.min(1024, Math.round(workArea.width * 0.7)),
      height: Math.min(576, Math.round(workArea.height * 0.55)),
    });
    this.output.showInactive();
    // 窗口边框在创建时决定，运行时无法切换；拔掉副屏后需要重启才能拿到带边框的测试窗口
    this.log('[output] 副屏已移除：窗口退化为窗口模式（边框状态需重启应用才更新）');
  }

  broadcast(channel, payload) {
    for (const win of [this.console, this.output]) {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  sendToConsole(channel, payload) {
    if (this.console && !this.console.isDestroyed()) this.console.webContents.send(channel, payload);
  }

  /**
   * 显隐大屏窗口。
   * 如果输出窗口已被用户关掉（单屏测试模式下它有标题栏和关闭按钮），
   * 这里负责重建，而不是让「显示大屏」变成一个永远无效的按钮。
   */
  toggleOutput() {
    if (!this.output || this.output.isDestroyed()) {
      this.log('[output] 窗口已被关闭，重新创建');
      this.createOutput();
      return { visible: true, recreated: true };
    }
    if (this.output.isVisible()) {
      this.output.hide();
      return { visible: false };
    }
    this.output.showInactive();
    return { visible: true };
  }

  /** 大屏内容区尺寸，映射窗按这个宽高比布局，保证两边取景一致。 */
  outputSize() {
    // 优先用输出窗口自己上报的视口尺寸（CSS 像素，最准确）
    if (this.outputViewport && this.outputViewport.width > 0 && this.outputViewport.height > 0) {
      return { ...this.outputViewport };
    }
    if (this.output && !this.output.isDestroyed()) {
      const bounds =
        typeof this.output.getContentBounds === 'function' ? this.output.getContentBounds() : this.output.getBounds();
      return { width: Math.round(bounds.width), height: Math.round(bounds.height) };
    }
    return { width: 1280, height: 720 };
  }

  /** 输出窗口渲染完成后上报的真实视口尺寸。 */
  setOutputViewport(size) {
    if (!size || !(size.width > 0) || !(size.height > 0)) return;
    const next = { width: Math.round(size.width), height: Math.round(size.height) };
    this.outputViewport = next;
    this.broadcast('viewport:changed', next);
  }

  /** 退出前主动销毁窗口，让捕获流和 GPU 资源尽早释放。 */
  shutdown() {
    for (const win of [this.output, this.console]) {
      try {
        if (win && !win.isDestroyed()) win.destroy();
      } catch {
        // 忽略
      }
    }
    this.output = null;
    this.console = null;
  }

  displayInfo() {    const { displays, primary, secondary } = this.plan();
    return {
      primaryId: primary.id,
      secondaryId: secondary ? secondary.id : null,
      displays: displays.map((d) => ({
        id: d.id,
        label: d.label || `显示器 ${d.id}`,
        primary: d.id === primary.id,
        bounds: d.bounds,
        scaleFactor: d.scaleFactor,
      })),
    };
  }
}

module.exports = { WindowManager, ROOT };

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');

const { WindowManager } = require('./windows');
const { DocState } = require('./state');
const { Store } = require('./store');
const { SourceRegistry } = require('./sources');
const { Injector } = require('./injector');
const { registerScheme, registerHandler } = require('./app-protocol');
const registerIpc = require('./ipc');

// 必须在 app ready 之前注册协议方案，否则 registerSchemesAsPrivileged 不生效
registerScheme();

const isDev = process.argv.includes('--dev');

// 默认保留硬件加速：视频（窗口捕获流）在软件路径下会渲染成整块绿色。
// 只有在排查 GPU 相关问题时才用 SCREENDECK_NO_GPU=1 关闭。
if (process.env.SCREENDECK_NO_GPU === '1') {
  app.disableHardwareAcceleration();
}

// 启动日志：静默崩溃是排查黑洞，所以每一步都落盘 + 打到 stdout。
// 位置：%TEMP%\screendeck-boot.log（用户终端里 echo $env:TEMP 可见）
const LOG_FILE = path.join(os.tmpdir(), 'screendeck-boot.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((item) => (typeof item === 'string' ? item : String(item)))
    .join(' ')}`;
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch {
    // 写日志失败不能影响主流程
  }
  process.stdout.write(`${line}\n`);
}

function fatal(title, err) {
  const text = err && err.stack ? err.stack : String(err);
  log(`[FATAL] ${title}: ${text}`);
  try {
    dialog.showErrorBox(title, text);
  } catch {
    // 无桌面会话时忽略
  }
}

log('=== ScreenDeck 启动 ===');
log('argv =', JSON.stringify(process.argv));
log('electron =', process.versions.electron, 'node =', process.versions.node, 'chrome =', process.versions.chrome);
log('isDev =', isDev, 'logFile =', LOG_FILE);

let lockAcquired = true;
try {
  lockAcquired = app.requestSingleInstanceLock();
} catch (err) {
  log('[warn] requestSingleInstanceLock 抛错，按已获得处理：', err.message);
  lockAcquired = true;
}
log('单实例锁 =', lockAcquired);

if (!lockAcquired) {
  // 这条分支以前是静默 app.quit()，用户看到的就是"秒退无输出"
  log('[quit] 另一个实例持有锁，本进程退出');
  try {
    dialog.showErrorBox(
      'ScreenDeck 已在运行',
      '检测到另一个 ScreenDeck 实例，本次启动已退出。\n' +
        '如果桌面上看不到它，请在任务管理器结束残留的 electron.exe 后重试。'
    );
  } catch {
    // 忽略
  }
  app.quit();
} else {
  try {
    boot();
  } catch (err) {
    fatal('ScreenDeck 启动失败', err);
    app.exit(1);
  }
}

function boot() {
  log('进入 boot()');
  const store = new Store();
  const docState = new DocState();
  let wm = null;
  let injectorRef = null;

  app.on('second-instance', () => {
    log('[event] second-instance');
    if (wm && wm.console && !wm.console.isDestroyed()) {
      if (wm.console.isMinimized()) wm.console.restore();
      wm.console.show();
      wm.console.focus();
    }
  });

  app.on('window-all-closed', () => {
    log('[event] window-all-closed → app.quit()');
    app.quit();
  });

  app.on('before-quit', () => {
    log('[event] before-quit');
    try {
      store.setDocState(docState.persistable());
      store.flushSync();
    } catch (err) {
      log('[warn] 退出前落盘失败：', err.message);
    }
    try {
      if (injectorRef) injectorRef.stop();
    } catch {
      // 忽略
    }
    try {
      // 主动销毁窗口：让捕获流与 GPU 资源尽早释放，避免强退后桌面残留痕迹
      if (wm) wm.shutdown();
    } catch {
      // 忽略
    }
  });
  app.on('will-quit', () => log('[event] will-quit'));

  app.on('render-process-gone', (_event, _webContents, details) => {
    log('[event] render-process-gone', JSON.stringify(details));
  });

  process.on('uncaughtException', (err) => fatal('未捕获异常', err));
  process.on('unhandledRejection', (reason) => {
    log('[unhandledRejection]', reason && reason.stack ? reason.stack : String(reason));
  });
  process.on('exit', (code) => log('[exit] code =', code));

  app
    .whenReady()
    .then(async () => {
      try {
        log('[ready] app.whenReady 完成');

        // 页面之后都通过 screendeck:// 加载（真实 origin，Worker/CSP 才能正常工作）
        await registerHandler(path.join(__dirname, '..', '..'), log);
        log('[ready] screendeck:// 协议已注册');

        store.init(app.getPath('userData'));
        log('[ready] userData =', app.getPath('userData'));

        const saved = await store.load();
        log('[ready] 配置已读取，documents =', (saved.documents || []).length);

        docState.restore(saved.docState);

        wm = new WindowManager({ docState, store, isDev, log });
        const sources = new SourceRegistry({ docState, wm, store });
        sources.hydrate(saved.documents);

        const injector = new Injector({ log, projectRoot: path.join(__dirname, '..', '..') });
        injectorRef = injector;

        registerIpc({ wm, docState, sources, store, injector });
        log('[ready] IPC 已注册');

        app.on('browser-window-created', (_event, win) => {
          win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
          win.webContents.on('will-navigate', (event) => event.preventDefault());
        });

        wm.createAll();
        log('[ready] 窗口创建完成 console =', Boolean(wm.console), 'output =', Boolean(wm.output));

        // 控制台是本应用的主窗口：它关掉就该整体退出，
        // 否则大屏窗口会独自留在副屏上，用户无法再从界面上关掉它。
        if (wm.console) {
          wm.console.on('closed', () => {
            log('[event] console closed → app.quit()');
            app.quit();
          });
        }

        if (!saved.prefs || saved.prefs.openOnStart !== false) {
          await sources.restoreLast(docState.snapshot().source);
        }

        log('[ready] 启动流程结束');

        app.on('activate', () => {
          if (BrowserWindow.getAllWindows().length === 0 && wm) {
            log('[event] activate → 重新创建窗口');
            wm.createAll();
          }
        });
      } catch (err) {
        fatal('初始化失败', err);
        app.quit();
      }
    })
    .catch((err) => {
      fatal('app.whenReady 失败', err);
      app.quit();
    });
}

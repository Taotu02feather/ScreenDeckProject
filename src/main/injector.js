'use strict';

/**
 * 事件注入器（主进程侧）。
 *
 * 通过一个常驻 PowerShell 子进程调用 user32.dll 的 PostMessage，
 * 把「点击 / 滚轮」投递到当前投送的第三方窗口。
 *
 * 设计约束：
 *  - 不引入任何 npm 原生模块（koffi 这类装不上就整条链路崩）
 *  - 默认关闭，只有用户在界面上打开「事件注入（实验）」才启动子进程
 *  - PostMessage 不移动真实光标、不抢焦点；对拒绝合成消息的程序会无效（见 NOTES）
 *  - 任何失败都只记录日志，不抛到上层，避免影响放映
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const REQUEST_TIMEOUT = 2000;

class Injector {
  constructor({ log, projectRoot }) {
    this.log = typeof log === 'function' ? log : () => {};
    this.scriptPath = path.join(projectRoot, 'scripts', 'injector.ps1');
    this.projectRoot = projectRoot;
    this.child = null;
    this.pending = [];
    this.dead = false;
    this.starting = null;
  }

  /** 从 desktopCapturer 的 source id（window:134754:0）里取出窗口句柄。 */
  static hwndFromSourceId(sourceId) {
    if (typeof sourceId !== 'string') return null;
    const match = /^window:(\d+):\d+$/.exec(sourceId);
    if (!match) return null;
    const hwnd = Number(match[1]);
    return Number.isFinite(hwnd) && hwnd > 0 ? hwnd : null;
  }

  async ensure() {
    if (this.child && !this.dead) return this.child;
    if (this.starting) return this.starting;

    this.starting = new Promise((resolve) => {
      try {
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
          { cwd: this.projectRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
        );

        this.child = child;
        this.dead = false;

        const rl = readline.createInterface({ input: child.stdout });
        rl.on('line', (line) => {
          const waiter = this.pending.shift();
          if (waiter) waiter.resolve(line.trim());
        });

        readline.createInterface({ input: child.stderr }).on('line', (line) => {
          if (line.trim()) this.log('[inject] stderr', line.trim());
        });

        child.on('error', (err) => {
          this.log('[inject] 启动失败：', err.message);
          this.failAll('spawn-error');
          this.dead = true;
          resolve(null);
        });

        child.on('exit', (code) => {
          this.log('[inject] 子进程退出，code =', code);
          this.failAll('exited');
          this.child = null;
          this.dead = true;
        });

        // 等第一行 "OK ready"
        const boot = { resolve: null, timer: null, promise: null };
        boot.promise = new Promise((res) => {
          boot.resolve = res;
          boot.timer = setTimeout(() => res(false), 5000);
        });
        this.pending.push({
          resolve: (line) => {
            clearTimeout(boot.timer);
            boot.resolve(line === 'OK ready');
          },
        });

        boot.promise.then((ok) => {
          this.log('[inject] 注入器就绪 =', ok);
          resolve(ok ? child : null);
        });
      } catch (err) {
        this.log('[inject] 启动异常：', err.message);
        resolve(null);
      } finally {
        this.starting = null;
      }
    });

    return this.starting;
  }

  failAll(reason) {
    const waiters = this.pending;
    this.pending = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(`ERR ${reason}`);
    }
  }

  request(command) {
    if (!this.child || this.dead) return Promise.resolve('ERR not-running');
    return new Promise((resolve) => {
      const waiter = { resolve: null, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.pending.indexOf(waiter);
        if (index >= 0) this.pending.splice(index, 1);
        resolve('ERR timeout');
      }, REQUEST_TIMEOUT);
      waiter.resolve = (line) => {
        clearTimeout(waiter.timer);
        resolve(line);
      };
      this.pending.push(waiter);
      try {
        this.child.stdin.write(`${command}\n`);
      } catch (err) {
        clearTimeout(waiter.timer);
        resolve(`ERR write ${err.message}`);
      }
    });
  }

  async clientRect(hwnd) {
    const reply = await this.request(`rect ${hwnd}`);
    const match = /^OK rect (-?\d+) (-?\d+) (\d+) (\d+)$/.exec(reply);
    if (!match) return null;
    const [, left, top, width, height] = match;
    return { left: Number(left), top: Number(top), width: Number(width), height: Number(height) };
  }

  async click(hwnd, nx, ny) {
    const rect = await this.clientRect(hwnd);
    if (!rect || rect.width <= 0 || rect.height <= 0) return { ok: false, reason: 'no-rect' };

    const x = Math.round(nx * (rect.width - 1));
    const y = Math.round(ny * (rect.height - 1));
    const reply = await this.request(`click ${hwnd} ${x} ${y}`);
    if (reply !== 'OK click') return { ok: false, reason: reply };
    return { ok: true };
  }

  async wheel(hwnd, nx, ny, delta) {
    const rect = await this.clientRect(hwnd);
    if (!rect || rect.width <= 0 || rect.height <= 0) return { ok: false, reason: 'no-rect' };

    const x = Math.round(nx * (rect.width - 1));
    const y = Math.round(ny * (rect.height - 1));
    const step = delta > 0 ? -120 : 120; // 向上滚动为正 delta
    const reply = await this.request(`wheel ${hwnd} ${x} ${y} ${step}`);
    if (reply !== 'OK wheel') return { ok: false, reason: reply };
    return { ok: true };
  }

  stop() {
    if (this.child && !this.dead) {
      try {
        this.child.stdin.write('quit\n');
      } catch {
        // 忽略
      }
      setTimeout(() => {
        if (this.child) {
          try {
            this.child.kill();
          } catch {
            // 忽略
          }
        }
      }, 300);
    }
    this.child = null;
    this.dead = true;
  }
}

module.exports = { Injector };

'use strict';

/**
 * 自定义协议 screendeck://
 *
 * 为什么需要它：
 * 页面用 `file://` 加载时，origin 是 `null`。Chromium 不允许从 `null` origin 构造
 * Worker，pdf.js 的 `new Worker(file:///.../pdf.worker.min.js)` 会抛 SecurityError
 * （表现为 `DOMException`），于是 PDF 永远打不开；顺带 CSP 的 `'self'` 也匹配不到任何来源。
 *
 * 注册一个标准、安全的协议后：
 *   - 页面有真实 origin（screendeck://local），Worker / fetch / CSP 全部正常工作
 *   - 不再需要 blob:、file: 这类宽松例外
 *   - 静态资源按真实文件路径读取，并且做了越界校验
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { protocol } = require('electron');
const { isInside } = require('./paths');

const SCHEME = 'screendeck';
const HOST = 'local';
const ORIGIN = `${SCHEME}://${HOST}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
};

/** 必须在 app ready 之前调用。 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/**
 * 注册请求处理器：把 screendeck://local/<相对路径> 映射到仓库根目录下的真实文件。
 * 越界（../ 之类）一律 403，符号链接解析后再判断。
 */
async function registerHandler(root, logger) {
  const log = typeof logger === 'function' ? logger : () => {};
  const realRoot = await fs.realpath(root);
  log('[protocol] 根目录 =', realRoot);

  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== HOST) {
        log('[protocol] 404 host 不匹配', request.url);
        return new Response('Not Found', { status: 404 });
      }

      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!relative) {
        log('[protocol] 404 空路径', request.url);
        return new Response('Not Found', { status: 404 });
      }

      const target = path.resolve(realRoot, relative);
      const real = await fs.realpath(target);

      if (!isInside(realRoot, real)) {
        log('[protocol] 403 越界', relative);
        return new Response('Forbidden', { status: 403 });
      }

      const data = await fs.readFile(real);
      const mime = MIME[path.extname(real).toLowerCase()] || 'application/octet-stream';
      log('[protocol] 200', relative, `${data.length}B`, mime);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: { 'content-type': mime },
      });
    } catch (err) {
      log('[protocol] 404 读取失败', request.url, err && err.code ? err.code : String(err));
      return new Response('Not Found', { status: 404 });
    }
  });
}

module.exports = { SCHEME, HOST, ORIGIN, registerScheme, registerHandler };

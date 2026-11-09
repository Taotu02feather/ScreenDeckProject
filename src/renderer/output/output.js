'use strict';

/**
 * 大屏输出窗口。
 * 它只做两件事：订阅共享状态并渲染；把激光点画在对应位置。
 */

(function main() {
  const viewerRoot = document.getElementById('viewer');
  const laserNode = document.getElementById('laser');
  const hintNode = document.getElementById('hint');

  const fallback = document.getElementById('boot-fallback');
  if (fallback) fallback.remove();

  // pdf.js 的 worker 走本地文件，避免联网
  if (window.pdfjsLib) {
    const buildBase = new URL('../../../node_modules/pdfjs-dist/build/', document.baseURI).href;
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.js', buildBase).href;
  }

  const viewer = new window.Viewer(viewerRoot);

  function paintLaser(state) {
    const laser = state.laser || {};
    if (!laser.visible) {
      laserNode.classList.remove('on');
      return;
    }
    laserNode.style.left = `${(laser.x * 100).toFixed(2)}%`;
    laserNode.style.top = `${(laser.y * 100).toFixed(2)}%`;
    laserNode.classList.add('on');
  }

  function paintHint(state) {
    const source = state.source || {};
    const hasSource = source.type && source.type !== 'none';
    if (hasSource) {
      hintNode.classList.add('hidden');
    } else {
      hintNode.classList.remove('hidden');
    }
  }

  window.screenDeck.getState().then((state) => {
    viewer.apply(state).catch((err) => console.error('[output] 首次渲染失败', err));
    paintLaser(state);
    paintHint(state);
  });

  window.screenDeck.onState((state) => {
    viewer.apply(state).catch((err) => console.error('[output] 渲染失败', err));
    paintLaser(state);
    paintHint(state);
  });
})();

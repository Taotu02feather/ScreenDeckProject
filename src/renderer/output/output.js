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

  console.log(
    `[boot] output renderer 就绪 origin=${location.origin} pdfjs=${typeof window.pdfjsLib} marked=${typeof window.marked}`
  );

  // pdf.js 的 worker 走同源的自定义协议（screendeck://local/...），
  // 这样 Worker 构造不会被浏览器以 origin 为由拒绝（file:// 下会抛 SecurityError）
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${location.origin}/node_modules/pdfjs-dist/build/pdf.worker.min.js`;
  }

  const viewer = new window.Viewer(viewerRoot);

  // 上报真实视口，映射窗据此保持同一宽高比（避免"大屏画面偏上一点"这类差异）
  function reportViewport() {
    try {
      window.screenDeck.reportViewport({ width: window.innerWidth, height: window.innerHeight });
    } catch {
      // 忽略
    }
  }
  reportViewport();
  window.addEventListener('resize', reportViewport);

  // 退出时主动停止捕获流，避免强退后残留 GPU/捕获资源
  window.addEventListener('beforeunload', () => {
    try {
      viewer.destroy();
    } catch {
      // 忽略
    }
  });

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

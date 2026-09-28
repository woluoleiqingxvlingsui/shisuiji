/* 拾穗集 · 原页阅读进度 —— 内容脚本
 * 保存：滚动比例 + 视口顶部锚点（最近标题，退而求其次顶部文本块）。
 * 恢复：等页面高度稳定后，优先按锚点定位（JS 渲染长高的页面不漂移），比例兜底；
 * 恢复完再校正两次，防止恢复时内容还没加载完。
 * 只在顶层文档生效（iframe 不记）。
 */
(() => {
  if (window.top !== window) return;
  if (!/^https?:$/.test(location.protocol)) return;

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const HEADINGS = 'h1,h2,h3,h4,h5,h6';

  function scrollMax() {
    return document.documentElement.scrollHeight - window.innerHeight;
  }

  function ratio() {
    const max = scrollMax();
    return max <= 0 ? 0 : Math.min(1, Math.max(0, window.scrollY / max));
  }

  // ---------- 锚点：保存 ----------
  // 取视口顶部（避开 fixed 头，取样线 80px）上方最近的标题；
  // 没有标题就用顶部第一个有内容的文本块。
  // dy = 元素 rect.top（视口坐标，可为负）：恢复时 scrollY = 元素绝对顶部 - dy
  function captureAnchor() {
    try {
      const probe = 80;
      let best = null;
      for (const hd of document.querySelectorAll(HEADINGS)) {
        const txt = norm(hd.textContent);
        if (!txt || txt.length > 160) continue;
        const rectTop = hd.getBoundingClientRect().top;
        if (rectTop <= probe && (!best || rectTop > best.rectTop)) {
          best = { txt, rectTop };
        }
      }
      if (best) return { h: best.txt, dy: Math.round(best.rectTop) };

      for (const el of document.elementsFromPoint(window.innerWidth / 2, probe + 20)) {
        const txt = norm(el.textContent);
        if (txt.length >= 20) {
          return { t: txt.slice(0, 160), dy: Math.round(el.getBoundingClientRect().top) };
        }
      }
      return null;
    } catch { return null; }
  }

  // ---------- 锚点：恢复 ----------
  function findByHeading(h) {
    const heads = document.querySelectorAll(HEADINGS);
    for (const hd of heads) {
      if (norm(hd.textContent).slice(0, 160) === h) return hd;
    }
    // 宽松匹配：页面改版加了序号/后缀时按前 40 字互相包含找
    const short = h.slice(0, 40);
    for (const hd of heads) {
      const txt = norm(hd.textContent);
      if (txt && (txt.includes(short) || short.includes(txt.slice(0, 40)))) return hd;
    }
    return null;
  }

  function findByText(t) {
    const head = t.slice(0, 40);
    let loose = null;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      const txt = norm(el.textContent);
      if (!txt.includes(head)) continue;
      if (el.children.length === 0) return el; // 叶子文本块定位最准
      if (!loose && el.children.length <= 3) loose = el;
    }
    return loose;
  }

  function anchorToY(anchor) {
    if (!anchor) return null;
    const el = (anchor.h && findByHeading(anchor.h))
      || (anchor.t && findByText(anchor.t))
      || null;
    if (!el) return null;
    const absTop = el.getBoundingClientRect().top + window.scrollY;
    const dy = Number(anchor.dy) || 0;
    return Math.max(0, Math.round(absTop - dy));
  }

  function showNotice(p, anchorLabel) {
    const el = document.createElement('div');
    el.textContent = anchorLabel
      ? '📖 拾穗集：已回到「' + anchorLabel + '」'
      : '📖 拾穗集：已恢复到上次 ' + Math.round(p * 100) + '%';
    el.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;'
      + 'background:rgba(79,70,229,.94);color:#fff;padding:6px 16px;border-radius:999px;'
      + 'font:13px system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);'
      + 'max-width:80vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function doRestore(anchor, p) {
    let y = anchorToY(anchor);
    const byAnchor = y !== null;
    if (!byAnchor) {
      const max = scrollMax();
      if (max <= 200) return false;
      y = Math.round(p * max);
    }
    window.scrollTo(0, y);
    showNotice(p, byAnchor ? norm(anchor.h || anchor.t || '').slice(0, 30) : '');
    scheduleCorrection(anchor, p, byAnchor);
    return true;
  }

  // 用户是否亲自滚动过：滚动条动画/scroll anchoring 也会改 scrollY，
  // 不能拿位置变化当"用户接管"的信号，只听真实输入事件
  let userTookOver = false;
  for (const ev of ['wheel', 'touchstart', 'keydown']) {
    window.addEventListener(ev, () => { userTookOver = true; }, { passive: true, once: true });
  }

  // 恢复后内容可能还在加载（高度变了位置就漂）：用户没接管时按锚点/比例再校正两次。
  // 比例兜底同样要校正——恢复可能发生在"迟到渲染"之前（页面先是稳定矮高度，随后长高）
  function scheduleCorrection(anchor, p, byAnchor) {
    const target = () => (byAnchor ? anchorToY(anchor) : Math.round(p * scrollMax()));
    const correct = () => {
      if (userTookOver) return;
      const y = target();
      if (y !== null && Math.abs(y - window.scrollY) > 60) window.scrollTo(0, y);
    };
    setTimeout(correct, 1200);
    setTimeout(correct, 3000);
    window.addEventListener('load', () => setTimeout(correct, 300), { once: true });
  }

  // 高度稳定判定：JS 渲染的页面高度是长出来的，太早跳会落在偏上的位置。
  // 连续 3 次（约 0.9s）高度不变且可滚动就恢复；最多等 20 轮（约 6s）后尽力恢复。
  function restoreWhenStable(anchor, p) {
    if (scrollMax() > 200 && anchorToY(anchor) !== null && document.readyState === 'complete') {
      doRestore(anchor, p);
      return;
    }
    let lastH = -1;
    let same = 0;
    let tries = 0;
    const tick = () => {
      if (userTookOver) return; // 等待期间用户已自己滚动：不再强跳
      tries++;
      const h = document.documentElement.scrollHeight;
      if (h === lastH) same++;
      else { same = 0; lastH = h; }
      const scrollable = h - window.innerHeight > 200;
      if ((same >= 3 && scrollable) || tries >= 20) {
        if (scrollable) doRestore(anchor, p);
        return;
      }
      setTimeout(tick, 300);
    };
    tick();
  }

  try {
    chrome.runtime.sendMessage({ type: 'get', url: location.href }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      const p = Number(res.progress) || 0;
      const anchor = res.anchor && typeof res.anchor === 'object' ? res.anchor : null;
      if (!anchor && p <= 0.02) return;
      restoreWhenStable(anchor, p);
    });
  } catch { /* 扩展上下文失效（如刚被卸载）忽略 */ }

  let timer = null;
  function report() {
    try {
      chrome.runtime.sendMessage({
        type: 'save', url: location.href, ratio: ratio(), anchor: captureAnchor(),
      });
    } catch { /* ignore */ }
  }
  window.addEventListener('scroll', () => {
    clearTimeout(timer);
    timer = setTimeout(report, 700);
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') report();
  });
  window.addEventListener('beforeunload', report);
})();

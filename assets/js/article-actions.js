/* 文章互动：阅读计数 + 点赞 + 分享（复制链接）
   统计走真实后端：POST /api/stats（Netlify Function → COS），
   阅读每浏览器每天每文章计 1 次，点赞同步到服务器并展示实时数值。 */
(function () {
  'use strict';

  var article = document.querySelector('.single-article');
  if (!article) return;

  var path = article.getAttribute('data-path') || location.pathname;
  var apiBase = (article.getAttribute('data-stats-api') || '').replace(/\/+$/, '');
  var initialViews = parseInt(article.getAttribute('data-views') || '0', 10) || 0;
  var initialLikes = parseInt(article.getAttribute('data-likes') || '0', 10) || 0;
  var api = apiBase + '/api/stats';

  var viewsEl = article.querySelector('.views-count');
  var likeBtn = article.querySelector('.like-btn');
  var likeCountEl = likeBtn ? likeBtn.querySelector('.like-count') : null;

  function setViews(n) { if (viewsEl) viewsEl.textContent = n; }
  function setLikes(n) { if (likeCountEl) likeCountEl.textContent = n; }

  function post(body) {
    return fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .catch(function () { return null; });
  }

  /* ---------- 阅读计数（本地去重：每浏览器每天每文章一次） ---------- */
  var dateStr = new Date().toISOString().slice(0, 10);
  var viewedKey = 'viewed:' + path + ':' + dateStr;
  if (!localStorage.getItem(viewedKey)) {
    post({
      path: path,
      action: 'view',
      initial: { views: initialViews, likes: initialLikes }
    }).then(function (res) {
      if (res && typeof res.views === 'number') {
        setViews(res.views);
        if (typeof res.likes === 'number') setLikes(res.likes);
      }
      try { localStorage.setItem(viewedKey, '1'); } catch (e) { /* 忽略 */ }
    });
  } else {
    // 当天已计过阅读：只同步一次最新数据，避免覆盖为旧值
    fetch(api + '?path=' + encodeURIComponent(path))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.exists) {
          if (typeof res.views === 'number') setViews(res.views);
          if (typeof res.likes === 'number') setLikes(res.likes);
        }
      })
      .catch(function () {});
  }

  /* ---------- 点赞（同步到服务器） ---------- */
  if (likeBtn) {
    var likeKey = 'liked:' + path;
    var liked = localStorage.getItem(likeKey) === '1';

    function renderLike() {
      likeBtn.classList.toggle('is-liked', liked);
      likeBtn.setAttribute('aria-pressed', liked ? 'true' : 'false');
    }

    likeBtn.addEventListener('click', function () {
      liked = !liked;
      try { localStorage.setItem(likeKey, liked ? '1' : '0'); } catch (e) { /* 忽略 */ }
      renderLike();
      post({
        path: path,
        action: 'like',
        liked: liked,
        initial: { views: initialViews, likes: initialLikes }
      }).then(function (res) {
        if (res && typeof res.likes === 'number') setLikes(res.likes);
      });
    });
    renderLike();
  }

  /* ---------- 分享：复制当前链接 ---------- */
  var shareBtn = document.querySelector('.share-btn');
  if (shareBtn) {
    var labelEl = shareBtn.querySelector('.action-label');
    var originalLabel = labelEl ? labelEl.textContent : '分享';

    function feedback(ok) {
      shareBtn.classList.add('is-copied');
      if (labelEl) labelEl.textContent = ok ? '已复制' : '复制失败';
      setTimeout(function () {
        shareBtn.classList.remove('is-copied');
        if (labelEl) labelEl.textContent = originalLabel;
      }, 2500);
    }

    function fallbackCopy(url, cb) {
      var ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      cb(ok);
    }

    shareBtn.addEventListener('click', function () {
      var url = location.href;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(
          function () { feedback(true); },
          function () { fallbackCopy(url, feedback); }
        );
      } else {
        fallbackCopy(url, feedback);
      }
    });
  }
})();

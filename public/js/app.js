/* PRISM client application */
(() => {
  const API = '';
  const FAV_KEY = 'prism_favorites';
  const AGE_KEY = 'prism_age_verified';
  const ADMIN_KEY = 'prism_admin_key';
  const VIEW_KEY = 'prism_view_mode';

  const state = {
    media: [],
    page: 0,
    loading: false,
    hasMore: true,
    currentView: 'gallery',
    lbIndex: -1,
    lbItems: [],
    adminKey: sessionStorage.getItem(ADMIN_KEY) || '',
    filters: { type: '', subreddit: '', sort: 'recent', tag: '', q: '', source: '', hasCreator: '' },
    selectedMedia: new Set(),
    favorites: loadFavorites(),
    viewMode: localStorage.getItem(VIEW_KEY) || 'masonry',
    creators: [],
    touchStartX: 0
  };

  let initialized = false;

  function loadFavorites() {
    try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function saveFavorites() {
    localStorage.setItem(FAV_KEY, JSON.stringify([...state.favorites]));
  }

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function px(url) {
    if (!url) return '';
    if (url.startsWith('/') || url.startsWith('data:')) return url;
    return API + '/api/proxy?url=' + encodeURIComponent(url);
  }
  function mediaSrc(m) {
    return px(m.preview_url || m.media_url || m.thumbnail_url || '');
  }
  function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function timeAgo(ts) {
    if (!ts) return '';
    const d = new Date(ts.includes('Z') || ts.includes('+') ? ts : ts + 'Z');
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (Number.isNaN(s) || s < 0) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (state.adminKey) headers['x-admin-key'] = state.adminKey;
    const res = await fetch(API + path, { ...opts, headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  }

  function toast(msg, type = '') {
    const stack = $('toast-stack');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .25s';
      setTimeout(() => el.remove(), 250);
    }, 2800);
  }

  /* ===== AGE GATE ===== */
  window.enterSite = function enterSite() {
    sessionStorage.setItem(AGE_KEY, '1');
    $('age-gate').style.display = 'none';
    $('app').classList.add('visible');
    init();
  };

  (function checkAge() {
    if (sessionStorage.getItem(AGE_KEY) === '1') {
      $('age-gate').style.display = 'none';
      $('app').classList.add('visible');
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
      else init();
    }
  })();

  /* ===== ROUTING ===== */
  window.navigate = function navigate(view, params) {
    if (view === 'gallery') location.hash = '#/gallery';
    else if (view === 'saved') location.hash = '#/saved';
    else if (view === 'creators') location.hash = '#/creators';
    else if (view === 'media') location.hash = '#/media/' + params;
    else if (view === 'creator') location.hash = '#/creator/' + params;
    else if (view === 'admin') location.hash = '#/admin';
  };

  function setActiveNav(view) {
    document.querySelectorAll('.bottom-nav button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
  }

  function handleRoute() {
    const hash = location.hash || '#/gallery';
    const parts = hash.split('/');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

    if (parts[1] === 'media' && parts[2]) {
      $('view-gallery').classList.add('active');
      state.currentView = 'gallery';
      setActiveNav('gallery');
      openLightboxById(parts[2]);
      return;
    }

    closeLightbox(false);

    if (parts[1] === 'creator' && parts[2]) {
      state.currentView = 'creator';
      $('view-creator').classList.add('active');
      setActiveNav('creators');
      loadCreator(parts[2]);
    } else if (parts[1] === 'creators') {
      state.currentView = 'creators';
      $('view-creators').classList.add('active');
      setActiveNav('creators');
      loadCreatorsBrowse();
    } else if (parts[1] === 'saved') {
      state.currentView = 'saved';
      $('view-saved').classList.add('active');
      setActiveNav('saved');
      renderSaved();
    } else if (parts[1] === 'admin') {
      state.currentView = 'admin';
      $('view-admin').classList.add('active');
      setActiveNav('admin');
      loadAdminDashboard();
    } else {
      state.currentView = 'gallery';
      $('view-gallery').classList.add('active');
      setActiveNav('gallery');
    }
  }

  window.addEventListener('hashchange', handleRoute);

  /* ===== INIT ===== */
  function init() {
    if (initialized) return;
    initialized = true;
    applyViewMode();
    syncFiltersFromUrl();
    loadSubreddits();
    loadSources();
    loadTags();
    loadStats();
    loadMedia(true);
    setupInfiniteScroll();
    connectSSE();
    handleRoute();
    loadDefaultSubs();
    setupGestures();
    updateFavCount();
  }

  function syncFiltersFromUrl() {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    // also support query in location.search for shareable links
    const params = new URLSearchParams(location.search);
    ['type', 'subreddit', 'sort', 'tag', 'q', 'source', 'hasCreator'].forEach(k => {
      const v = params.get(k);
      if (v != null) state.filters[k] = v;
    });
    if ($('filter-type')) $('filter-type').value = state.filters.type;
    if ($('filter-sub')) $('filter-sub').value = state.filters.subreddit;
    if ($('filter-sort')) $('filter-sort').value = state.filters.sort || 'recent';
    if ($('filter-tag')) $('filter-tag').value = state.filters.tag;
    if ($('filter-source')) $('filter-source').value = state.filters.source;
    if ($('search-input')) $('search-input').value = state.filters.q;
    if ($('m-search-input')) $('m-search-input').value = state.filters.q;
    syncCreatorChip();
  }

  function pushFilterUrl() {
    const p = new URLSearchParams();
    Object.entries(state.filters).forEach(([k, v]) => { if (v) p.set(k, v); });
    const qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + (location.hash || '#/gallery'));
  }

  /* ===== GALLERY ===== */
  async function loadMedia(reset) {
    if (state.loading) return;
    if (!reset && !state.hasMore) return;
    state.loading = true;
    if (reset) {
      state.page = 0;
      state.media = [];
      state.hasMore = true;
      $('gallery').innerHTML = '';
    }
    showSkeleton(true);
    $('loading-more')?.classList.toggle('hidden', reset);

    try {
      const f = state.filters;
      let url = `/api/media?page=${state.page}&limit=40&sort=${encodeURIComponent(f.sort || 'recent')}`;
      if (f.type) url += '&type=' + encodeURIComponent(f.type);
      if (f.subreddit) url += '&subreddit=' + encodeURIComponent(f.subreddit);
      if (f.source) url += '&source=' + encodeURIComponent(f.source);
      if (f.hasCreator) url += '&hasCreator=1';
      if (f.tag) url += '&tag=' + encodeURIComponent(f.tag);
      if (f.q) url += '&q=' + encodeURIComponent(f.q);

      const data = await api(url);
      showSkeleton(false);

      if (!data.items.length) {
        state.hasMore = false;
        if (!state.media.length) showEmpty(true, data.total === 0);
        return;
      }
      showEmpty(false);
      data.items.forEach(item => {
        if (!state.media.find(m => m.id === item.id)) {
          state.media.push(item);
          renderCard(item, $('gallery'));
        }
      });
      state.hasMore = data.items.length >= 40;
      state.page++;
      if ($('st-shown')) $('st-shown').textContent = state.media.length;
    } catch (e) {
      console.error(e);
      showSkeleton(false);
      toast('Failed to load media', 'err');
    } finally {
      state.loading = false;
      $('loading-more')?.classList.add('hidden');
    }
  }

  function heartSvg(on) {
    return on
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.2-4.6-9.5-8.2C.5 9.4 2.2 6 5.5 6c1.8 0 3.2 1 4 2.2C10.3 7 11.7 6 13.5 6c3.3 0 5 3.4 3 6.8C19.2 16.4 12 21 12 21z"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7.2-4.6-9.5-8.2C.5 9.4 2.2 6 5.5 6c1.8 0 3.2 1 4 2.2C10.3 7 11.7 6 13.5 6c3.3 0 5 3.4 3 6.8C19.2 16.4 12 21 12 21z"/></svg>';
  }

  function sourceLabel(p) {
    const map = { reddit: 'Reddit', x: 'X', redgifs: 'RedGIFs', ddg: 'Host', web: 'Web' };
    return map[p] || p || '';
  }

  function renderCard(item, container) {
    if (/image you are requesting does not exist|no longer available|probably deleted/i.test(item.title || '')) return;
    const d = document.createElement('article');
    d.className = 'media-tile';
    d.dataset.id = item.id;
    d.tabIndex = 0;
    d.setAttribute('role', 'button');
    d.setAttribute('aria-label', item.title || 'Open media');
    const favOn = state.favorites.has(item.id);
    const typeLabel = item.media_type === 'video' ? 'Video' : 'Photo';
    const handle = item.author && item.author !== 'web' ? '@' + item.author : '';
    const community = item.source_platform === 'reddit' && item.subreddit
      ? 'r/' + item.subreddit
      : sourceLabel(item.source_platform);
    d.innerHTML = `
      <img src="${esc(mediaSrc(item))}" loading="lazy" alt="" onerror="this.closest('.media-tile')?.remove()">
      <span class="badge type">${esc(typeLabel)}</span>
      <span class="badge source">${esc(sourceLabel(item.source_platform))}</span>
      <button class="fav-btn ${favOn ? 'on' : ''}" type="button" aria-label="Save" data-fav="${esc(item.id)}">${heartSvg(favOn)}</button>
      <div class="overlay">
        <div class="card-sub ${handle ? 'creator' : ''}">${esc(handle || community)}</div>
        <div class="card-title">${esc(truncate(item.title, 80))}</div>
        <div class="card-meta"><span>${esc(community)}</span><span>${esc(timeAgo(item.created_at))}</span></div>
      </div>`;
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-fav]')) return;
      state.lbItems = state.currentView === 'saved' ? getFavoriteItems() : state.media;
      state.lbIndex = state.lbItems.findIndex(m => m.id === item.id);
      navigate('media', item.id);
    });
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.click(); }
    });
    d.querySelector('[data-fav]').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(item);
      const on = state.favorites.has(item.id);
      e.currentTarget.classList.toggle('on', on);
      e.currentTarget.innerHTML = heartSvg(on);
    });
    container.appendChild(d);
  }

  function showSkeleton(show) {
    const el = $('gallery-skeleton');
    if (!el) return;
    if (!show) { el.innerHTML = ''; return; }
    let html = '<div class="gallery">';
    for (let i = 0; i < 12; i++) {
      const h = 140 + Math.random() * 180;
      html += `<div class="media-tile" style="pointer-events:none"><div class="skeleton" style="height:${h}px"></div></div>`;
    }
    html += '</div>';
    el.innerHTML = html;
  }

  function showEmpty(show, archiveEmpty) {
    const g = $('gallery');
    if (!show) return;
    const filtered = !!(state.filters.type || state.filters.subreddit || state.filters.tag || state.filters.q || state.filters.source || state.filters.hasCreator);
    if (g.querySelector('.empty-state')) g.querySelector('.empty-state').remove();
    if (filtered) {
      g.innerHTML = `<div class="empty-state" role="status">
        <h2>Nothing matches</h2>
        <p>No published media for these filters. Reset, or browse by creator instead of random posts.</p>
        <button class="btn btn-primary" type="button" onclick="clearSearch()">Reset filters</button>
        <button class="btn" type="button" onclick="navigate('creators')">Browse creators</button>
      </div>`;
      return;
    }
    g.innerHTML = `<div class="empty-state" role="status">
      <h2>${archiveEmpty === false ? 'No media yet' : 'Archive is empty'}</h2>
      <p>PRISM discovers gay male creator photos and videos from public Reddit, X, and RedGIFs. Nothing is here until you run a scan.</p>
      <ol class="hint-steps">
        <li>Open Admin and enter your key</li>
        <li>Keep Reddit + X + RedGIFs on</li>
        <li>Tap “Scan all creator sources”</li>
      </ol>
      <button class="btn btn-primary" type="button" onclick="openAdmin()">Open Admin to ingest</button>
    </div>`;
  }

  function syncCreatorChip() {
    const chip = $('chip-creators');
    if (!chip) return;
    const on = !!state.filters.hasCreator;
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  window.toggleCreatorBrowse = function toggleCreatorBrowse() {
    state.filters.hasCreator = state.filters.hasCreator ? '' : '1';
    syncCreatorChip();
    pushFilterUrl();
    navigate('gallery');
    loadMedia(true);
  };

  function setupInfiniteScroll() {
    const sentinel = $('scroll-sentinel');
    if (!sentinel) return;
    new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !state.loading && state.hasMore && state.currentView === 'gallery') {
        loadMedia(false);
      }
    }, { rootMargin: '500px' }).observe(sentinel);
  }

  window.applyFilters = function applyFilters() {
    state.filters.type = $('filter-type')?.value || $('m-filter-type')?.value || '';
    state.filters.subreddit = $('filter-sub')?.value || $('m-filter-sub')?.value || '';
    state.filters.source = $('filter-source')?.value || $('m-filter-source')?.value || '';
    state.filters.sort = $('filter-sort')?.value || $('m-filter-sort')?.value || 'recent';
    state.filters.tag = $('filter-tag')?.value || $('m-filter-tag')?.value || '';
    ['filter-type', 'm-filter-type'].forEach(id => { if ($(id)) $(id).value = state.filters.type; });
    ['filter-sub', 'm-filter-sub'].forEach(id => { if ($(id)) $(id).value = state.filters.subreddit; });
    ['filter-source', 'm-filter-source'].forEach(id => { if ($(id)) $(id).value = state.filters.source; });
    ['filter-sort', 'm-filter-sort'].forEach(id => { if ($(id)) $(id).value = state.filters.sort; });
    ['filter-tag', 'm-filter-tag'].forEach(id => { if ($(id)) $(id).value = state.filters.tag; });
    syncCreatorChip();
    pushFilterUrl();
    closeFilterDrawer();
    navigate('gallery');
    loadMedia(true);
  };

  window.doSearch = function doSearch(fromMobile) {
    const q = (fromMobile ? $('m-search-input') : $('search-input'))?.value.trim() || '';
    state.filters.q = q;
    if ($('search-input')) $('search-input').value = q;
    if ($('m-search-input')) $('m-search-input').value = q;
    closeMobileSearch();
    pushFilterUrl();
    navigate('gallery');
    setTimeout(() => loadMedia(true), 40);
  };

  window.clearSearch = function clearSearch() {
    state.filters = { type: '', subreddit: '', sort: 'recent', tag: '', q: '', source: '', hasCreator: '' };
    ['filter-type', 'm-filter-type', 'filter-sub', 'm-filter-sub', 'filter-tag', 'm-filter-tag', 'filter-source', 'm-filter-source'].forEach(id => {
      if ($(id)) $(id).value = '';
    });
    if ($('filter-sort')) $('filter-sort').value = 'recent';
    if ($('m-filter-sort')) $('m-filter-sort').value = 'recent';
    if ($('search-input')) $('search-input').value = '';
    if ($('m-search-input')) $('m-search-input').value = '';
    syncCreatorChip();
    pushFilterUrl();
    loadMedia(true);
  };

  window.toggleViewMode = function toggleViewMode() {
    state.viewMode = state.viewMode === 'masonry' ? 'grid' : 'masonry';
    localStorage.setItem(VIEW_KEY, state.viewMode);
    applyViewMode();
  };

  function applyViewMode() {
    const g = $('gallery');
    const sg = $('saved-gallery');
    [g, sg].forEach(el => {
      if (!el) return;
      el.classList.toggle('grid-mode', state.viewMode === 'grid');
    });
    document.querySelectorAll('[data-view-toggle]').forEach(btn => {
      btn.classList.toggle('active', state.viewMode === 'grid');
      btn.title = state.viewMode === 'grid' ? 'Switch to masonry' : 'Switch to grid';
      if (btn.tagName === 'BUTTON' && btn.classList.contains('chip')) {
        btn.textContent = state.viewMode === 'grid' ? 'Grid' : 'Masonry';
      }
    });
  }

  async function loadSources() {
    try {
      const sources = await api('/api/sources');
      ['filter-source', 'm-filter-source'].forEach(id => {
        const sel = $(id);
        if (!sel) return;
        const cur = sel.value;
        sel.innerHTML = '<option value="">All sources</option>';
        sources.forEach(s => {
          const o = document.createElement('option');
          o.value = s;
          o.textContent = sourceLabel(s);
          sel.appendChild(o);
        });
        sel.value = cur || state.filters.source;
      });
    } catch { /* ok */ }
  }

  async function loadSubreddits() {
    try {
      const subs = await api('/api/subreddits');
      ['filter-sub', 'm-filter-sub'].forEach(id => {
        const sel = $(id);
        if (!sel) return;
        const cur = sel.value;
        sel.innerHTML = '<option value="">All communities</option>';
        subs.forEach(s => {
          const o = document.createElement('option');
          o.value = s; o.textContent = 'r/' + s;
          sel.appendChild(o);
        });
        sel.value = cur || state.filters.subreddit;
      });
    } catch { /* ok */ }
  }

  async function loadTags() {
    try {
      const tags = await api('/api/tags?limit=80');
      ['filter-tag', 'm-filter-tag'].forEach(id => {
        const sel = $(id);
        if (!sel) return;
        const cur = sel.value;
        sel.innerHTML = '<option value="">All tags</option>';
        tags.forEach(t => {
          const o = document.createElement('option');
          o.value = t.name;
          o.textContent = `${t.name} (${t.usage_count})`;
          sel.appendChild(o);
        });
        sel.value = cur || state.filters.tag;
      });
    } catch { /* ok */ }
  }

  async function loadStats() {
    try {
      const s = await api('/api/stats');
      if ($('st-total')) $('st-total').textContent = s.total || 0;
      if ($('st-images')) $('st-images').textContent = s.images || 0;
      if ($('st-videos')) $('st-videos').textContent = s.videos || 0;
      if ($('st-creators')) $('st-creators').textContent = s.creators || 0;
      setStatus(s.ingesting ? (s.paused ? 'paused' : 'running') : 'idle');
    } catch { /* ok */ }
  }

  function setStatus(s) {
    const el = $('status-pill');
    if (!el) return;
    el.textContent = s.charAt(0).toUpperCase() + s.slice(1);
    el.className = 'status-pill ' + s;
  }

  /* ===== FAVORITES ===== */
  function toggleFavorite(item) {
    if (state.favorites.has(item.id)) {
      state.favorites.delete(item.id);
      toast('Removed from saved');
    } else {
      state.favorites.add(item.id);
      // cache item snapshot
      const cache = JSON.parse(localStorage.getItem('prism_fav_cache') || '{}');
      cache[item.id] = item;
      localStorage.setItem('prism_fav_cache', JSON.stringify(cache));
      toast('Saved', 'ok');
    }
    saveFavorites();
    updateFavCount();
    if (state.currentView === 'saved') renderSaved();
  }

  function updateFavCount() {
    const n = state.favorites.size;
    document.querySelectorAll('[data-fav-count]').forEach(el => {
      el.textContent = n ? String(n) : '';
      el.hidden = !n;
    });
  }

  function getFavoriteItems() {
    const cache = JSON.parse(localStorage.getItem('prism_fav_cache') || '{}');
    return [...state.favorites].map(id => cache[id] || state.media.find(m => m.id === id)).filter(Boolean);
  }

  function renderSaved() {
    const g = $('saved-gallery');
    g.innerHTML = '';
    applyViewMode();
    const items = getFavoriteItems();
    if (!items.length) {
      g.innerHTML = `<div class="empty-state"><h2>Nothing saved yet</h2><p>Tap the heart on any media tile to build your personal collection — stored on this device.</p>
        <button class="btn btn-primary" type="button" onclick="navigate('gallery')">Browse gallery</button></div>`;
      return;
    }
    items.forEach(item => renderCard(item, g));
  }

  /* ===== CREATORS ===== */
  async function loadCreatorsBrowse() {
    const el = $('creators-list');
    el.innerHTML = '<div class="loading-more">Loading creators…</div>';
    const q = $('creator-search')?.value.trim() || '';
    try {
      const data = await api('/api/creators?limit=100' + (q ? '&q=' + encodeURIComponent(q) : ''));
      state.creators = data.items || [];
      if (!state.creators.length) {
        el.innerHTML = `<div class="empty-state" role="status">
          <h2>${q ? 'No matching creators' : 'No creators yet'}</h2>
          <p>${q ? 'Try another handle, or reset the search.' : 'Creator profiles appear when ingested media has an author. Run a Reddit / X / RedGIFs scan first.'}</p>
          ${q ? '' : '<button class="btn btn-primary" type="button" onclick="openAdmin()">Open Admin to ingest</button>'}
        </div>`;
        return;
      }
      el.innerHTML = `<div class="creator-grid">${state.creators.map(c => {
        const initial = (c.display_name || c.primary_handle || '?')[0].toUpperCase();
        return `<button type="button" class="creator-card" onclick="navigate('creator','${esc(c.id)}')">
          <div class="creator-avatar">${esc(initial)}</div>
          <div>
            <h3>${esc(c.display_name || c.primary_handle)}</h3>
            <div class="handle">@${esc(c.primary_handle)}</div>
            <div class="meta">${esc(c.media_count || 0)} media · ${esc(c.total_score || 0)} score</div>
          </div>
        </button>`;
      }).join('')}</div>`;
    } catch (e) {
      el.innerHTML = `<div class="empty-state"><h2>Couldn’t load creators</h2><p>${esc(e.message)}</p></div>`;
    }
  }
  window.loadCreatorsBrowse = loadCreatorsBrowse;

  async function loadCreator(id) {
    const el = $('creator-content');
    el.innerHTML = '<div class="loading-more">Loading profile…</div>';
    try {
      const creator = await api('/api/creators/' + id);
      const mediaData = await api('/api/media?creator=' + encodeURIComponent(id) + '&limit=100');
      const initial = (creator.display_name || creator.primary_handle || '?')[0].toUpperCase();
      const badges = (creator.sources || []).map(s =>
        `<span class="chip" style="height:28px;font-size:11px">${esc(s.source_platform)}</span>`
      ).join('');

      let mediaGrid = '<div class="gallery" id="creator-gallery"></div>';
      el.innerHTML = `
        <a class="back-link" onclick="navigate('creators')">← Creators</a>
        <div class="creator-hero">
          <div class="creator-avatar">${esc(initial)}</div>
          <div style="flex:1">
            <h2 class="section-title" style="margin:0">${esc(creator.display_name || creator.primary_handle)}</h2>
            <div class="handle">@${esc(creator.primary_handle)}</div>
            ${creator.bio ? `<p style="margin-top:8px;color:var(--muted)">${esc(creator.bio)}</p>` : ''}
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">${badges}</div>
          </div>
        </div>
        <div class="creator-stats">
          <div class="creator-stat"><div class="cs-num">${esc(creator.media_count || 0)}</div><div class="cs-label">Media</div></div>
          <div class="creator-stat"><div class="cs-num">${esc(creator.total_score || 0)}</div><div class="cs-label">Total score</div></div>
        </div>
        ${mediaGrid}`;
      const g = $('creator-gallery');
      (mediaData.items || []).forEach(item => renderCard(item, g));
      if (!(mediaData.items || []).length) {
        g.outerHTML = '<div class="empty-state"><h2>No published media</h2></div>';
      }
    } catch (e) {
      el.innerHTML = `<div class="empty-state"><h2>Creator not found</h2><p>${esc(e.message)}</p></div>`;
    }
  }

  /* ===== SSE ===== */
  function connectSSE() {
    const es = new EventSource(API + '/api/stream');
    es.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'item' && !state.media.find(x => x.id === m.data.id)) {
          state.media.unshift(m.data);
          if (state.currentView === 'gallery') {
            const g = $('gallery');
            const empty = g.querySelector('.empty-state');
            if (empty) empty.remove();
            const tmp = document.createElement('div');
            renderCard(m.data, tmp);
            const card = tmp.firstChild;
            g.insertBefore(card, g.firstChild);
          }
        }
        if (m.type === 'stats') {
          updateIngestProgress(m.data);
        }
        if (m.type === 'outcome') renderIngestOutcome(m.data);
        if (m.type === 'status') setStatus(m.data);
        if (m.type === 'log') appendIngestLog(m.data);
      } catch { /* ignore */ }
    };
    es.onerror = () => { es.close(); setTimeout(connectSSE, 3000); };
  }

  /* ===== LIGHTBOX ===== */
  async function openLightboxById(id) {
    let item = state.media.find(m => m.id === id) || getFavoriteItems().find(m => m.id === id);
    if (!item) {
      try { item = await api('/api/media/' + id); }
      catch { toast('Media not found', 'err'); return; }
    }
    if (!state.lbItems.length) state.lbItems = state.media.length ? state.media : [item];
    state.lbIndex = state.lbItems.findIndex(m => m.id === item.id);
    if (state.lbIndex === -1) { state.lbItems.push(item); state.lbIndex = state.lbItems.length - 1; }
    renderLightbox(item);
  }

  async function renderLightbox(item) {
    const lb = $('lightbox');
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';
    const isVideo = item.media_type === 'video';
    const favOn = state.favorites.has(item.id);
    $('lb-stage').innerHTML = isVideo
      ? `<video class="lb-media" src="${esc(px(item.media_url))}" controls autoplay playsinline muted loop></video>`
      : `<img class="lb-media" src="${esc(px(item.media_url || item.preview_url))}" alt="">`;
    $('lb-fav').classList.toggle('on', favOn);
    $('lb-fav').innerHTML = heartSvg(favOn);

    let relatedHtml = '';
    try {
      const related = await api('/api/media/' + item.id + '/related?limit=12');
      if (related.length) {
        relatedHtml = `<h4 style="margin:16px 0 8px;font-size:13px;color:#9fb0bc">Related</h4>
          <div class="related-rail">${related.map(r => `
            <div class="related-card" onclick="navigate('media','${esc(r.id)}')">
              <img src="${esc(mediaSrc(r))}" alt="" loading="lazy">
              <div class="rc-title">${esc(truncate(r.title, 40))}</div>
            </div>`).join('')}</div>`;
      }
    } catch { /* ok */ }

    const tags = (item.tags || []).map(t =>
      `<button type="button" class="lb-tag" onclick="filterByTag('${esc(t.name)}')">${esc(t.name)}</button>`
    ).join('');
    const creatorLink = item.creator_id
      ? `<a href="#" onclick="event.preventDefault();closeLightbox();navigate('creator','${esc(item.creator_id)}')">${esc(item.author || 'Creator')}</a>`
      : `<span>${esc(item.author || '')}</span>`;

    $('lb-sheet').innerHTML = `
      <div class="lb-kicker">${esc(sourceLabel(item.source_platform))} · ${esc(item.media_type === 'video' ? 'Video' : 'Photo')}</div>
      <div class="lb-title">${esc(item.title || 'Untitled')}</div>
      <div class="lb-meta">
        ${item.source_platform === 'reddit' ? `<span>r/${esc(item.subreddit || 'unknown')}</span>` : `<span>${esc(sourceLabel(item.source_platform))}</span>`}
        ${creatorLink}
        <span>${esc(item.score || 0)} pts</span>
        ${item.source_url ? `<a href="${esc(item.source_url)}" target="_blank" rel="noopener">Source</a>` : ''}
        <span>${esc(timeAgo(item.created_at))}</span>
      </div>
      ${item.description ? `<p style="font-size:13px;color:#9fb0bc;margin-bottom:8px">${esc(item.description)}</p>` : ''}
      ${item.ai_description ? `<div class="lb-ai-desc"><div class="ai-label">AI description</div>${esc(item.ai_description)}</div>` : ''}
      ${tags ? `<div class="lb-tags">${tags}</div>` : ''}
      ${relatedHtml}`;
  }

  window.closeLightbox = function closeLightbox(routeBack = true) {
    $('lightbox').classList.remove('open');
    document.body.style.overflow = '';
    $('lb-stage').innerHTML = '';
    if (routeBack && location.hash.startsWith('#/media/')) {
      history.replaceState(null, '', '#/gallery' + (location.search || ''));
    }
  };

  window.navLightbox = function navLightbox(dir) {
    const next = state.lbIndex + dir;
    if (next < 0 || next >= state.lbItems.length) return;
    state.lbIndex = next;
    const item = state.lbItems[next];
    history.replaceState(null, '', '#/media/' + item.id);
    renderLightbox(item);
  };

  window.toggleLbFavorite = function toggleLbFavorite() {
    const item = state.lbItems[state.lbIndex];
    if (!item) return;
    toggleFavorite(item);
    const on = state.favorites.has(item.id);
    $('lb-fav').classList.toggle('on', on);
    $('lb-fav').innerHTML = heartSvg(on);
  };

  window.shareCurrent = async function shareCurrent() {
    const item = state.lbItems[state.lbIndex];
    if (!item) return;
    const url = location.origin + '/?media=' + encodeURIComponent(item.id) + '#/media/' + item.id;
    try {
      if (navigator.share) await navigator.share({ title: item.title || 'PRISM', url });
      else {
        await navigator.clipboard.writeText(url);
        toast('Link copied', 'ok');
      }
    } catch {
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied', 'ok');
      } catch { toast('Could not share', 'err'); }
    }
  };

  window.filterByTag = function filterByTag(name) {
    closeLightbox();
    state.filters.tag = name;
    if ($('filter-tag')) $('filter-tag').value = name;
    if ($('m-filter-tag')) $('m-filter-tag').value = name;
    pushFilterUrl();
    navigate('gallery');
    loadMedia(true);
  };

  document.addEventListener('keydown', (e) => {
    if (!$('lightbox').classList.contains('open')) return;
    if (e.key === 'Escape') { closeLightbox(); navigate('gallery'); }
    if (e.key === 'ArrowLeft') navLightbox(-1);
    if (e.key === 'ArrowRight') navLightbox(1);
    if (e.key === 'f' || e.key === 'F') toggleLbFavorite();
  });

  function setupGestures() {
    const stage = $('lb-stage-wrap') || $('lb-stage');
    if (!stage) return;
    stage.addEventListener('touchstart', (e) => {
      state.touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].screenX - state.touchStartX;
      if (Math.abs(dx) < 56) return;
      if (dx < 0) navLightbox(1);
      else navLightbox(-1);
    }, { passive: true });
  }

  /* ===== MOBILE UI HELPERS ===== */
  window.openMobileSearch = () => $('mobile-search').classList.add('open');
  window.closeMobileSearch = () => $('mobile-search').classList.remove('open');
  window.openFilterDrawer = () => $('filter-drawer').classList.add('open');
  window.closeFilterDrawer = () => $('filter-drawer').classList.remove('open');

  /* ===== ADMIN ===== */
  window.openAdmin = function openAdmin() {
    if (!state.adminKey) {
      $('admin-key-modal').classList.add('open');
      $('admin-key-input')?.focus();
      return;
    }
    navigate('admin');
  };

  window.toggleAdmin = function toggleAdmin() {
    if (state.currentView === 'admin') navigate('gallery');
    else openAdmin();
  };

  window.submitAdminKey = function submitAdminKey() {
    state.adminKey = $('admin-key-input').value.trim();
    sessionStorage.setItem(ADMIN_KEY, state.adminKey);
    closeAdminModal();
    navigate('admin');
  };

  window.closeAdminModal = () => $('admin-key-modal').classList.remove('open');

  window.switchAdminTab = function switchAdminTab(tab, el) {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
    el.classList.add('active');
    $('admin-' + tab).classList.add('active');
    if (tab === 'dashboard') loadAdminDashboard();
    if (tab === 'ingestion') loadAdminIngestion();
    if (tab === 'moderation') loadAdminModeration();
    if (tab === 'media-mgr') loadAdminMedia();
    if (tab === 'creator-mgr') loadAdminCreators();
    if (tab === 'settings') loadAdminSettings();
  };

  async function loadAdminDashboard() {
    try {
      const stats = await api('/api/stats');
      $('dash-cards').innerHTML = `
        <div class="dash-card"><div class="dc-num">${esc(stats.total)}</div><div class="dc-label">Total media</div></div>
        <div class="dash-card"><div class="dc-num">${esc(stats.creators)}</div><div class="dc-label">Creators</div></div>
        <div class="dash-card"><div class="dc-num">${esc(stats.jobs)}</div><div class="dc-label">Jobs run</div></div>
        <div class="dash-card"><div class="dc-num">${esc(stats.moderationQueue)}</div><div class="dc-label">Mod queue</div></div>`;
      const jobs = await api('/api/admin/jobs?limit=10');
      $('jobs-table').innerHTML = jobs.map(j => {
        const s = j.stats ? JSON.parse(j.stats) : {};
        return `<tr><td style="font-family:monospace;font-size:11px">${esc(j.id.slice(0, 8))}</td><td>${esc(j.status)}</td><td>${esc(timeAgo(j.started_at))}</td><td>${esc(s.total || 0)}</td></tr>`;
      }).join('') || '<tr><td colspan="4">No jobs yet</td></tr>';
    } catch (e) {
      toast(e.message || 'Admin access failed', 'err');
    }
  }

  async function loadAdminIngestion() {
    try {
      await ensureIngestCatalog();
      const jobs = await api('/api/admin/jobs?limit=20');
      $('ingest-jobs-table').innerHTML = jobs.map(j => {
        const cfg = j.config ? JSON.parse(j.config) : {};
        const s = j.stats ? JSON.parse(j.stats) : {};
        const src = cfg.sources ? cfg.sources.join('+') : (cfg.subs ? cfg.subs.length + ' subs' : '');
        return `<tr>
          <td style="font-family:monospace;font-size:11px">${esc(j.id.slice(0, 8))}</td>
          <td>${esc(j.status)}</td>
          <td style="font-size:11px">${esc(src)}</td>
          <td>${esc(s.total || 0)} new · ${esc(s.skipped || 0)} skipped · ${esc(s.dupes || 0)} dupes · ${esc(s.swept || 0)} swept</td>
          <td>${esc(timeAgo(j.started_at))}</td>
          <td>${j.completed_at ? esc(timeAgo(j.completed_at)) : '—'}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="6">No jobs yet</td></tr>';
      const st = await api('/api/admin/ingest/status');
      if (st.lastOutcome) renderIngestOutcome(st.lastOutcome);
      if (st.stats) updateIngestProgress(st.stats);
      if (st.logs && st.logs.length) {
        $('ingest-log').textContent = st.logs.map(l => `[${l.level}] ${l.msg}`).join('\n');
        $('ingest-log').scrollTop = $('ingest-log').scrollHeight;
      }
    } catch { /* ok */ }
  }

  let ingestCatalog = null;
  let activePack = 'mixed';

  async function ensureIngestCatalog() {
    if (ingestCatalog) return ingestCatalog;
    ingestCatalog = await api('/api/ingest-catalog');
    renderSourceCards(ingestCatalog.sources);
    renderQueryPacks(ingestCatalog.packs);
    fillIngestDefaults(ingestCatalog.defaults);
    return ingestCatalog;
  }

  function renderSourceCards(sources) {
    const el = $('ingest-sources');
    if (!el || el.querySelector('.source-card')) return;
    el.innerHTML = sources.map(s => `
      <label class="source-card ${s.defaultOn ? 'on' : ''}">
        <input type="checkbox" value="${esc(s.id)}" ${s.defaultOn ? 'checked' : ''} onchange="this.closest('.source-card').classList.toggle('on', this.checked)">
        <div>
          <div class="src-group">${esc(s.group)}</div>
          <h4>${esc(s.label)}</h4>
          <p>${esc(s.blurb)}</p>
        </div>
      </label>`).join('');
  }

  function renderQueryPacks(packs) {
    const el = $('query-packs');
    if (!el) return;
    el.innerHTML = packs.map(p =>
      `<button type="button" class="chip ${p.id === activePack ? 'active' : ''}" data-pack="${esc(p.id)}" onclick="applyQueryPack('${esc(p.id)}')">${esc(p.label)}</button>`
    ).join('');
  }

  function fillIngestDefaults(d) {
    if ($('ingest-subs') && !$('ingest-subs').value.trim()) $('ingest-subs').value = (d.subs || []).join('\n');
    if ($('ingest-queries')) $('ingest-queries').value = (d.queries || []).join('\n');
    if ($('ingest-xqueries')) $('ingest-xqueries').value = (d.xQueries || []).join('\n');
    if ($('ingest-redgifs')) $('ingest-redgifs').value = (d.redgifsQueries || []).join('\n');
    if ($('ingest-creator-queries') && !$('ingest-creator-queries').value.trim()) {
      $('ingest-creator-queries').value = (d.creatorQueries || []).join('\n');
    }
  }

  window.applyQueryPack = function applyQueryPack(id) {
    activePack = id;
    document.querySelectorAll('#query-packs .chip').forEach(c => c.classList.toggle('active', c.dataset.pack === id));
    const pack = (ingestCatalog?.packs || []).find(p => p.id === id);
    if (!pack) return toast('Pack not loaded yet', 'err');
    if ($('ingest-subs')) $('ingest-subs').value = (pack.reddit || []).join('\n');
    if ($('ingest-redgifs')) $('ingest-redgifs').value = (pack.redgifs || []).join('\n');
    if ($('ingest-xqueries')) $('ingest-xqueries').value = (pack.x || []).join('\n');
    if ($('ingest-queries')) $('ingest-queries').value = (pack.ddg || []).join('\n');
    if ($('ingest-creator-queries')) $('ingest-creator-queries').value = (pack.creators || []).join('\n');
    toast(pack.label + ' pack loaded');
  };

  function selectedSources() {
    return [...document.querySelectorAll('#ingest-sources input:checked')].map(i => i.value);
  }

  function lines(id) {
    return ($(id)?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
  }

  function updateIngestProgress(s) {
    if (!s) return;
    const box = $('ingest-progress');
    if (box) box.hidden = false;
    if ($('ip-new')) $('ip-new').textContent = s.total || 0;
    if ($('ip-skip')) $('ip-skip').textContent = s.skipped || 0;
    if ($('ip-dupe')) $('ip-dupe').textContent = s.dupes || 0;
    if ($('ip-sweep')) $('ip-sweep').textContent = s.swept || 0;
    if ($('ip-err')) $('ip-err').textContent = s.errors || 0;
  }

  function renderIngestOutcome(o) {
    const el = $('ingest-outcome');
    if (!el || !o) return;
    el.classList.add('has-data');
    el.textContent = `Last job: ${o.newItems || 0} new · ${o.skipped || 0} skipped (quality) · ${o.dupes || 0} already had · ${o.swept || 0} junk hidden · ${o.errors || 0} errors`;
  }

  window.adminIngestStart = function adminIngestStart() {
    const sources = selectedSources();
    if (!sources.length) return toast('Pick at least one source', 'err');
    api('/api/admin/ingest/start', {
      method: 'POST',
      body: JSON.stringify({
        sources,
        queryPack: activePack === 'mixed' ? undefined : activePack,
        subs: lines('ingest-subs'),
        queries: lines('ingest-queries'),
        xQueries: lines('ingest-xqueries'),
        webQueries: lines('ingest-queries'),
        redgifsQueries: lines('ingest-redgifs'),
        creatorQueries: lines('ingest-creator-queries'),
        redgifsUsers: lines('ingest-redgifs-users'),
        sort: $('ingest-sort').value,
        limit: parseInt($('ingest-limit').value, 10) || 40,
        minScore: parseInt($('ingest-minscore').value, 10) || 0
      })
    }).then(() => {
      toast('Creator scan started', 'ok');
      $('ingest-log').textContent = '';
      updateIngestProgress({ total: 0, skipped: 0, dupes: 0, swept: 0, errors: 0 });
    }).catch(e => toast(e.message, 'err'));
  };

  function appendIngestLog(entry) {
    const el = $('ingest-log');
    if (!el || !entry) return;
    const line = `[${entry.level}] ${entry.msg}`;
    el.textContent = (el.textContent + '\n' + line).trim();
    el.scrollTop = el.scrollHeight;
  }
  window.adminIngestPause = () => api('/api/admin/ingest/pause', { method: 'POST' }).then(() => toast('Paused')).catch(e => toast(e.message, 'err'));
  window.adminIngestResume = () => api('/api/admin/ingest/resume', { method: 'POST' }).then(() => toast('Resumed', 'ok')).catch(e => toast(e.message, 'err'));
  window.adminIngestStop = () => api('/api/admin/ingest/stop', { method: 'POST' }).then(() => toast('Stopped')).catch(e => toast(e.message, 'err'));
  window.adminIngestSweep = () => api('/api/admin/ingest/sweep', {
    method: 'POST',
    body: JSON.stringify({ probeImgur: true, limit: 800 })
  }).then((r) => toast(`Hid ${r.hidden || 0} junk items`, 'ok')).catch(e => toast(e.message, 'err'));

  async function loadAdminModeration() {
    try {
      const data = await api('/api/admin/moderation/queue');
      const el = $('mod-queue');
      if (!data.items.length) {
        el.innerHTML = '';
        $('mod-empty').style.display = '';
        return;
      }
      $('mod-empty').style.display = 'none';
      el.innerHTML = data.items.map(m => `
        <div class="mod-card">
          <img src="${esc(mediaSrc(m))}" alt="" onerror="this.style.display='none'">
          <div class="mod-info" style="flex:1">
            <h4>${esc(truncate(m.title, 60))}</h4>
            <p style="font-size:12px;color:var(--muted)">r/${esc(m.subreddit)} · ${esc(m.author)} · ${esc(m.orientation_scope)} · ${esc(m.publish_state)}</p>
          </div>
          <div class="mod-actions">
            <button class="btn btn-success btn-sm" type="button" onclick="moderateItem('${esc(m.id)}','approve')">Approve</button>
            <button class="btn btn-sm" type="button" onclick="moderateItem('${esc(m.id)}','hide')">Hide</button>
            <button class="btn btn-danger btn-sm" type="button" onclick="moderateItem('${esc(m.id)}','reject')">Reject</button>
          </div>
        </div>`).join('');
    } catch (e) { toast(e.message, 'err'); }
  }

  window.moderateItem = async function moderateItem(id, action) {
    try {
      await api('/api/admin/media/' + id + '/moderate', { method: 'POST', body: JSON.stringify({ action }) });
      toast('Moderated', 'ok');
      loadAdminModeration();
    } catch (e) { toast(e.message, 'err'); }
  };

  window.loadAdminMedia = async function loadAdminMedia() {
    try {
      const q = $('admin-media-search').value.trim();
      const data = await api('/api/media?limit=100&publishState=all' + (q ? '&q=' + encodeURIComponent(q) : ''));
      state.selectedMedia.clear();
      $('admin-media-table').innerHTML = data.items.map(m => `
        <tr>
          <td><input type="checkbox" class="media-checkbox" value="${esc(m.id)}" onchange="toggleMediaSelect('${esc(m.id)}',this.checked)"></td>
          <td><img src="${esc(mediaSrc(m))}" style="width:40px;height:40px;object-fit:cover;border-radius:6px" onerror="this.style.display='none'"></td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.title || '—')}</td>
          <td>${esc(m.media_type)}</td>
          <td>${esc(m.subreddit || '—')}</td>
          <td>${esc(m.score)}</td>
          <td>${esc(m.publish_state)}</td>
          <td>
            <button class="btn btn-sm" type="button" onclick="navigate('media','${esc(m.id)}')">View</button>
            <button class="btn btn-danger btn-sm" type="button" onclick="adminDeleteMedia('${esc(m.id)}')">Remove</button>
          </td>
        </tr>`).join('');
    } catch (e) { toast(e.message, 'err'); }
  };

  window.toggleMediaSelect = (id, checked) => {
    if (checked) state.selectedMedia.add(id); else state.selectedMedia.delete(id);
  };
  window.toggleSelectAll = (el) => {
    document.querySelectorAll('.media-checkbox').forEach(cb => {
      cb.checked = el.checked;
      toggleMediaSelect(cb.value, el.checked);
    });
  };
  window.bulkAction = async (action) => {
    if (!state.selectedMedia.size) return toast('No items selected');
    try {
      await api('/api/admin/media/bulk', { method: 'POST', body: JSON.stringify({ ids: [...state.selectedMedia], action }) });
      toast('Bulk action complete', 'ok');
      loadAdminMedia();
    } catch (e) { toast(e.message, 'err'); }
  };
  window.adminDeleteMedia = async (id) => {
    if (!confirm('Remove this media?')) return;
    try {
      await api('/api/admin/media/' + id, { method: 'DELETE' });
      toast('Removed');
      loadAdminMedia();
    } catch (e) { toast(e.message, 'err'); }
  };

  window.loadAdminCreators = async function loadAdminCreators() {
    try {
      const q = $('admin-creator-search').value.trim();
      const data = await api('/api/creators?limit=100' + (q ? '&q=' + encodeURIComponent(q) : ''));
      $('admin-creators-table').innerHTML = data.items.map(c => `
        <tr>
          <td><a href="#" onclick="event.preventDefault();navigate('creator','${esc(c.id)}')">${esc(c.primary_handle)}</a></td>
          <td>${esc(c.display_name || '—')}</td>
          <td>${esc(c.media_count)}</td>
          <td>${esc(c.total_score)}</td>
          <td>${esc(c.orientation_scope)}</td>
          <td><button class="btn btn-sm" type="button" onclick="navigate('creator','${esc(c.id)}')">View</button></td>
        </tr>`).join('');
    } catch (e) { toast(e.message, 'err'); }
  };

  async function loadAdminSettings() {
    try {
      const settings = await api('/api/admin/settings');
      $('setting-subs').value = settings.default_subs || '';
      if ($('setting-creator-queries')) $('setting-creator-queries').value = settings.creator_queries || '';
      $('setting-orientation').value = settings.orientation_policy || 'strict';
    } catch { /* ok */ }
  }

  window.saveSettings = async function saveSettings() {
    try {
      await api('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          default_subs: $('setting-subs').value,
          creator_queries: $('setting-creator-queries')?.value || '',
          orientation_policy: $('setting-orientation').value
        })
      });
      toast('Settings saved', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  async function loadDefaultSubs() {
    try {
      const settings = await api('/api/admin/settings').catch(() => ({}));
      const catalog = await api('/api/ingest-catalog').catch(() => null);
      if (catalog) {
        ingestCatalog = catalog;
        renderSourceCards(catalog.sources);
        renderQueryPacks(catalog.packs);
        fillIngestDefaults(catalog.defaults);
      }
      if (settings.default_subs) $('ingest-subs').value = settings.default_subs;
      if (settings.creator_queries && $('ingest-creator-queries')) {
        $('ingest-creator-queries').value = settings.creator_queries;
      }
      if (settings.redgifs_users && $('ingest-redgifs-users')) {
        $('ingest-redgifs-users').value = settings.redgifs_users;
      }
    } catch {
      if ($('ingest-subs') && !$('ingest-subs').value) {
        $('ingest-subs').value = [
          'gaybrosgonemild', 'boyswithabs', 'gaynsfw', 'twinks', 'gaymuscle',
          'gaybrosgonewild', 'otters', 'jockstraps', 'hardbodies'
        ].join('\n');
      }
    }
  }

  // Deep-link ?media=id
  const bootMedia = new URLSearchParams(location.search).get('media');
  if (bootMedia && sessionStorage.getItem(AGE_KEY) === '1') {
    location.hash = '#/media/' + bootMedia;
  }
})();

'use strict';

// ---------- 历史任务 ----------
function setupHistory() {
  const $h = (id) => document.getElementById(id);
  const modal = $h('history-modal');
  const listEl = $h('history-list');
  const escH = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const canvasName = (c) => ({ vertical: '竖屏9:16', horizontal: '横屏16:9', square: '方形1:1' }[c] || c || '-');

  async function load() {
    listEl.innerHTML = '<div class="hist-empty">加载中…</div>';
    let list = [];
    try { list = await (await fetch('/api/history')).json(); } catch (_) {}
    if (!list.length) { listEl.innerHTML = '<div class="hist-empty"><div class="hist-empty-icon">🗂️</div>还没有历史任务<div class="hist-empty-sub">完成一次混剪后会自动记录在这里，之后可随时回看参数、重新预览和下载成片。</div></div>'; return; }
    listEl.innerHTML = '';
    for (const h of list) listEl.appendChild(buildHistItem(h, escH, canvasName));
  }

  function buildHistItem(h, esc, canvasName) {
    const item = document.createElement('div');
    item.className = 'hist-item';
    const t = new Date(h.time).toLocaleString('zh-CN', { hour12: false });
    const badge = h.status === 'done' ? '<span class="hist-badge done">完成</span>' : '<span class="hist-badge error">失败</span>';
    const meta = `${h.count || '?'}条 · ${h.videos || '?'}个片段${h.hasSub ? ' · 字幕' : ''}${h.elapsedSec != null ? ' · ' + h.elapsedSec + 's' : ''}`;
    item.innerHTML =
      `<div class="hist-head"><span class="hist-time">${t}</span>${badge}<span class="hist-meta">${meta}</span></div>` +
      `<div class="hist-detail" hidden></div>`;
    const detail = item.querySelector('.hist-detail');
    let built = false;
    item.querySelector('.hist-head').addEventListener('click', () => {
      if (detail.hidden && !built) { detail.innerHTML = buildDetail(h, esc, canvasName); wireDetail(item, h); fillAccountSelects(detail); built = true; }
      detail.hidden = !detail.hidden;
    });
    return item;
  }

  function buildDetail(h, esc, canvasName) {
    const p = `画布 <b>${canvasName(h.canvas)}</b> · 帧率 <b>${h.fps || '-'}</b> · 时长基准 <b>${h.durationBasis || '-'}</b> · 顺序 <b>${h.order || '-'}</b> · 混音 <b>${h.audioMode || '-'}</b> · 字幕 <b>${h.hasSub ? '有' : '无'}</b>`;
    let outs = '';
    if (h.status === 'error') {
      outs = `<div class="hist-empty">该任务失败：${esc(h.error || '未知错误')}</div>`;
    } else {
      const exist = h.outputsExist || [];
      outs = '<div class="hist-outs">' + (h.outputs || []).map((name, i) => {
        const ok = exist[i] !== false;
        const n = i + 1;
        return `<div class="hist-out"><div class="ho-top"><span>第${n}条</span><span>` +
          (ok ? `<a href="/api/result/${h.id}/${n}" target="_blank">预览</a> · <a href="/api/download/${h.id}/${n}">下载</a>` : `<span class="gone">文件已清理</span>`) +
          `</span></div>` + (ok ? uploadControlHTML(h.id, n) : '') + `</div>`;
      }).join('') + '</div>';
      if (h.hasSub) outs += `<div style="margin-top:8px"><a href="/api/subtitle/${h.id}" style="color:var(--accent2);font-size:12px;text-decoration:none">📝 下载字幕 SRT</a></div>`;
    }
    return `<div class="hist-params">${p}</div>${outs}` +
      `<div class="hist-actions"><button class="hdel">删除此记录</button></div>`;
  }

  function wireDetail(item, h) {
    item.querySelector('.hdel').addEventListener('click', async () => {
      if (!confirm('删除这条历史记录？(成片文件保留)')) return;
      try { await fetch('/api/history/' + h.id, { method: 'DELETE' }); } catch (_) {}
      load();
    });
  }

  $h('history-btn').addEventListener('click', () => { modal.hidden = false; load(); });
  $h('history-close').addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
  window.reloadHistory = load; // 完成混剪后刷新
}
setupHistory();

// 选中的文件。bgm/voice 可以是“新上传的文件”，也可以是“素材库里选中的项”
// materialRefs：从「视频素材库」勾选的素材 [{folder,id,name}]
const files = { videos: [], bgm: null, voice: null, bgmLibRef: null, voiceLibRef: null, materialRefs: [] };

const $ = (id) => document.getElementById(id);

// ---------- 拖拽 / 选择 ----------
function setupDrop(kind, inputId, multiple) {
  const drop = $(`drop-${kind}`);
  const input = $(inputId);

  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => handleFiles(kind, [...input.files], multiple));

  ['dragenter', 'dragover'].forEach((e) =>
    drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('drag'); })
  );
  ['dragleave', 'drop'].forEach((e) =>
    drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('drag'); })
  );
  drop.addEventListener('drop', (ev) => {
    const list = [...ev.dataTransfer.files].filter((f) =>
      kind === 'videos' ? f.type.startsWith('video') || /\.(mp4|mov|mkv|avi|webm|flv|m4v)$/i.test(f.name)
                        : f.type.startsWith('audio') || /\.(mp3|wav|aac|m4a|flac|ogg)$/i.test(f.name)
    );
    handleFiles(kind, list, multiple);
  });
}

function handleFiles(kind, list, multiple) {
  if (!list.length) return;
  if (kind === 'videos') {
    files.videos = list.slice(0, 100);
    if (list.length > 100) alert('视频超过 100 条，已自动只取前 100 条。');
  } else {
    files[kind] = list[0];
    files[kind + 'LibRef'] = null; // 选了新文件就取消音频库的选中
  }
  refreshUI();
}

function humanSize(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

function refreshUI() {
  // 视频（本地上传 + 素材库选中）
  const dv = $('drop-videos');
  const matN = files.materialRefs.length;
  if (files.videos.length || matN) {
    const total = files.videos.reduce((s, f) => s + f.size, 0);
    const parts = [];
    if (files.videos.length) parts.push(`上传 ${files.videos.length} 条 · ${humanSize(total)}`);
    if (matN) parts.push(`素材库 ${matN} 条`);
    $('stat-videos').textContent = '已选 ' + parts.join(' + ');
    dv.classList.add('filled');
  } else { $('stat-videos').textContent = '未选择'; dv.classList.remove('filled'); }
  // 素材库选择信息
  const msi = $('mat-selected-info');
  if (msi) msi.textContent = matN ? `已从素材库选 ${matN} 条用于投放` : '';

  for (const k of ['bgm', 'voice']) {
    const d = $(`drop-${k}`);
    const ref = files[k + 'LibRef'];
    if (files[k]) {
      $(`stat-${k}`).textContent = `${files[k].name} · ${humanSize(files[k].size)}`;
      d.classList.add('filled');
    } else if (ref) {
      $(`stat-${k}`).textContent = `库：${ref.name}`;
      d.classList.add('filled');
    } else { $(`stat-${k}`).textContent = '未选择'; d.classList.remove('filled'); }
  }

  // 文件清单
  const fl = $('filelist');
  fl.innerHTML = files.videos.map((f, i) => `<div>${i + 1}. ${f.name} <span style="float:right">${humanSize(f.size)}</span></div>`).join('');

  // 开始按钮：至少要有视频（本地上传或素材库选的）
  $('btn-start').disabled = (files.videos.length + files.materialRefs.length) === 0;
}

setupDrop('videos', 'in-videos', true);
setupDrop('bgm', 'in-bgm', false);
setupDrop('voice', 'in-voice', false);

// ---------- 音频库（背景音乐 / 配音）弹窗 ----------
function setupAudioLib() {
  const $a = (id) => document.getElementById(id);
  const modal = $a('audiolib-modal');
  const listEl = $a('al-list');
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let type = 'bgm', curFolder = '__all__', folders = [], currentList = [], page = 0, dragItems = null, selectedItem = null, previewAudio = null;
  const pageSize = () => parseInt($a('al-pagesize').value, 10) || 50;
  const api = (p) => `/api/audiolib/${type}${p}`;
  const updSel = () => { $a('al-selinfo').textContent = selectedItem ? `已选：${selectedItem.name}` : '未选择'; };

  async function loadFolders() {
    try { folders = await (await fetch(api('/folders'))).json(); } catch (_) { folders = []; }
    renderSidebar();
  }
  function renderSidebar() {
    const box = $a('al-folders'); box.innerHTML = '';
    const items = [{ name: '__all__', label: '全部', icon: '📂', count: folders.reduce((a, f) => a + f.count, 0), drop: false }]
      .concat(folders.map((f) => ({ name: f.name, label: f.name, icon: '📁', count: f.count, drop: true })));
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'mat-folder-item' + (curFolder === it.name ? ' active' : '');
      const canEdit = it.drop && it.name !== '默认';
      el.innerHTML = `<span class="fi-icon">${it.icon}</span><span class="fi-name">${esc(it.label)}</span><span class="fi-count">${it.count}</span>` +
        (canEdit ? `<span class="fi-edit" title="重命名">✎</span><span class="fi-del" title="删除文件夹">✕</span>` : '');
      el.addEventListener('click', (e) => { if (e.target.closest('.fi-del') || e.target.closest('.fi-edit')) return; curFolder = it.name; page = 0; $a('al-search').value = ''; renderSidebar(); loadList(); });
      const ed = el.querySelector('.fi-edit');
      if (ed) ed.addEventListener('click', async (e) => { e.stopPropagation(); const nn = prompt('重命名文件夹：', it.name); if (!nn || !nn.trim() || nn.trim() === it.name) return; const d = await (await fetch(api('/folder/rename'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldName: it.name, newName: nn.trim() }) })).json(); if (!d.ok) { alert(d.error || '改名失败'); return; } if (curFolder === it.name) curFolder = d.name; await loadFolders(); loadList(); });
      const del = el.querySelector('.fi-del');
      if (del) del.addEventListener('click', async (e) => { e.stopPropagation(); if (!confirm(`删除文件夹「${it.name}」及其中所有音频？`)) return; try { await fetch(api('/folder/' + encodeURIComponent(it.name)), { method: 'DELETE' }); } catch (_) {} if (curFolder === it.name) curFolder = '__all__'; await loadFolders(); loadList(); });
      if (it.drop) {
        el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
        el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
        el.addEventListener('drop', async (e) => { e.preventDefault(); el.classList.remove('drag-over'); const mv = (dragItems || []).filter((x) => x.folder !== it.name); dragItems = null; if (!mv.length) return; await fetch(api('/move'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: mv, toFolder: it.name }) }); await loadFolders(); await loadList(); });
      }
      box.appendChild(el);
    }
  }
  async function loadList() {
    listEl.innerHTML = '<div class="al-empty">加载中…</div>';
    try { currentList = await (await fetch(api('?folder=' + encodeURIComponent(curFolder)))).json(); } catch (_) { currentList = []; }
    page = 0; renderList();
  }
  function visible() { const q = ($a('al-search').value || '').trim().toLowerCase(); return q ? currentList.filter((m) => (m.name || '').toLowerCase().includes(q)) : currentList; }
  function renderList() {
    const list = visible(); const ps = pageSize(); const pages = Math.max(1, Math.ceil(list.length / ps));
    if (page >= pages) page = pages - 1;
    const items = list.slice(page * ps, page * ps + ps);
    $a('al-total').textContent = `共 ${currentList.length} 个` + (list.length !== currentList.length ? `（匹配 ${list.length}）` : '');
    if (!currentList.length) { listEl.innerHTML = '<div class="al-empty">这个文件夹还没有音频，点上方「⬆ 上传」添加。</div>'; $a('al-pager').innerHTML = ''; return; }
    if (!list.length) { listEl.innerHTML = '<div class="al-empty">没有匹配的音频。</div>'; $a('al-pager').innerHTML = ''; return; }
    listEl.innerHTML = '';
    for (const m of items) {
      const row = document.createElement('div');
      const sel = selectedItem && selectedItem.folder === m.folder && selectedItem.id === m.id;
      row.className = 'al-item' + (sel ? ' selected' : '');
      row.draggable = true;
      row.innerHTML = `<span class="al-radio"></span><span class="al-icon">${type === 'voice' ? '🎙️' : '🎵'}</span><span class="al-name" title="${esc(m.name)}">${esc(m.name)}</span><button class="al-play" title="试听">▶</button><button class="al-del" title="删除">✕</button>`;
      row.addEventListener('click', (e) => { if (e.target.closest('.al-play') || e.target.closest('.al-del')) return; selectedItem = { folder: m.folder, id: m.id, name: m.name }; renderList(); updSel(); });
      row.addEventListener('dragstart', () => { dragItems = [{ folder: m.folder, id: m.id, name: m.name }]; });
      row.querySelector('.al-play').addEventListener('click', (e) => { e.stopPropagation(); togglePlay(m, e.currentTarget); });
      row.querySelector('.al-del').addEventListener('click', async (e) => { e.stopPropagation(); if (!confirm('从库中删除这个音频？')) return; try { await fetch(api('/' + encodeURIComponent(m.folder) + '/' + m.id), { method: 'DELETE' }); } catch (_) {} if (selectedItem && selectedItem.id === m.id) selectedItem = null; await loadFolders(); loadList(); updSel(); });
      listEl.appendChild(row);
    }
    renderPager(pages);
  }
  function renderPager(pages) {
    const p = $a('al-pager'); if (pages <= 1) { p.innerHTML = ''; return; }
    p.innerHTML = `<button class="pg-prev"${page === 0 ? ' disabled' : ''}>‹ 上一页</button><span>第 ${page + 1} / ${pages} 页</span><button class="pg-next"${page >= pages - 1 ? ' disabled' : ''}>下一页 ›</button>`;
    p.querySelector('.pg-prev').addEventListener('click', () => { if (page > 0) { page--; renderList(); } });
    p.querySelector('.pg-next').addEventListener('click', () => { if (page < pages - 1) { page++; renderList(); } });
  }
  function togglePlay(m, btn) {
    if (previewAudio && previewAudio._btn === btn) { stopPreview(); return; }
    stopPreview();
    previewAudio = new Audio(api('/file/' + encodeURIComponent(m.folder) + '/' + m.id));
    previewAudio._btn = btn; btn.classList.add('playing'); btn.textContent = '⏸';
    previewAudio.play().catch(() => {});
    previewAudio.onended = () => { btn.classList.remove('playing'); btn.textContent = '▶'; previewAudio = null; };
  }
  function stopPreview() { if (previewAudio) { previewAudio.pause(); if (previewAudio._btn) { previewAudio._btn.classList.remove('playing'); previewAudio._btn.textContent = '▶'; } previewAudio = null; } }

  document.querySelectorAll('.lib-open-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      type = btn.dataset.type;
      $a('al-title').textContent = (type === 'voice' ? '🎙️ 配音库' : '🎵 背景音乐库');
      $a('al-search').value = ''; curFolder = '__all__'; page = 0;
      selectedItem = files[type + 'LibRef'] ? { ...files[type + 'LibRef'] } : null;
      modal.hidden = false; await loadFolders(); await loadList(); updSel();
    });
  });
  $a('al-close').addEventListener('click', () => { stopPreview(); modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) { stopPreview(); modal.hidden = true; } });
  $a('al-search').addEventListener('input', () => { page = 0; renderList(); });
  $a('al-pagesize').addEventListener('change', () => { page = 0; renderList(); });
  $a('al-newfolder').addEventListener('click', async () => { const name = prompt('新建文件夹名称：'); if (!name || !name.trim()) return; const d = await (await fetch(api('/folder'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) })).json(); if (d.name) curFolder = d.name; page = 0; await loadFolders(); loadList(); });
  $a('al-upload-input').addEventListener('change', async (e) => {
    const list = [...e.target.files]; e.target.value = ''; if (!list.length) return;
    const folder = curFolder === '__all__' ? '默认' : curFolder;
    const fd = new FormData(); fd.append('folder', folder); list.forEach((f) => fd.append('audios', f, f.name));
    $a('al-status').textContent = `上传 ${list.length} 个中…`;
    try { const d = await (await fetch(api('/upload'), { method: 'POST', body: fd })).json(); if (!d.ok) throw new Error(d.error || '上传失败'); $a('al-status').textContent = `✓ 已入库 ${d.saved.length} 个`; curFolder = folder; await loadFolders(); await loadList(); setTimeout(() => { $a('al-status').textContent = ''; }, 2500); } catch (err) { $a('al-status').textContent = '✗ ' + err.message; }
  });
  $a('al-confirm').addEventListener('click', () => {
    stopPreview();
    if (selectedItem) { files[type + 'LibRef'] = { ...selectedItem }; files[type] = null; if ($('in-' + type)) $('in-' + type).value = ''; }
    else files[type + 'LibRef'] = null;
    modal.hidden = true; refreshUI();
  });
}
setupAudioLib();

// ---------- 脚本库 ----------
const scriptListEl = $('script-list');
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function flashBtn(btn, txt) { const o = btn.textContent; btn.textContent = txt; setTimeout(() => (btn.textContent = o), 1200); }

let allScripts = [];
let scriptPage = 0;
const SCRIPTS_PER_PAGE = 5;

// ----- SKU 分类 -----
let allSkus = [];          // [{name,count}]
let curSku = '__all__';    // 当前筛选的 SKU

async function loadSkus() {
  try { allSkus = await (await fetch('/api/scripts/skus')).json(); } catch (_) { allSkus = []; }
  renderSkuBar();
  fillSkuSelect($('script-sku'), curSku === '__all__' ? '' : curSku);
}

function renderSkuBar() {
  const bar = $('sku-bar');
  if (!bar) return;
  const total = allSkus.reduce((a, s) => a + s.count, 0);
  let html = `<button class="sku-chip${curSku === '__all__' ? ' active' : ''}" data-sku="__all__">全部 <b>${total}</b></button>`;
  for (const s of allSkus) {
    const act = curSku === s.name;
    html += `<button class="sku-chip${act ? ' active' : ''}" data-sku="${escAttrS(s.name)}">${esc(s.name)} <b>${s.count}</b>` +
      (act ? `<span class="sku-mini sku-ren" title="重命名">✎</span><span class="sku-mini sku-del" title="删除">✕</span>` : '') + `</button>`;
  }
  html += `<button class="sku-chip sku-add" title="新建 SKU 分类">＋ 新建SKU</button>`;
  bar.innerHTML = html;
  bar.querySelectorAll('.sku-chip[data-sku]').forEach((c) => {
    c.addEventListener('click', (e) => {
      if (e.target.classList.contains('sku-mini')) return; // 交给 ✎/✕
      curSku = c.dataset.sku; scriptPage = 0; renderSkuBar();
      fillSkuSelect($('script-sku'), curSku === '__all__' ? '' : curSku);
      loadScripts();
    });
  });
  const addBtn = bar.querySelector('.sku-add');
  if (addBtn) addBtn.addEventListener('click', createSku);
  const ren = bar.querySelector('.sku-ren'); if (ren) ren.addEventListener('click', (e) => { e.stopPropagation(); renameSku(curSku); });
  const del = bar.querySelector('.sku-del'); if (del) del.addEventListener('click', (e) => { e.stopPropagation(); deleteSku(curSku); });
}

function fillSkuSelect(sel, selected) {
  if (!sel) return;
  sel.innerHTML = allSkus.map((s) => `<option value="${escAttrS(s.name)}"${s.name === selected ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  if (!allSkus.length) sel.innerHTML = '<option value="K5-3 PRO">K5-3 PRO</option>';
}

async function createSku() {
  const name = (prompt('新建 SKU 分类名称（如 K6 / H7-ULTRA）：') || '').trim();
  if (!name) return;
  await fetch('/api/scripts/skus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  curSku = name; await loadSkus(); loadScripts();
}
async function renameSku(name) {
  const to = (prompt('重命名 SKU 分类：', name) || '').trim();
  if (!to || to === name) return;
  await fetch('/api/scripts/skus/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: name, to }) });
  curSku = to; await loadSkus(); loadScripts();
}
async function deleteSku(name) {
  if (!confirm(`删除 SKU 分类「${name}」？\n其下脚本会自动移到其它分类（不会删除脚本）。`)) return;
  const r = await (await fetch('/api/scripts/skus/' + encodeURIComponent(name), { method: 'DELETE' })).json();
  curSku = '__all__'; await loadSkus(); loadScripts();
}

async function loadScripts() {
  try { allScripts = await (await fetch('/api/scripts?sku=' + encodeURIComponent(curSku))).json(); } catch (_) { allScripts = []; }
  renderScriptPage();
}

function renderScriptPage() {
  scriptListEl.innerHTML = '';
  if (!allScripts.length) { scriptListEl.innerHTML = '<div class="lib-empty">（暂无脚本，保存的会显示在这里）</div>'; return; }
  const totalPages = Math.ceil(allScripts.length / SCRIPTS_PER_PAGE);
  if (scriptPage >= totalPages) scriptPage = totalPages - 1;
  if (scriptPage < 0) scriptPage = 0;
  const start = scriptPage * SCRIPTS_PER_PAGE;
  for (const s of allScripts.slice(start, start + SCRIPTS_PER_PAGE)) scriptListEl.appendChild(buildScriptItem(s));
  if (totalPages > 1) {
    const pager = document.createElement('div');
    pager.className = 'script-pager';
    pager.innerHTML =
      `<button class="pg-btn pg-prev"${scriptPage === 0 ? ' disabled' : ''}>‹ 上一页</button>` +
      `<span class="pg-info">第 ${scriptPage + 1} / ${totalPages} 页 · 共 ${allScripts.length} 条</span>` +
      `<button class="pg-btn pg-next"${scriptPage >= totalPages - 1 ? ' disabled' : ''}>下一页 ›</button>`;
    pager.querySelector('.pg-prev').addEventListener('click', () => { if (scriptPage > 0) { scriptPage--; renderScriptPage(); } });
    pager.querySelector('.pg-next').addEventListener('click', () => { if (scriptPage < totalPages - 1) { scriptPage++; renderScriptPage(); } });
    scriptListEl.appendChild(pager);
  }
}

function buildScriptItem(s) {
  const item = document.createElement('div');
  item.className = 'script-item';
  item.innerHTML =
    `<div class="script-head"><span class="script-title" title="点击展开/收起">${esc(s.title)}</span>` +
    `<span class="script-ops">` +
    `<select class="script-skusel" title="归类到 SKU">${allSkus.map((k) => `<option value="${escAttrS(k.name)}"${k.name === (s.sku || '') ? ' selected' : ''}>${esc(k.name)}</option>`).join('')}</select>` +
    `<button class="tts" title="用 MiniMax 把这条脚本生成配音，存入配音库">🎙️ 生成配音</button>` +
    `<button class="copy">复制</button><button class="edit">编辑</button><button class="del">删除</button>` +
    `<button class="save" hidden>保存</button><button class="cancel" hidden>取消</button>` +
    `</span></div>` +
    `<div class="script-preview">${esc(s.preview)}…</div>` +
    `<div class="script-full" hidden><textarea readonly rows="8"></textarea></div>`;
  const titleEl = item.querySelector('.script-title');
  const full = item.querySelector('.script-full');
  const ta = full.querySelector('textarea');
  const preview = item.querySelector('.script-preview');
  const btnCopy = item.querySelector('.copy');
  const btnEdit = item.querySelector('.edit');
  const btnDel = item.querySelector('.del');
  const btnSave = item.querySelector('.save');
  const btnCancel = item.querySelector('.cancel');
  const skuSel = item.querySelector('.script-skusel');
  skuSel.addEventListener('click', (e) => e.stopPropagation());
  skuSel.addEventListener('change', async () => {
    const sku = skuSel.value;
    try { await fetch('/api/scripts/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [s.id], sku }) }); } catch (_) {}
    await loadSkus(); loadScripts();
  });
  // 🎙️ 生成配音：MiniMax TTS → 存入配音库（按脚本命名、按脚本 SKU 归类）
  const btnTts = item.querySelector('.tts');
  btnTts.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!ttsConfigured) { alert('未配置 MiniMax 凭证'); return; }
    const voiceId = ($('tts-voice') && $('tts-voice').value) || '';
    const orig = btnTts.textContent;
    btnTts.disabled = true; btnTts.textContent = '生成中…';
    try {
      const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scriptId: s.id, voiceId }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '生成失败');
      btnTts.textContent = `✓ ${d.durationSec}s 已存配音库`;
      setTimeout(() => { btnTts.textContent = orig; btnTts.disabled = false; }, 2600);
    } catch (err) { alert('生成配音失败：' + err.message); btnTts.textContent = orig; btnTts.disabled = false; }
  });
  let fullContent = null;
  let editing = false;
  const fetchFull = async () => {
    if (fullContent == null) { const d = await (await fetch('/api/scripts/' + s.id)).json(); fullContent = d.content || ''; ta.value = fullContent; }
    return fullContent;
  };
  const toggle = async () => { if (editing) return; if (full.hidden) { await fetchFull(); full.hidden = false; } else full.hidden = true; };
  titleEl.addEventListener('click', toggle);
  preview.addEventListener('click', toggle);
  btnCopy.addEventListener('click', async () => {
    await fetchFull();
    try { await navigator.clipboard.writeText(ta.value); flashBtn(btnCopy, '已复制'); }
    catch { full.hidden = false; ta.select(); }
  });
  btnDel.addEventListener('click', async () => {
    if (!confirm('确定删除这条脚本？')) return;
    try { await fetch('/api/scripts/' + s.id, { method: 'DELETE' }); } catch (_) {}
    await loadSkus();
    loadScripts();
  });
  // 就地编辑：标题就地可改 + 内容在展开文本框里改（不再有独立的空白框）
  const setEditing = (on) => {
    editing = on;
    titleEl.contentEditable = on ? 'true' : 'false';
    titleEl.classList.toggle('editing', on);
    ta.readOnly = !on;
    ta.classList.toggle('editing', on);
    preview.hidden = on;
    btnCopy.hidden = on; btnEdit.hidden = on; btnDel.hidden = on;
    btnSave.hidden = !on; btnCancel.hidden = !on;
  };
  btnEdit.addEventListener('click', async () => {
    titleEl.textContent = s.title;
    ta.value = '加载中…';
    full.hidden = false;
    setEditing(true);
    ta.value = await fetchFull();
    ta.focus();
  });
  btnCancel.addEventListener('click', () => {
    titleEl.textContent = s.title;
    setEditing(false);
    full.hidden = true;
  });
  btnSave.addEventListener('click', async () => {
    const title = titleEl.textContent.trim();
    const content = ta.value;
    if (!content.trim()) { alert('内容不能为空'); return; }
    try {
      const r = await fetch('/api/scripts/' + s.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content }) });
      if (!r.ok) throw new Error();
      await loadScripts();
    } catch { alert('保存失败'); }
  });
  return item;
}

// ----- 批量识别分段 -----
const escAttrS = (s) => esc(s).replace(/"/g, '&quot;');
let pendingSegments = null;

const NUM_HEADER = /^[ \t]*(?:第\s*[0-9一二三四五六七八九十百]+\s*[条段节]|脚本\s*[0-9]+|script\s*[0-9]+|[0-9]+\s*[.、．)）:：])/i;
const SEP_LINE = /\n[ \t]*[-=*_]{3,}[ \t]*(?=\n|$)/;

function splitByNumber(t) {
  const out = []; let cur = [];
  for (const ln of t.split('\n')) {
    if (NUM_HEADER.test(ln) && cur.some((x) => x.trim())) { out.push(cur.join('\n')); cur = [ln]; }
    else cur.push(ln);
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}
function deriveTitle(chunk) {
  let line = (chunk.split('\n').find((l) => l.trim()) || '').trim();
  line = line.replace(/^(?:第\s*[0-9一二三四五六七八九十百]+\s*[条段节][:：、.]?|脚本\s*[0-9]+[:：、.]?|script\s*[0-9]+[:：.]?|[0-9]+\s*[.、．)）:：])\s*/i, '');
  return line.slice(0, 24) || '未命名脚本';
}
function splitScripts(text, mode) {
  text = String(text || '').replace(/\r\n?/g, '\n');
  let chunks;
  if (mode === 'none') chunks = [text];
  else if (mode === 'sep') chunks = text.split(SEP_LINE);
  else if (mode === 'blank') chunks = text.split(/\n[ \t]*\n+/);
  else if (mode === 'number') chunks = splitByNumber(text);
  else { // auto：分隔线 > 编号 > 空行
    if (SEP_LINE.test(text)) chunks = text.split(SEP_LINE);
    else if (text.split('\n').filter((l) => NUM_HEADER.test(l)).length >= 2) chunks = splitByNumber(text);
    else chunks = text.split(/\n[ \t]*\n+/);
  }
  return chunks.map((c) => c.replace(/^\s+|\s+$/g, '')).filter(Boolean).map((c) => ({ title: deriveTitle(c), content: c }));
}

function renderPreview(segs) {
  pendingSegments = segs;
  const box = $('script-preview');
  if (!segs || !segs.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML =
    `<div class="pv-head"><span>识别到 <b>${segs.length}</b> 段脚本　标题可改、✕ 可删</span>` +
    `<button class="primary" id="pv-saveall">全部保存 ${segs.length} 段</button></div>` +
    segs.map((s, i) =>
      `<div class="pv-item" data-i="${i}"><div class="pv-title"><span class="pv-num">${i + 1}</span>` +
      `<input class="pv-t" value="${escAttrS(s.title)}"/><span class="pv-rm" title="移除">✕</span></div>` +
      `<div class="pv-text">${esc(s.content.slice(0, 140))}${s.content.length > 140 ? '…' : ''}</div></div>`).join('');
  box.querySelectorAll('.pv-item').forEach((it) => {
    const i = +it.dataset.i;
    it.querySelector('.pv-t').addEventListener('input', (e) => { if (pendingSegments[i]) pendingSegments[i].title = e.target.value; });
    it.querySelector('.pv-rm').addEventListener('click', () => { pendingSegments[i] = null; it.remove(); refreshPvCount(); });
  });
  $('pv-saveall').addEventListener('click', saveAllSegments);
}
function refreshPvCount() {
  const n = (pendingSegments || []).filter(Boolean).length;
  const btn = $('pv-saveall');
  if (btn) btn.textContent = `全部保存 ${n} 段`;
}

async function saveAllSegments() {
  const segs = (pendingSegments || []).filter(Boolean).filter((s) => s.content.trim());
  if (!segs.length) { alert('没有可保存的段落'); return; }
  const sku = ($('script-sku') && $('script-sku').value) || 'K5-3 PRO';
  try {
    const r = await fetch('/api/scripts/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scripts: segs, sku }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '保存失败');
    clearScriptInput();
    await loadSkus();
    loadScripts();
    flashBtn($('script-save'), `已存 ${d.count} 段 → ${sku}`);
  } catch (e) { alert(e.message); }
}
function clearScriptInput() {
  $('script-content').value = ''; $('script-title').value = '';
  $('script-preview').hidden = true; $('script-preview').innerHTML = '';
  pendingSegments = null;
}
function detectNow() {
  const text = $('script-content').value;
  if (!text.trim()) { alert('请先粘贴脚本内容'); return null; }
  const segs = splitScripts(text, $('script-mode').value);
  if (segs.length === 1 && $('script-title').value.trim()) segs[0].title = $('script-title').value.trim();
  return segs;
}

$('script-detect').addEventListener('click', () => { const s = detectNow(); if (s) renderPreview(s); });
$('script-save').addEventListener('click', () => {
  // 已有预览就存预览；否则即时识别再存
  let segs = (pendingSegments || []).filter(Boolean);
  if (!segs.length) { segs = detectNow(); if (!segs) return; pendingSegments = segs; }
  saveAllSegments();
});
$('script-mode').addEventListener('change', () => { if (!$('script-preview').hidden) { const s = detectNow(); if (s) renderPreview(s); } });

$('script-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { $('script-content').value = String(reader.result || ''); const s = detectNow(); if (s) renderPreview(s); };
  reader.readAsText(f, 'utf-8');
  e.target.value = '';
});

// 一键生成：结合脚本库 + 投放数据，融合生成草稿（填入上方编辑框，供润色后保存）
$('script-gen').addEventListener('click', async () => {
  const btn = $('script-gen');
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '生成中…';
  try {
    const start = ($('tt-start') && $('tt-start').value) || '';
    const end = ($('tt-end') && $('tt-end').value) || '';
    const r = await fetch(`/api/scripts/generate?start=${start}&end=${end}`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '生成失败');
    $('script-title').value = d.draft.title;
    $('script-content').value = d.draft.content;
    $('script-mode').value = 'none'; // 草稿整体存为 1 段
    pendingSegments = null;
    const box = $('script-preview');
    box.hidden = false;
    const how = d.ai ? `🤖 AI 生成（${d.model || '大模型'}）` : '🪄 离线拼装';
    box.innerHTML =
      `<div class="pv-head"><span>${how}：已根据 <b>${d.matchedCount}/${d.totalScripts}</b> 条脚本的投放数据生成草稿，请在上方润色后点「保存」入库。</span></div>` +
      `<div class="gen-rank"><table><thead><tr><th>参考脚本</th><th>花费$</th><th>CTR</th><th>转化</th><th>GMV$</th><th>ROAS</th></tr></thead><tbody>` +
      d.ranking.map((s) => `<tr><td title="${escAttrS(s.title)}">${esc(s.title)}</td><td>${s.spend}</td><td>${s.ctr}%</td><td>${s.conversion}</td><td>${s.gmv}</td><td>${s.roas}</td></tr>`).join('') +
      `</tbody></table></div>`;
    $('script-content').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) { alert(e.message); }
  finally { btn.disabled = false; btn.textContent = orig; }
});

// MiniMax 配音音色加载（按语言分组，英文优先）
let ttsConfigured = false;
const VLANG_LABEL = { English: '英文', Chinese: '中文', Spanish: '西班牙语', Portuguese: '葡萄牙语', Korean: '韩语', Japanese: '日语', French: '法语', German: '德语', Italian: '意大利语', Russian: '俄语', Cantonese: '粤语', Indonesian: '印尼语', Arabic: '阿拉伯语', Turkish: '土耳其语', Ukrainian: '乌克兰语', Dutch: '荷兰语', Vietnamese: '越南语', Thai: '泰语', 其他: '其他' };
const VLANG_ORDER = ['English', 'Chinese', 'Spanish', 'Portuguese', 'Korean', 'Japanese', 'French', 'German', 'Italian', 'Russian', 'Cantonese', 'Indonesian', 'Arabic', 'Turkish', 'Ukrainian', 'Dutch', 'Vietnamese', 'Thai', '其他'];
function voiceLang(id) {
  const langs = ['English', 'Portuguese', 'Korean', 'Spanish', 'Chinese', 'Japanese', 'Indonesian', 'Russian', 'Cantonese', 'French', 'Italian', 'German', 'Dutch', 'Arabic', 'Turkish', 'Ukrainian', 'Vietnamese', 'Thai'];
  for (const L of langs) if (new RegExp('^' + L, 'i').test(id)) return L;
  if (/^(male|female|presenter|audiobook|clever|charming|junlang|lovely|cute|badao|qn)/i.test(id)) return 'Chinese';
  return '其他';
}
let ttsData = null;
function fillVoiceSelect(sel, voices, defaultVoice) {
  if (!sel) return;
  if (!voices || !voices.length) { sel.innerHTML = '<option value="">（未获取到音色）</option>'; return; }
  const groups = {};
  for (const v of voices) { const L = voiceLang(v.id); (groups[L] = groups[L] || []).push(v); }
  const order = VLANG_ORDER.filter((l) => groups[l]).concat(Object.keys(groups).filter((l) => !VLANG_ORDER.includes(l)));
  sel.innerHTML = order.map((L) =>
    `<optgroup label="${esc(VLANG_LABEL[L] || L)}（${groups[L].length}）">` +
    groups[L].map((v) => `<option value="${escAttrS(v.id)}"${v.id === defaultVoice ? ' selected' : ''}>${esc(v.name)}</option>`).join('') +
    '</optgroup>').join('');
}
async function loadTtsStatus() {
  try {
    ttsData = await (await fetch('/api/tts/status')).json();
    ttsConfigured = !!ttsData.configured;
    fillVoiceSelect($('tts-voice'), ttsData.voices, ttsData.defaultVoice);
    setupVoiceStudio();
  } catch (_) { ttsConfigured = false; }
}
loadTtsStatus();

// ---------- 配音工坊（独立配音设置面板）----------
let vsInited = false;
async function setupVoiceStudio() {
  if (vsInited || !ttsData || !$('vs-voice')) return;
  vsInited = true;
  fillVoiceSelect($('vs-voice'), ttsData.voices, ttsData.defaultVoice);
  $('vs-model').innerHTML = (ttsData.models || []).map((m) => `<option value="${escAttrS(m.id)}">${esc(m.label)}</option>`).join('');
  $('vs-emotion').innerHTML = (ttsData.emotions || []).map((e) => `<option value="${escAttrS(e.id)}">${esc(e.label)}</option>`).join('');
  $('vs-lang').innerHTML = (ttsData.langs || []).map((l) => `<option value="${escAttrS(l.id)}"${l.id === 'English' ? ' selected' : ''}>${esc(l.label)}</option>`).join('');
  try { const skus = await (await fetch('/api/scripts/skus')).json(); $('vs-sku').innerHTML = skus.map((s) => `<option value="${escAttrS(s.name)}">${esc(s.name)}（${s.count}）</option>`).join(''); } catch (_) {}
  try { const scr = await (await fetch('/api/scripts?sku=__all__')).json(); $('vs-loadscript').innerHTML = '<option value="">从脚本库选一条…</option>' + scr.map((s) => `<option value="${s.id}" data-sku="${escAttrS(s.sku || '')}" data-title="${escAttrS(s.title || '')}">${esc(s.title)}</option>`).join(''); } catch (_) {}

  const ta = $('vs-text');
  ta.addEventListener('input', () => { $('vs-count').textContent = ta.value.length; });
  const bindRange = (id, lab, fmt) => { const r = $(id), b = $(lab); r.addEventListener('input', () => { b.textContent = fmt ? fmt(r.value) : r.value; }); };
  bindRange('vs-speed', 'vs-speed-v', (v) => (+v).toFixed(1));
  bindRange('vs-vol', 'vs-vol-v', (v) => (+v).toFixed(1));
  bindRange('vs-pitch', 'vs-pitch-v');

  // 载入脚本：填正文 + 命名 + SKU
  $('vs-loadscript').addEventListener('change', async (e) => {
    const opt = e.target.selectedOptions[0]; const id = e.target.value;
    if (!id) return;
    try { const d = await (await fetch('/api/scripts/' + id)).json(); ta.value = d.content || ''; $('vs-count').textContent = ta.value.length; } catch (_) {}
    $('vs-name').value = opt.dataset.title || '';
    const sku = opt.dataset.sku || '';
    if (sku && [...$('vs-sku').options].some((o) => o.value === sku)) $('vs-sku').value = sku;
  });

  const collect = () => ({ voiceId: $('vs-voice').value, model: $('vs-model').value, speed: +$('vs-speed').value, vol: +$('vs-vol').value, pitch: +$('vs-pitch').value, emotion: $('vs-emotion').value, languageBoost: $('vs-lang').value });

  // 试听
  let vsAudio = null;
  $('vs-preview').addEventListener('click', async () => {
    const btn = $('vs-preview'), o = collect();
    if (!o.voiceId) { alert('请选择音色'); return; }
    if (vsAudio && !vsAudio.paused) { vsAudio.pause(); vsAudio = null; btn.textContent = '🔊 试听'; return; }
    btn.disabled = true; btn.textContent = '合成中…';
    try {
      const r = await fetch('/api/tts/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || '试听失败'); }
      const url = URL.createObjectURL(await r.blob()); vsAudio = new Audio(url); btn.disabled = false; btn.textContent = '⏸ 停止';
      vsAudio.onended = () => { btn.textContent = '🔊 试听'; URL.revokeObjectURL(url); vsAudio = null; };
      vsAudio.play().catch(() => { btn.textContent = '🔊 试听'; });
    } catch (e) { alert('试听失败：' + e.message); btn.textContent = '🔊 试听'; } finally { btn.disabled = false; }
  });

  // 生成配音
  $('vs-generate').addEventListener('click', async () => {
    const btn = $('vs-generate'), o = collect();
    const text = ta.value.trim();
    if (!text) { alert('请输入要转配音的文案'); return; }
    if (!o.voiceId) { alert('请选择音色'); return; }
    const name = ($('vs-name').value || '').trim(), sku = $('vs-sku').value || '';
    const orig = btn.textContent; btn.disabled = true; btn.textContent = '生成中…';
    try {
      const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...o, text, name, sku }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || '生成失败');
      const box = $('vs-result'); box.hidden = false;
      box.innerHTML = `<div class="vs-res-head">✅ 已生成 ${d.durationSec}s，存入配音库「${esc(d.folder)}」：<b>${esc(d.name)}</b></div>` +
        `<audio controls autoplay src="/api/audiolib/voice/file/${encodeURIComponent(d.folder)}/${d.id}"></audio>`;
      btn.textContent = '✓ 已生成并入库'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2200);
    } catch (e) { alert('生成配音失败：' + e.message); btn.textContent = orig; btn.disabled = false; }
  });
}

// 试听：用选中音色念一句样例
let _previewAudio = null;
if ($('tts-preview')) $('tts-preview').addEventListener('click', async () => {
  const btn = $('tts-preview');
  const voiceId = ($('tts-voice') && $('tts-voice').value) || '';
  if (!voiceId) { alert('请先选择音色'); return; }
  // 正在播则停止
  if (_previewAudio && !_previewAudio.paused) { _previewAudio.pause(); _previewAudio = null; btn.textContent = '🔊 试听'; return; }
  const orig = '🔊 试听';
  btn.disabled = true; btn.textContent = '合成中…';
  try {
    const r = await fetch('/api/tts/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voiceId }) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || '试听失败'); }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    _previewAudio = new Audio(url);
    btn.disabled = false; btn.textContent = '⏸ 停止';
    _previewAudio.onended = () => { btn.textContent = orig; URL.revokeObjectURL(url); _previewAudio = null; };
    _previewAudio.play().catch(() => { btn.textContent = orig; });
  } catch (err) { alert('试听失败：' + err.message); btn.textContent = orig; }
  finally { btn.disabled = false; }
});

loadSkus().then(loadScripts);

// ---------- TikTok 投放数据 ----------
let ttData = null; // 最近一次拉取的完整数据（用于本地搜索过滤）

async function loadTiktokStatus() {
  let st;
  try { st = await (await fetch('/api/tiktok/status')).json(); } catch { return; }
  if (!st.configured) { $('tt-unconfig').hidden = false; return; }
  $('tt-main').hidden = false;
  const a = (st.advertisers || [])[0];
  $('tt-acct').textContent = a
    ? `账户：${a.name}　余额：${a.currency} ${a.balance}　（数据来自 TikTok Marketing API）`
    : (st.error ? '读取账户失败：' + st.error : '');
  if (st.defaultStart) $('tt-start').value = st.defaultStart;
  if (st.defaultEnd) $('tt-end').value = st.defaultEnd;
}

async function fetchTiktokVideos() {
  const start = $('tt-start').value;
  const end = $('tt-end').value;
  const tbody = $('tt-tbody');
  $('tt-summary').innerHTML = '';
  tbody.innerHTML = `<tr><td colspan="11" class="tt-loading">正在从 TikTok 拉取数据，请稍候（按视频聚合，可能需要十几秒）…</td></tr>`;
  $('tt-refresh').disabled = true;
  try {
    const r = await fetch(`/api/tiktok/videos?start=${start}&end=${end}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '拉取失败');
    ttData = d;
    renderTiktok();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="11" class="tt-loading">⚠ ${e.message}</td></tr>`;
  } finally {
    $('tt-refresh').disabled = false;
  }
}

function renderTiktok() {
  if (!ttData) return;
  const t = ttData.totals || {};
  $('tt-summary').innerHTML =
    `<span class="kv">区间 <b>${ttData.start} ~ ${ttData.end}</b></span>` +
    `<span class="kv">总花费 <b>$${t.spend}</b></span>` +
    `<span class="kv">总GMV <b>$${t.gmv}</b></span>` +
    `<span class="kv">整体ROAS <b>${t.roas}</b></span>` +
    `<span class="kv">转化视频数 <b>${t.videos}</b></span>` +
    (t.excludedVideos ? `<span class="kv">已排除品牌/播放量 <b>${t.excludedVideos}</b></span>` : '');
  const q = $('tt-search').value.trim().toLowerCase();
  const rows = (ttData.videos || []).filter((v) =>
    !q || (v.name || '').toLowerCase().includes(q) || (v.video_id || '').toLowerCase().includes(q));
  const tbody = $('tt-tbody');
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="11" class="tt-loading">无数据</td></tr>`; return; }
  tbody.innerHTML = rows.map((v) => {
    const roasCls = v.gmv > 0 ? (v.roas >= 1 ? 'tt-roas-good' : 'tt-roas-bad') : '';
    return `<tr>
      <td title="${escAttr(v.name)}">${esc(v.name)}<div class="vid">${v.video_id || '—'}</div></td>
      <td>${v.spend}</td><td>${v.impressions}</td><td>${v.clicks}</td><td>${v.ctr}%</td>
      <td>${v.view2s_rate != null ? v.view2s_rate + '%' : '—'}</td>
      <td>${v.conversion}</td><td>${v.cpa || '—'}</td><td>${v.gmv}</td>
      <td class="${roasCls}">${v.roas || '—'}</td><td>${v.ad_count}</td>
    </tr>`;
  }).join('');
}

const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
$('tt-refresh').addEventListener('click', fetchTiktokVideos);
$('tt-search').addEventListener('input', renderTiktok);
loadTiktokStatus();

// ---------- 滑块标签联动 ----------
$('opt-vvol').addEventListener('input', (e) => ($('lbl-vvol').textContent = e.target.value + '%'));
$('opt-bvol').addEventListener('input', (e) => ($('lbl-bvol').textContent = e.target.value + '%'));
$('opt-audio').addEventListener('change', (e) => {
  // 切到“闪避”时音乐基准默认高一些
  const bvol = $('opt-bvol');
  bvol.value = e.target.value === 'duck' ? 80 : 22;
  $('lbl-bvol').textContent = bvol.value + '%';
});

// ---------- 开始混剪 ----------
$('btn-start').addEventListener('click', start);

async function start() {
  hideError();
  const basis = $('opt-basis').value;
  const hasVoice = !!files.voice || !!files.voiceLibRef;
  const hasBgm = !!files.bgm || !!files.bgmLibRef;
  if (basis === 'voice' && !hasVoice) return showError('成片时长选了“以人声配音为准”，但没有配音。请上传或从素材库选择配音，或改用其他时长基准。');
  if (basis === 'bgm' && !hasBgm) return showError('成片时长选了“以背景音乐为准”，但没有背景音乐。请上传或从素材库选择。');
  if ($('opt-subs').checked && !hasVoice) return showError('勾选了“自动字幕”，但没有人声配音。请上传或从素材库选择配音，或取消勾选自动字幕。');

  $('btn-start').disabled = true;
  $('result-card').hidden = true;
  showProgress(0, '正在上传素材…');

  try {
    const jobId = await uploadAll();
    showProgress(0, '上传完成，开始混剪…');
    const options = collectOptions();
    const r = await fetch('/api/mix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, options }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '启动混剪失败');
    listenProgress(jobId);
  } catch (err) {
    showError(err.message || String(err));
    $('btn-start').disabled = false;
  }
}

function collectOptions() {
  return {
    canvas: $('opt-canvas').value,
    fps: Number($('opt-fps').value),
    durationBasis: $('opt-basis').value,
    order: $('opt-order').value,
    clipSeconds: Number($('opt-clipsec').value) || 0,
    audioMode: $('opt-audio').value,
    voiceVolume: Number($('opt-vvol').value) / 100,
    bgmVolume: Number($('opt-bvol').value) / 100,
    subtitles: $('opt-subs').checked,
    count: Math.max(1, Math.min(30, Number($('opt-count').value) || 1)),
    sku: $('opt-sku').value.trim(),
    batch: $('opt-batch').value.trim(),
  };
}

// ---------- 混剪设置模版（按产品 SKU 分类）----------
let allTemplates = [];

async function loadTemplates() {
  try { allTemplates = await (await fetch('/api/templates')).json(); } catch (_) { allTemplates = []; }
  const sel = $('tpl-select');
  if (!sel) return;
  const prev = sel.value;
  let html = '<option value="">选择模版套用…</option>';
  // 按 SKU 分组
  const groups = {};
  for (const t of allTemplates) { (groups[t.sku || '未分类'] = groups[t.sku || '未分类'] || []).push(t); }
  for (const sku of Object.keys(groups).sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
    html += `<optgroup label="${escAttrS(sku)}">`;
    for (const t of groups[sku]) html += `<option value="${t.id}">${esc(t.name)}</option>`;
    html += '</optgroup>';
  }
  sel.innerHTML = html;
  if (prev && allTemplates.some((t) => t.id === prev)) sel.value = prev;
}

function applyOptions(o) {
  if (!o) return;
  const setVal = (id, v) => { const el = $(id); if (el != null && v != null) el.value = v; };
  setVal('opt-canvas', o.canvas);
  setVal('opt-fps', o.fps);
  setVal('opt-basis', o.durationBasis);
  setVal('opt-order', o.order);
  setVal('opt-count', o.count);
  setVal('opt-clipsec', o.clipSeconds);
  setVal('opt-audio', o.audioMode);
  setVal('opt-sku', o.sku || '');
  setVal('opt-batch', o.batch || '');
  if (o.voiceVolume != null) { $('opt-vvol').value = Math.round(o.voiceVolume * 100); $('opt-vvol').dispatchEvent(new Event('input')); }
  if (o.bgmVolume != null) { $('opt-bvol').value = Math.round(o.bgmVolume * 100); $('opt-bvol').dispatchEvent(new Event('input')); }
  if (typeof o.subtitles === 'boolean') $('opt-subs').checked = o.subtitles;
}

// 直接保存当前设置为模版（收进模版库）。SKU 取「归类SKU」框 → 退回「产品SKU」→ 默认 K5-3 PRO，不拦截
async function saveTemplateNow() {
  const options = collectOptions();
  const sku = (($('tpl-save-sku').value || '').trim()) || ((options.sku || '').trim()) || 'K5-3 PRO';
  options.sku = sku; // 同步进设置，套用时会回填到「产品 SKU」
  const auto = `${sku}-${options.canvas}-${options.fps}fps${options.subtitles ? '-字幕' : ''}`;
  const name = ($('tpl-name').value || '').trim() || auto;
  const btn = $('tpl-save-btn');
  try {
    const r = await fetch('/api/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, sku, options }) });
    if (!r.ok) throw new Error();
    $('tpl-name').value = '';
    await loadTemplates();
    $('tpl-select').value = ''; // 顶部下拉刷新后保持在“选择模版套用…”
    flashBtn(btn, `✓ 已存入「${sku}」`);
  } catch (_) { alert('保存模版失败'); }
}
if ($('tpl-save-btn')) $('tpl-save-btn').addEventListener('click', saveTemplateNow);
if ($('tpl-name')) $('tpl-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveTemplateNow(); } });
// 「归类SKU」默认跟随「产品SKU」：产品SKU 有值且归类框为空时自动带过去
if ($('opt-sku')) $('opt-sku').addEventListener('input', () => { const t = $('tpl-save-sku'); if (t && !t.value.trim()) t.value = $('opt-sku').value.trim(); });
if ($('tpl-apply')) $('tpl-apply').addEventListener('click', () => {
  const id = $('tpl-select').value; if (!id) return;
  const t = allTemplates.find((x) => x.id === id); if (t) { applyOptions(t.options); flashBtn($('tpl-apply'), '已套用 ✓'); }
});
if ($('tpl-del')) $('tpl-del').addEventListener('click', async () => {
  const id = $('tpl-select').value; if (!id) return;
  const t = allTemplates.find((x) => x.id === id);
  if (!confirm(`删除模版「${t ? t.name : id}」？`)) return;
  try { await fetch('/api/templates/' + id, { method: 'DELETE' }); } catch (_) {}
  await loadTemplates();
});
loadTemplates();

// 上传（带进度）
function uploadAll() {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    files.videos.forEach((f) => fd.append('videos', f, f.name));
    // 从视频素材库勾选的素材（服务端按 folder+id 复制进任务目录）
    if (files.materialRefs.length) fd.append('materials', JSON.stringify(files.materialRefs));
    // 背景音乐 / 配音：要么传新文件（自动入库），要么引用音频库选中的 {folder,id}
    for (const type of ['bgm', 'voice']) {
      if (files[type]) {
        fd.append(type, files[type], files[type].name);
      } else if (files[type + 'LibRef']) {
        fd.append(`${type}LibRef`, JSON.stringify(files[type + 'LibRef']));
      }
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        showProgress(0, `正在上传素材… ${pct}%（${humanSize(e.loaded)} / ${humanSize(e.total)}）`);
      }
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data.jobId);
        else reject(new Error(data.error || '上传失败'));
      } catch { reject(new Error('上传响应解析失败')); }
    };
    xhr.onerror = () => reject(new Error('上传网络错误'));
    xhr.send(fd);
  });
}

// 监听混剪进度（SSE）
function listenProgress(jobId) {
  const es = new EventSource(`/api/progress/${jobId}`);
  es.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.error) {
      es.close();
      showError(d.error);
      $('btn-start').disabled = false;
      return;
    }
    showProgress(d.percent || 0, d.message || stageName(d.stage));
    if (d.ready || d.status === 'done') {
      es.close();
      onDone(jobId, d.count || 1);
    }
  };
  es.onerror = () => { /* 浏览器会自动重连；完成后我们已主动 close */ };
}

function stageName(s) {
  return ({ queued: '排队中…', probe: '分析素材…', normalize: '预处理片段…', montage: '拼接片段…', subtitle: '生成字幕…', mux: '合成音轨…', done: '完成' }[s]) || '处理中…';
}

// ---------- 上传到 TikTok 广告户（支持多选） ----------
let ttAccountsCache = null;
async function ttGetAccounts() {
  if (ttAccountsCache) return ttAccountsCache;
  try { ttAccountsCache = await (await fetch('/api/tiktok/accounts')).json(); } catch { ttAccountsCache = []; }
  if (!Array.isArray(ttAccountsCache)) ttAccountsCache = [];
  return ttAccountsCache;
}
function uploadControlHTML(jobId, n) {
  return `<div class="upload-ctl" data-job="${jobId}" data-idx="${n}">` +
    `<div class="acct-picker">` +
    `<button type="button" class="ap-toggle">选择广告户 <span class="ap-count">0</span> ▾</button>` +
    `<div class="ap-menu" hidden>` +
    `<input type="text" class="ap-search" placeholder="搜索账户…" />` +
    `<div class="ap-tools"><a class="ap-all">全选</a><a class="ap-none">清空</a></div>` +
    `<div class="ap-list"></div></div></div>` +
    `<button type="button" class="tt-up-btn">⬆ 上传</button>` +
    `<span class="tt-up-status"></span></div>`;
}
async function fillAccountSelects(root) {
  const accs = await ttGetAccounts();
  (root || document).querySelectorAll('.ap-list').forEach((list) => {
    if (list.dataset.filled) return;
    list.dataset.filled = '1';
    list.innerHTML = accs.map((a) =>
      `<label class="ap-opt"><input type="checkbox" value="${a.id}"><span>${esc(a.name)}</span></label>`).join('');
  });
}
function apUpdateCount(ctl) {
  const n = ctl.querySelectorAll('.ap-list input:checked').length;
  ctl.querySelector('.ap-count').textContent = n;
}
document.addEventListener('click', async (e) => {
  // 展开/收起账户菜单
  const toggle = e.target.closest('.ap-toggle');
  if (toggle) {
    const menu = toggle.parentElement.querySelector('.ap-menu');
    document.querySelectorAll('.ap-menu').forEach((m) => { if (m !== menu) m.hidden = true; });
    menu.hidden = !menu.hidden;
    return;
  }
  // 全选 / 清空
  const all = e.target.closest('.ap-all'), none = e.target.closest('.ap-none');
  if (all || none) {
    const ctl = (all || none).closest('.acct-picker');
    ctl.querySelectorAll('.ap-list input').forEach((cb) => {
      if (cb.closest('.ap-opt').style.display !== 'none') cb.checked = !!all;
    });
    apUpdateCount(ctl);
    return;
  }
  // 点菜单外关闭
  if (!e.target.closest('.acct-picker')) document.querySelectorAll('.ap-menu').forEach((m) => (m.hidden = true));

  // 上传按钮
  const btn = e.target.closest('.tt-up-btn');
  if (!btn) return;
  const ctl = btn.closest('.upload-ctl');
  const status = ctl.querySelector('.tt-up-status');
  const ids = [...ctl.querySelectorAll('.ap-list input:checked')].map((c) => c.value);
  if (!ids.length) { status.textContent = '请先勾选广告户'; status.className = 'tt-up-status err'; return; }
  btn.disabled = true; status.textContent = `上传到 ${ids.length} 个账户中…`; status.className = 'tt-up-status';
  try {
    const r = await fetch('/api/tiktok/upload-video-multi', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: ctl.dataset.job, index: Number(ctl.dataset.idx), advertiserIds: ids }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '上传失败');
    const okN = d.results.filter((x) => x.ok).length;
    const fails = d.results.filter((x) => !x.ok);
    status.innerHTML = `✓ 成功 ${okN}/${d.results.length}` +
      (fails.length ? `，失败：${fails.map((f) => f.advertiserId + '(' + esc(f.error) + ')').join('；')}` : '');
    status.className = 'tt-up-status ' + (fails.length ? 'err' : 'ok');
  } catch (err) { status.textContent = '✗ ' + err.message; status.className = 'tt-up-status err'; }
  finally { btn.disabled = false; }
});
// 搜索过滤账户
document.addEventListener('input', (e) => {
  const s = e.target.closest('.ap-search');
  if (!s) return;
  const q = s.value.trim().toLowerCase();
  s.closest('.ap-menu').querySelectorAll('.ap-opt').forEach((o) => {
    o.style.display = o.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});
// 勾选变化更新计数（账户多选器，兼容单条上传控件和批量栏）
document.addEventListener('change', (e) => {
  if (e.target.matches('.ap-list input')) apUpdateCount(e.target.closest('.acct-picker'));
});

let lastResultJob = null, lastResultCount = 0;
function onDone(jobId, count) {
  showProgress(100, count > 1 ? `全部 ${count} 条混剪完成！` : '混剪完成！');
  if (window.reloadHistory) try { window.reloadHistory(); } catch (_) {}
  lastResultJob = jobId; lastResultCount = count;
  const grid = $('results-grid');
  grid.innerHTML = '';
  const t = Date.now();
  for (let i = 1; i <= count; i++) {
    const item = document.createElement('div');
    item.className = 'result-item';
    item.innerHTML =
      `<input type="checkbox" class="res-check" data-job="${jobId}" data-idx="${i}" checked />` +
      (count > 1 ? `<p class="rtitle">第 ${i} 条</p>` : '') +
      `<video controls preload="metadata" src="/api/result/${jobId}/${i}?t=${t}"></video>` +
      `<a class="dl" download href="/api/download/${jobId}/${i}">⬇ 下载${count > 1 ? `第 ${i} 条` : '成片'}</a>`;
    grid.appendChild(item);
  }
  fillAccountSelects($('batch-acct'));
  updateResSel();
  // 字幕文件若存在则显示下载入口（所有版本共用同一字幕）
  const srt = $('btn-srt');
  fetch(`/api/subtitle/${jobId}`, { method: 'HEAD' })
    .then((r) => {
      if (r.ok) { srt.href = `/api/subtitle/${jobId}`; srt.hidden = false; }
      else srt.hidden = true;
    })
    .catch(() => { srt.hidden = true; });
  $('result-card').hidden = false;
  $('btn-start').disabled = false;
  $('result-card').scrollIntoView({ behavior: 'smooth' });
}

// ---- 批量选择成片：下载 / 上传 / 上传并建广告 ----
function selectedResults() {
  return [...document.querySelectorAll('.res-check:checked')].map((c) => ({ jobId: c.dataset.job, index: Number(c.dataset.idx) }));
}
function updateResSel() {
  const n = selectedResults().length;
  $('res-selinfo').textContent = `已选 ${n} 条`;
  const all = document.querySelectorAll('.res-check').length;
  const sa = $('res-selall'); if (sa) sa.checked = all > 0 && n === all;
}
function batchAccountIds() {
  return [...document.querySelectorAll('#batch-acct .ap-list input:checked')].map((c) => c.value);
}
function setBatchStatus(text, cls) { const s = $('batch-status'); s.textContent = text; s.className = 'batch-status ' + (cls || ''); }

document.addEventListener('change', (e) => {
  if (e.target.classList.contains('res-check')) updateResSel();
});
function setupBatch() {
  $('res-selall').addEventListener('change', (e) => {
    document.querySelectorAll('.res-check').forEach((c) => { c.checked = e.target.checked; });
    updateResSel();
  });
  $('batch-download').addEventListener('click', async () => {
    const sel = selectedResults();
    if (!sel.length) return setBatchStatus('请先勾选成片', 'err');
    setBatchStatus(`开始下载 ${sel.length} 条…`, 'run');
    for (const s of sel) {
      const a = document.createElement('a');
      a.href = `/api/download/${s.jobId}/${s.index}`; a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
      await new Promise((r) => setTimeout(r, 600)); // 间隔，避免浏览器拦截
    }
    setBatchStatus(`✓ 已触发 ${sel.length} 条下载（浏览器若提示“下载多个文件”，点允许）`, 'ok');
  });
  $('batch-upload').addEventListener('click', async () => {
    const sel = selectedResults();
    const ids = batchAccountIds();
    if (!sel.length) return setBatchStatus('请先勾选成片', 'err');
    if (!ids.length) return setBatchStatus('请先在「选择广告户」里勾选账户', 'err');
    setBatchStatus(`上传 ${sel.length} 条到 ${ids.length} 个广告户中…`, 'run');
    try {
      const d = await (await fetch('/api/tiktok/upload-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: sel, advertiserIds: ids }) })).json();
      if (!d.ok) throw new Error(d.error || '上传失败');
      const okN = d.out.filter((o) => o.ok && o.results.every((r) => r.ok)).length;
      const fails = d.out.flatMap((o) => (o.results || []).filter((r) => !r.ok).map((r) => `${o.name}@${r.advertiserId}:${r.error}`)).concat(d.out.filter((o) => !o.ok).map((o) => `${o.name}:${o.error}`));
      setBatchStatus(`✓ ${sel.length} 条 × ${ids.length} 户 上传完成` + (fails.length ? `\n失败：\n` + fails.join('\n') : ''), fails.length ? 'err' : 'ok');
    } catch (err) { setBatchStatus('✗ ' + err.message, 'err'); }
  });
  $('batch-adize').addEventListener('click', async () => {
    const sel = selectedResults();
    const ids = batchAccountIds();
    if (!sel.length) return setBatchStatus('请先勾选成片', 'err');
    if (ids.length !== 1) return setBatchStatus('「上传并建广告」请只勾选 1 个广告户（广告按账户建）', 'err');
    if (!confirm(`将 ${sel.length} 条成片上传到该广告户，并加入建广告队列（广告由 Claude 复核后以「暂停态」创建）。继续？`)) return;
    setBatchStatus(`上传 ${sel.length} 条并入队建广告中…`, 'run');
    try {
      const d = await (await fetch('/api/tiktok/queue-ads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: sel, advertiserId: ids[0] }) })).json();
      if (!d.ok) throw new Error(d.error || '失败');
      setBatchStatus(`✓ 已上传 ${d.count} 条到广告户 ${d.advertiserId} 并加入「待建广告队列」。\n现在让 Claude 执行建广告即可（会先 dry-run 复核，创建为暂停态）。`, 'ok');
    } catch (err) { setBatchStatus('✗ ' + err.message, 'err'); }
  });
}
setupBatch();

// ---------- 进度/错误 UI ----------
function showProgress(pct, text) {
  $('progress-wrap').hidden = false;
  $('progress-fill').style.width = pct + '%';
  $('progress-text').textContent = text;
}
function showError(msg) {
  const b = $('error-box');
  b.hidden = false;
  b.textContent = '⚠ ' + msg;
}
function hideError() { $('error-box').hidden = true; }

// ---------- 视频素材库 ----------
function setupMaterials() {
  const $m = (id) => document.getElementById(id);
  const modal = $m('materials-modal');
  const grid = $m('mat-grid');
  const escM = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let curFolder = '__all__';
  let folders = [];
  let currentList = [];
  let matPage = 0;
  let dragItems = null;
  const selected = new Map();
  const key = (folder, id) => folder + '/' + id;
  const updCount = () => { $m('mat-selcount').textContent = `已选 ${selected.size} 个`; };
  const pageSize = () => parseInt($m('mat-pagesize').value, 10) || 50;

  // ---- 左侧文件夹栏（可点击切换、可作为拖放目标、可删除）----
  async function loadFolders() {
    try { folders = await (await fetch('/api/materials/folders')).json(); } catch (_) { folders = []; }
    renderSidebar();
  }
  function renderSidebar() {
    const box = $m('mat-folders');
    box.innerHTML = '';
    const items = [{ name: '__all__', label: '全部素材', icon: '📂', count: folders.reduce((a, f) => a + f.count, 0), drop: false }]
      .concat(folders.map((f) => ({ name: f.name, label: f.name, icon: '📁', count: f.count, drop: true })));
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'mat-folder-item' + (curFolder === it.name ? ' active' : '');
      const canEdit = it.drop && it.name !== '默认';
      el.innerHTML = `<span class="fi-icon">${it.icon}</span><span class="fi-name">${escM(it.label)}</span>` +
        `<span class="fi-count">${it.count}</span>` +
        (canEdit ? `<span class="fi-edit" title="重命名">✎</span><span class="fi-del" title="删除文件夹">✕</span>` : '');
      el.addEventListener('click', (e) => {
        if (e.target.closest('.fi-del') || e.target.closest('.fi-edit')) return;
        curFolder = it.name; matPage = 0; $m('mat-search').value = '';
        renderSidebar(); loadGrid();
      });
      const edit = el.querySelector('.fi-edit');
      if (edit) edit.addEventListener('click', async (e) => {
        e.stopPropagation();
        const nn = prompt('重命名文件夹：', it.name);
        if (!nn || !nn.trim() || nn.trim() === it.name) return;
        try {
          const d = await (await fetch('/api/materials/folder/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldName: it.name, newName: nn.trim() }) })).json();
          if (!d.ok) { alert(d.error || '改名失败'); return; }
          if (curFolder === it.name) curFolder = d.name;
        } catch (_) {}
        await loadFolders(); loadGrid();
      });
      const del = el.querySelector('.fi-del');
      if (del) del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`删除文件夹「${it.name}」及其中所有素材？`)) return;
        try { await fetch('/api/materials/folder/' + encodeURIComponent(it.name), { method: 'DELETE' }); } catch (_) {}
        if (curFolder === it.name) curFolder = '__all__';
        await loadFolders(); loadGrid();
      });
      if (it.drop) {
        el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
        el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
        el.addEventListener('drop', async (e) => {
          e.preventDefault(); el.classList.remove('drag-over');
          const moveList = (dragItems || []).filter((x) => x.folder !== it.name);
          dragItems = null;
          if (!moveList.length) return;
          $m('mat-status').textContent = '移动中…';
          try { await fetch('/api/materials/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: moveList, toFolder: it.name }) }); } catch (_) {}
          for (const x of moveList) selected.delete(key(x.folder, x.id));
          $m('mat-status').textContent = `✓ 已移动 ${moveList.length} 个到「${it.name}」`;
          setTimeout(() => { $m('mat-status').textContent = ''; }, 2200);
          await loadFolders(); await loadGrid(); updCount();
        });
      }
      box.appendChild(el);
    }
  }

  // ---- 右侧素材网格 + 分页 ----
  async function loadGrid() {
    grid.innerHTML = '<div class="mat-empty">加载中…</div>';
    try { currentList = await (await fetch('/api/materials?folder=' + encodeURIComponent(curFolder))).json(); } catch (_) { currentList = []; }
    matPage = 0;
    renderGrid();
  }
  function visibleList() {
    const q = ($m('mat-search').value || '').trim().toLowerCase();
    return q ? currentList.filter((m) => (m.name || '').toLowerCase().includes(q)) : currentList;
  }
  function renderGrid() {
    const list = visibleList();
    const ps = pageSize();
    const pages = Math.max(1, Math.ceil(list.length / ps));
    if (matPage >= pages) matPage = pages - 1;
    const pageItems = list.slice(matPage * ps, matPage * ps + ps);
    $m('mat-total').textContent = `共 ${currentList.length} 个` + (list.length !== currentList.length ? `（匹配 ${list.length}）` : '');
    if (!currentList.length) { grid.innerHTML = '<div class="mat-empty">这个文件夹还没有素材，点上方「⬆ 上传视频」添加。</div>'; $m('mat-pager').innerHTML = ''; return; }
    if (!list.length) { grid.innerHTML = '<div class="mat-empty">没有匹配的素材。</div>'; $m('mat-pager').innerHTML = ''; return; }
    grid.innerHTML = '';
    for (const m of pageItems) {
      const card = document.createElement('div');
      const k = key(m.folder, m.id);
      const isSel = selected.has(k);
      card.className = 'mat-card' + (isSel ? ' selected' : '');
      card.draggable = true;
      card.innerHTML =
        `<div class="mat-check">${isSel ? '✓' : ''}</div>` +
        `<button class="mat-del" title="删除">✕</button>` +
        `<img class="mat-thumb" loading="lazy" src="/api/materials/thumb/${encodeURIComponent(m.folder)}/${m.id}" onerror="this.outerHTML='<div class=&quot;mat-thumb-ph&quot;>🎬</div>'">` +
        `<div class="mat-name" title="${escM(m.name)}">${escM(m.name)}</div>`;
      card.addEventListener('click', (e) => {
        if (e.target.closest('.mat-del')) return;
        if (selected.has(k)) selected.delete(k); else selected.set(k, { folder: m.folder, id: m.id, name: m.name });
        const on = selected.has(k);
        card.classList.toggle('selected', on);
        card.querySelector('.mat-check').textContent = on ? '✓' : '';
        updCount();
      });
      card.addEventListener('dragstart', (e) => {
        card.classList.add('dragging');
        dragItems = (selected.has(k) && selected.size > 0) ? [...selected.values()] : [{ folder: m.folder, id: m.id, name: m.name }];
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'move');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      // 悬停自动播放预览
      let hoverVid = null, hoverTimer = null;
      card.addEventListener('mouseenter', () => {
        hoverTimer = setTimeout(() => {
          if (hoverVid) return;
          hoverVid = document.createElement('video');
          hoverVid.className = 'mat-preview';
          hoverVid.muted = true; hoverVid.loop = true; hoverVid.playsInline = true; hoverVid.preload = 'auto';
          hoverVid.src = `/api/materials/file/${encodeURIComponent(m.folder)}/${m.id}`;
          card.appendChild(hoverVid);
          hoverVid.play().catch(() => {});
        }, 250); // 悬停 0.25s 才播，避免划过就加载
      });
      card.addEventListener('mouseleave', () => {
        clearTimeout(hoverTimer);
        if (hoverVid) { hoverVid.pause(); hoverVid.remove(); hoverVid = null; }
      });
      card.querySelector('.mat-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('从素材库删除这个视频？')) return;
        try { await fetch(`/api/materials/${encodeURIComponent(m.folder)}/${m.id}`, { method: 'DELETE' }); } catch (_) {}
        selected.delete(k); await loadFolders(); loadGrid(); updCount();
      });
      grid.appendChild(card);
    }
    renderPager(pages);
  }
  function renderPager(pages) {
    const p = $m('mat-pager');
    if (pages <= 1) { p.innerHTML = ''; return; }
    p.innerHTML = `<button class="pg-prev"${matPage === 0 ? ' disabled' : ''}>‹ 上一页</button>` +
      `<span>第 ${matPage + 1} / ${pages} 页</span>` +
      `<button class="pg-next"${matPage >= pages - 1 ? ' disabled' : ''}>下一页 ›</button>`;
    p.querySelector('.pg-prev').addEventListener('click', () => { if (matPage > 0) { matPage--; renderGrid(); } });
    p.querySelector('.pg-next').addEventListener('click', () => { if (matPage < pages - 1) { matPage++; renderGrid(); } });
  }

  $m('mat-search').addEventListener('input', () => { matPage = 0; renderGrid(); });
  $m('mat-pagesize').addEventListener('change', () => { matPage = 0; renderGrid(); });
  $m('mat-selall').addEventListener('click', () => {
    const ps = pageSize();
    const pageItems = visibleList().slice(matPage * ps, matPage * ps + ps);
    const allSel = pageItems.length && pageItems.every((m) => selected.has(key(m.folder, m.id)));
    for (const m of pageItems) { const k = key(m.folder, m.id); if (allSel) selected.delete(k); else selected.set(k, { folder: m.folder, id: m.id, name: m.name }); }
    renderGrid(); updCount();
  });
  $m('open-materials').addEventListener('click', async () => {
    selected.clear();
    for (const r of files.materialRefs) selected.set(key(r.folder, r.id), r);
    modal.hidden = false;
    await loadFolders(); await loadGrid(); updCount();
  });
  $m('materials-close').addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
  $m('mat-newfolder').addEventListener('click', async () => {
    const name = prompt('新建文件夹名称：');
    if (!name || !name.trim()) return;
    try { const d = await (await fetch('/api/materials/folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) })).json(); if (d.name) curFolder = d.name; } catch (_) {}
    matPage = 0; await loadFolders(); loadGrid();
  });
  async function uploadFiles(fileList) {
    const list = [...fileList].filter((f) => f.type.startsWith('video') || /\.(mp4|mov|mkv|avi|webm|flv|m4v)$/i.test(f.name));
    if (!list.length) return;
    const folder = curFolder === '__all__' ? '默认' : curFolder;
    const fd = new FormData(); fd.append('folder', folder);
    list.forEach((f) => fd.append('videos', f, f.name));
    $m('mat-status').textContent = `上传 ${list.length} 个中…`;
    try {
      const d = await (await fetch('/api/materials/upload', { method: 'POST', body: fd })).json();
      if (!d.ok) throw new Error(d.error || '上传失败');
      $m('mat-status').textContent = `✓ 已入库 ${d.saved.length} 个到「${folder}」`;
      curFolder = folder; await loadFolders(); await loadGrid();
      setTimeout(() => loadGrid(), 1500);
      setTimeout(() => { $m('mat-status').textContent = ''; }, 2800);
    } catch (err) { $m('mat-status').textContent = '✗ ' + err.message; }
  }
  $m('mat-upload-input').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
  // 拖本地文件到网格 → 批量上传到当前文件夹
  grid.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer.types || [])].includes('Files')) return; // 忽略内部卡片拖动
    e.preventDefault(); grid.classList.add('mat-drop-on');
  });
  grid.addEventListener('dragleave', (e) => { if (e.target === grid) grid.classList.remove('mat-drop-on'); });
  grid.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault(); grid.classList.remove('mat-drop-on');
    uploadFiles(e.dataTransfer.files);
  });
  $m('mat-clear').addEventListener('click', () => { selected.clear(); renderGrid(); updCount(); });
  $m('mat-confirm').addEventListener('click', () => {
    files.materialRefs = [...selected.values()];
    modal.hidden = true;
    refreshUI();
  });
}
setupMaterials();

// ---------- 一键生成并上传 ----------
function setupOneClick() {
  const skuSel = $('oc-sku'), acctSel = $('oc-acct'), info = $('oc-info'), go = $('oc-go'), tplSel = $('oc-tpl');
  let ocSkus = [];
  let ocTpls = []; // 当前 SKU 下的模版
  async function loadSkus() {
    try { ocSkus = await (await fetch('/api/oneclick/skus')).json(); } catch (_) { ocSkus = []; }
    skuSel.innerHTML = ocSkus.length
      ? ocSkus.map((s) => `<option value="${escAttrS(s.sku)}">${esc(s.sku)}</option>`).join('') // SKU 只显示名字，数量在下面四个窗口里展示
      : '<option value="">（资源库暂无 SKU 文件夹）</option>';
    onSkuChange();
  }
  async function loadAccts() {
    const accs = await ttGetAccounts();
    acctSel.innerHTML = accs.length
      ? accs.map((a) => `<option value="${escAttrS(a.id)}">${esc(a.name)}</option>`).join('')
      : '<option value="">（未配置 / 无账户）</option>';
    const def = accs.find((a) => /BV-TMT-H7-ULTRA-WH/i.test(a.name || ''));
    if (def) acctSel.value = def.id;
  }
  const curSku = () => ocSkus.find((s) => s.sku === skuSel.value);
  // 四个窗口：视频/配音/音乐数量
  function updateWindows() {
    const s = curSku();
    $('oc-w-videos').textContent = s ? s.videos + ' 个' : '—';
    $('oc-w-voices').textContent = s ? s.voices + ' 条' : '—';
    $('oc-w-bgm').textContent = s ? (s.bgm ? s.bgm + ' 条' : '无 ⚠') : '—';
    $('oc-w-bgm').classList.toggle('oc-num-warn', !!s && !s.bgm);
  }
  // 混剪模版窗口：拉取该 SKU 下的模版
  async function loadTpls() {
    const s = curSku();
    if (!s) { ocTpls = []; tplSel.innerHTML = '<option value="">默认设置</option>'; return; }
    try { ocTpls = await (await fetch('/api/templates?sku=' + encodeURIComponent(s.sku))).json(); } catch (_) { ocTpls = []; }
    tplSel.innerHTML = '<option value="">默认设置（竖屏·60fps·闪避·无字幕）</option>' +
      ocTpls.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  }
  // 选了模版 → 自动把「生成字幕」对齐模版（仍可手动改）
  tplSel.addEventListener('change', () => {
    const t = ocTpls.find((x) => x.id === tplSel.value);
    if (t && t.options && typeof t.options.subtitles === 'boolean') $('oc-subs').checked = t.options.subtitles;
    updInfo();
  });
  function onSkuChange() { updateWindows(); loadTpls(); updInfo(); }
  function updInfo() {
    const s = curSku();
    if (!s) { info.textContent = ''; return; }
    const total = Math.max(1, Math.min(60, parseInt($('oc-count').value, 10) || 12));
    const t = ocTpls.find((x) => x.id === tplSel.value);
    info.innerHTML = `将用 <b>${s.videos}</b> 个视频素材、<b>${s.voices}</b> 条配音，按<b>${t ? '模版「' + esc(t.name) + '」' : '默认设置'}</b>生成 <b>${total}</b> 条成片（自动均分到各配音，&lt;5 秒的配音自动跳过）` +
      (s.bgm ? `；背景音乐取该 SKU 第 1 条` : '；<span class="oc-warn">⚠ 该 SKU 下没有背景音乐</span>');
  }
  skuSel.addEventListener('change', onSkuChange);
  $('oc-count').addEventListener('input', updInfo);

  function setOcProgress(pct, text) { $('oc-progress-fill').style.width = Math.max(0, Math.min(100, pct)) + '%'; $('oc-progress-text').textContent = text; }
  function listenOc(ocId) {
    const es = new EventSource('/api/oneclick/progress/' + ocId);
    es.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (_) { return; }
      setOcProgress(d.percent || 0, d.message || '处理中…');
      if (d.status === 'done' || d.status === 'error') { es.close(); go.disabled = false; go.textContent = '🚀 一键生成并上传'; renderOcResults(d); }
    };
    es.onerror = () => { es.close(); go.disabled = false; go.textContent = '🚀 一键生成并上传'; };
  }
  function renderOcResults(d) {
    const box = $('oc-results'); box.hidden = false;
    if (d.status === 'error') { box.innerHTML = `<div class="oc-res-head err">✗ ${esc(d.error || '出错了')}</div>`; return; }
    const rows = d.results || []; const ok = rows.filter((r) => r.ok).length;
    box.innerHTML = `<div class="oc-res-head">✅ 完成：生成 ${d.generated} 条，${d.uploaded ? '上传成功 ' + ok + '/' + rows.length + ' 条' : '未上传'}</div>` +
      `<div class="oc-res-list">` + rows.map((r) => `<div class="oc-res-row ${r.ok ? 'ok' : 'err'}">${r.ok ? '✓' : '✗'} ${esc(r.name)}${r.ok ? (r.video_id && r.video_id !== '(未上传)' ? '' : '') : ' — ' + esc(r.error || '')}</div>`).join('') + `</div>`;
  }

  go.addEventListener('click', async () => {
    const s = curSku();
    if (!s) { alert('请先选择产品 SKU'); return; }
    const upload = !$('oc-noupload').checked;
    const advertiserId = acctSel.value;
    if (upload && !advertiserId) { alert('请选择广告账户（或勾选「只生成不上传」）'); return; }
    const total = Math.max(1, Math.min(60, parseInt($('oc-count').value, 10) || 12));
    const acctName = acctSel.options[acctSel.selectedIndex] ? acctSel.options[acctSel.selectedIndex].text : '';
    const tpl = ocTpls.find((x) => x.id === tplSel.value);
    if (!confirm(`确认一键生成？\n\nSKU：${s.sku}\n混剪模版：${tpl ? tpl.name : '默认设置'}\n生成 ${total} 条成片（自动分配到各配音）\n${upload ? '上传到广告户：' + acctName : '只生成，不上传'}\n\n耗时约 ${Math.max(1, Math.ceil(total * 0.6))} 分钟，期间请保持页面打开。`)) return;
    go.disabled = true; go.textContent = '生成中…';
    $('oc-progress-wrap').hidden = false; $('oc-results').hidden = true;
    setOcProgress(1, '正在启动…');
    try {
      const d = await (await fetch('/api/oneclick', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: s.sku, advertiserId, upload, totalCount: total, subtitles: $('oc-subs').checked, templateId: tplSel.value }) })).json();
      if (!d.ok) throw new Error(d.error || '启动失败');
      listenOc(d.ocId);
    } catch (e) { setOcProgress(0, '✗ ' + e.message); go.disabled = false; go.textContent = '🚀 一键生成并上传'; }
  });

  loadSkus(); loadAccts();
}
setupOneClick();

refreshUI();

const $ = (s) => document.querySelector(s);
// BUILD 标识：语义化版本号（从 package.json 注入）+ 本次发布构建时间
// 格式 "v1.0.5 @ 2026-08-16T20:52" — 用户一眼能看出是否升级到新版本
const BUILD = 'v1.1.4 @ 2026-08-17T01:48';
const VERSION = '1.1.4'; // 语义化版本号（与 package.json 一致）
const statusColor = { valid: '#1a7f37', dead: '#cf222e', login: '#bf8700', unknown: '#6e7781', suspect: '#d4a017' };
const statusLabel = { valid: '有效', dead: '失效', login: '需登录', unknown: '未检测', suspect: '疑似失效' };
// 失效/需登录等原因的中文含义，方便小白用户看懂（有效的"ok/redirect"不在此列出，原因列留空）
const REASON_CN = {
  login_required: '需要登录 / 授权',
  dns_failure: '域名解析失败（网址打不开）',
  not_found: '页面不存在（404）',
  network: '网络连接失败',
  connection_refused: '连接被拒绝（服务器拒接）',
  connection_reset: '连接被远程重置（可能是反爬或瞬时故障）',
  timeout: '连接超时（反应太慢）',
  http_client_error: '客户端错误（400-499）',
  http_server_error: '服务器错误（500+）',
  invalid_url: '链接格式非法',
  too_many_redirects: '跳转次数过多',
  unknown: '未知原因',
  aborted: '检测已停止',
  unchecked: '未检测',
};
// 原因列显示：有效的留空（状态列已说明）；其余显示「中文（英文）」；
// 网络层异常（被拦截/超时等）可能误报，附加「⚠️建议手动确认」提示
function reasonText(reason, status, suspicious, note) {
  if (status === 'valid') return '';
  const cn = REASON_CN[reason];
  if (!cn) return reason || '';
  let text = `${cn}（${reason}）`;
  if (suspicious) text += ' ⚠️建议手动确认';
  if (note) text += `<br><span style="font-size:0.85em;color:#8B6914">${note}</span>`;
  return text;
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escAttr = (s) => esc(s).replace(/'/g, '&#39;');

// ====== 覆盖全局 alert/prompt：Electron BrowserWindow 默认禁用 alert()/prompt() ======
// （出于安全和 UX 考虑，Chromium 不在嵌入式页面里渲染这些弹窗）。
// 用 in-page modal 替代，保留原有调用形式（不破坏现有 20+ 处用法）。
const _msgModal = () => document.getElementById('msgModal');
function showAlert(message, opts = {}) {
  return new Promise((resolve) => {
    const m = _msgModal();
    const body = m.querySelector('#msgBody');
    const actions = m.querySelector('#msgActions');
    const title = m.querySelector('#msgTitle');
    title.textContent = opts.title || '提示';
    body.textContent = String(message ?? '');
    actions.innerHTML = '';
    const ok = document.createElement('button');
    ok.className = 'btn primary';
    ok.textContent = '好';
    actions.appendChild(ok);
    function close() { m.classList.add('hidden'); actions.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(); }
    function onKey(e) { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); close(); } }
    ok.onclick = close;
    document.getElementById('msgClose').onclick = close;
    document.addEventListener('keydown', onKey);
    m.classList.remove('hidden');
    setTimeout(() => ok.focus(), 50);
  });
}
function showPrompt(message, defaultValue = '', opts = {}) {
  return new Promise((resolve) => {
    const m = document.getElementById('promptModal');
    const input = m.querySelector('#promptInput');
    const errEl = m.querySelector('#promptError');
    const title = m.querySelector('#promptTitle');
    const msgEl = m.querySelector('#promptMessage');
    title.textContent = opts.title || '输入';
    msgEl.textContent = String(message ?? '');
    input.value = String(defaultValue ?? '');
    errEl.style.display = 'none';
    errEl.textContent = '';
    m.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    function cleanup() { m.classList.add('hidden'); input.onkeydown = null; }
    function onOk() {
      const v = input.value;
      if (typeof opts.validate === 'function') {
        const r = opts.validate(v);
        if (r !== true) {
          errEl.textContent = String(r || '输入无效');
          errEl.style.display = 'block';
          input.focus(); input.select();
          return;
        }
      }
      cleanup(); resolve(v);
    }
    function onCancel() { cleanup(); resolve(null); }
    function onKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }
    input.onkeydown = onKey;
    m.querySelector('#promptOk').onclick = onOk;
    m.querySelector('#promptCancel').onclick = onCancel;
    m.querySelector('#promptClose').onclick = onCancel;
  });
}
window.alert = showAlert;
window.prompt = showPrompt;

let currentJob = null; // 正在轮询的任务
let pollTimer = null;
let reportData = null;  // 当前报告数据（供选中操作使用）
let bms = [];           // 当前报告的书签数组（供分页渲染）
let idxByKey = null;    // url+title+folder -> globalIdx 的索引 Map（避免重复组内 O(n*m) 查找）
let tableRendered = 0;  // 明细表已渲染行数
const PAGE_SIZE = 150;  // 明细表每页渲染行数（避免一次性渲染近千行卡顿）
let currentScanSource = null; // 当前扫描来源 { browser, profile } 或 { importId }，供写回 Chrome 使用
let sourceMeta = {};          // sourceValue -> { hasAccount, running, browser, profile }，用于判断是否同步账号

// 生成书签的唯一定位键
function keyOf(b) {
  const f = Array.isArray(b.folder) ? b.folder.join(' / ') : (b.folder || '');
  return `${b.url}\u0000${b.title || ''}\u0000${f}`;
}

// 来源下拉：值为 `b|browser|profile` 或 `i|importId`
const LS_SOURCE = 'bm_source_v1';
// 用户手动覆盖状态：{url: 'valid'|'dead'|...} —— 检测引擎有局限（如代理被反爬），
// 用户能确认的实际状态应优先于自动探测。存在 localStorage，跨刷新保留。
const LS_MANUAL = 'bm_manual_status_v1';

function sourceValue(p) {
  return p.isImport ? `i|${p.importId}` : `b|${p.browser}|${p.profile}`;
}

// ====== 手动状态覆盖（解决检测器受代理/反爬限制的误报）======
// 待同步到 Chrome 的修改队列：{url, oldTitle?, newTitle?, oldUrl?, newUrl?}
const LS_PENDING = 'bm_pending_updates_v1';
function loadPending() {
  try { return JSON.parse(localStorage.getItem(LS_PENDING) || '[]'); } catch { return []; }
}
function savePending(p) { localStorage.setItem(LS_PENDING, JSON.stringify(p)); }
function addPendingUpdate(u) {
  const p = loadPending();
  // 相同 url 的变更合并（后改的覆盖先改的）
  const i = p.findIndex(x => x.url === u.url);
  if (i >= 0) p[i] = { ...p[i], ...u }; else p.push(u);
  savePending(p);
}
function loadManual() {
  try { return JSON.parse(localStorage.getItem(LS_MANUAL) || '{}'); } catch { return {}; }
}
function saveManual(m) { localStorage.setItem(LS_MANUAL, JSON.stringify(m)); }
function setManualStatus(url, status) {
  const m = loadManual();
  if (status == null) delete m[url]; else m[url] = status;
  saveManual(m);
}
function getManualStatus(url) { return loadManual()[url] || null; }
// 把 manual 覆盖应用到 bms 数组
function applyManual(bms) {
  const m = loadManual();
  if (!Object.keys(m).length) return bms;
  return bms.map(b => m[b.url] ? { ...b, status: m[b.url], manual: true } : b);
}

function makeSourceOption(p) {
  const o = document.createElement('option');
  o.value = sourceValue(p);
  // 标明书签存储方式：本地 Bookmarks / 账号同步 AccountBookmarks / 两者都有
  let srcTag;
  if (p.isImport) srcTag = '导入';
  else if (p.hasAccount && p.hasLocal) srcTag = '本机+同步';
  else if (p.hasAccount) srcTag = '同步账号';
  else srcTag = '本机';
  const tag = ` [${srcTag}${p.isBackup ? '(bak)' : ''}]`;
  const run = p.running ? ' ⚠浏览器运行中' : '';
  // 分组后浏览器名已在 optgroup 上，选项只显示配置文件 + 条数
  o.textContent = `${p.profile}（${p.urlCount} 条）${tag}${run}`;
  if (p.running) o.title = '该浏览器当前正在运行，写回前请先关闭，否则改动会被覆盖。';
  else if (p.hasAccount) o.title = '该书签跟随 Google 账号同步，存储于 AccountBookmarks；写回后会推送到云端。';
  return o;
}

async function loadProfiles(opts = {}) {
  const hint = $('#sourceHint');
  sourceMeta = {};
  if (opts.exploring) {
    hint.classList.remove('hidden');
    hint.textContent = '🔍 正在扫描本机已安装的浏览器…';
  }
  try {
    const ps = await (await fetch('/api/profiles')).json();
    const sel = $('#profile');
    const prev = sel.value; // 重新扫描前记住当前选择，扫描后尽量还原
    sel.innerHTML = '';
    // 占位项：强制用户显式选择来源，而不是默默用第一个
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '请选择书签来源…';
    sel.appendChild(ph);

    if (!ps.length) {
      const o = document.createElement('option');
      o.disabled = true;
      o.textContent = '（未在本机发现任何浏览器书签）';
      sel.appendChild(o);
      hint.classList.remove('hidden');
      hint.innerHTML = '未在本机发现任何浏览器书签。你可以点「手动导入文件」选择 Chrome 导出的 HTML / JSON 文件。';
      return;
    }

    // 按浏览器分组展示（更利于多浏览器 / 多人的情况）
    const groups = new Map();
    const imports = [];
    for (const p of ps) {
      if (p.isImport) { imports.push(p); continue; }
      if (!groups.has(p.browserLabel)) groups.set(p.browserLabel, []);
      groups.get(p.browserLabel).push(p);
    }
    for (const [label, items] of groups) {
      const og = document.createElement('optgroup');
      og.label = label;
      items.forEach((p) => {
        og.appendChild(makeSourceOption(p));
        sourceMeta[sourceValue(p)] = { hasAccount: p.hasAccount, running: p.running, browser: p.browser, profile: p.profile, browserLabel: p.browserLabel };
      });
      sel.appendChild(og);
    }
    if (imports.length) {
      const og = document.createElement('optgroup');
      og.label = '手动导入';
      imports.forEach((p) => {
        og.appendChild(makeSourceOption(p));
        sourceMeta['i|' + p.importId] = { hasAccount: false, running: false };
      });
      sel.appendChild(og);
    }

    // 还原选择：优先保留扫描前的当前选择，其次恢复上次记忆的来源
    const saved = localStorage.getItem(LS_SOURCE);
    const restore = (prev && ps.find((p) => sourceValue(p) === prev))
      ? prev
      : (saved && ps.find((p) => sourceValue(p) === saved) ? saved : null);
    if (restore) sel.value = restore;

    const browsers = groups.size;
    const profiles = ps.filter((p) => !p.isImport).length;
    const totalBms = ps.reduce((s, p) => s + (p.urlCount || 0), 0);
    const syncedCnt = ps.filter((p) => p.hasAccount && !p.isImport).length;
    const localCnt = ps.filter((p) => p.hasLocal && !p.hasAccount && !p.isImport).length;
    let note = '';
    if (syncedCnt || localCnt) {
      note = `<br>标注「同步账号」= 书签跟随 Google 账号存于 <code>AccountBookmarks</code>；标注「本机」= 仅存本地 <code>Bookmarks</code>（适合无法使用账号同步的用户）。工具会自动读取并合并两者。`;
    }
    hint.classList.remove('hidden');
    hint.innerHTML = `已发现 <b>${browsers}</b> 款浏览器、<b>${profiles}</b> 个配置文件，共 <b>${totalBms}</b> 条书签。请在下拉框中选择要整理的来源。${note}`;
  } catch (e) {
    hint.classList.remove('hidden');
    hint.textContent = '扫描本机书签失败：' + (e.message || '未知错误');
  }
  loadFolders();
}

// 解析下拉 value 为扫描请求体片段
function sourceBody() {
  const v = $('#profile').value || '';
  const [kind, ...rest] = v.split('|');
  if (kind === 'i') return { importId: rest[0] };
  return { browser: rest[0], profile: rest[1] };
}

// 加载并在界面上渲染文件夹树
async function loadFolders() {
  const v = $('#profile').value || '';
  if (!v) { $('#folderTree').innerHTML = '<span class="muted">选择来源后显示文件夹…</span>'; return; }
  const q = v.startsWith('i|') ? `importId=${encodeURIComponent(v.slice(2))}` : (() => { const [, b, p] = v.split('|'); return `browser=${encodeURIComponent(b)}&profile=${encodeURIComponent(p)}`; })();
  try {
    const r = await (await fetch(`/api/folders?${q}`)).json();
    if (!r.ok) throw new Error(r.error);
    $('#folderTree').innerHTML = '';
    $('#folderTree').appendChild(renderNode(r.tree, true));
    propagateCheck();
  } catch (e) {
    $('#folderTree').innerHTML = `<span class="muted">无法加载文件夹：${esc(e.message)}</span>`;
  }
}

// 递归渲染文件夹节点；默认全部勾选
function renderNode(node, isRoot) {
  const ul = document.createElement('ul');
  if (isRoot) ul.classList.add('root');
  (node.children || []).forEach((child) => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'fnode';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.path = JSON.stringify(child.path);
    cb.addEventListener('change', () => setDescendants(li, cb.checked));
    label.appendChild(cb);
    const txt = document.createElement('span');
    txt.textContent = `${child.name}（${child.count}）`;
    label.appendChild(txt);
    li.appendChild(label);
    if (child.children && child.children.length) li.appendChild(renderNode(child, false));
    ul.appendChild(li);
  });
  return ul;
}

// 勾选/取消父文件夹时，同步其全部子孙
function setDescendants(li, checked) {
  li.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = checked; });
}

// 统一勾选状态（用于渲染后 / 全选 / 全不选）
function propagateCheck() { /* 渲染时已默认勾选 */ }

// 收集当前勾选的文件夹路径（数组的数组）
function selectedFolders() {
  const cbs = $('#folderTree').querySelectorAll('input[type=checkbox]:checked');
  return Array.from(cbs).map((c) => JSON.parse(c.dataset.path));
}

// 全选 / 全不选
$('#selAll').addEventListener('click', (e) => { e.preventDefault(); $('#folderTree').querySelectorAll('input[type=checkbox]').forEach((c) => (c.checked = true)); });
$('#selNone').addEventListener('click', (e) => { e.preventDefault(); $('#folderTree').querySelectorAll('input[type=checkbox]').forEach((c) => (c.checked = false)); });
$('#toggleTree').addEventListener('click', (e) => { e.preventDefault(); $('#folderTree').querySelectorAll('ul').forEach((u) => u.classList.toggle('collapsed')); });

// 选择来源后记忆上次选择，并刷新文件夹树
$('#profile').addEventListener('change', () => {
  const v = $('#profile').value;
  if (v) localStorage.setItem(LS_SOURCE, v);
  loadFolders();
});

// 刷新来源：重新扫描本机已安装的浏览器并刷新来源列表
$('#exploreBtn').addEventListener('click', async () => {
  const btn = $('#exploreBtn');
  const hint = $('#sourceHint');
  const prevText = btn.textContent;
  // 1. 立即禁用 + loading 状态（避免重复点击 + 视觉反馈）
  btn.disabled = true;
  btn.classList.add('is-loading');
  btn.textContent = '⏳ 刷新中…';
  hint.classList.remove('hidden');
  hint.textContent = '🔄 正在扫描本机已安装的浏览器…';
  try {
    const t0 = Date.now();
    await loadProfiles({ exploring: true });
    const ms = Date.now() - t0;
    // 2. 完成反馈：明确告诉用户找到了几个
    const sel = $('#profile');
    const count = sel.querySelectorAll('option:not([disabled])').length + sel.querySelectorAll('optgroup option').length;
    const sel0 = sel.value;
    hint.classList.remove('hidden');
    if (count > 0) {
      hint.innerHTML = `✅ 已发现 <b>${count}</b> 个书签来源${ms > 500 ? `（耗时 ${ms}ms）` : ''}。请在「书签来源」下拉框选择要整理的范围。`;
    } else {
      hint.innerHTML = '⚠️ 未在本机发现任何浏览器书签。你可以点「手动导入文件」选择 Chrome 导出的 HTML / JSON 文件。';
    }
  } catch (e) {
    hint.classList.remove('hidden');
    hint.textContent = '❌ 刷新来源失败：' + e.message;
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    btn.textContent = prevText;
  }
});

// 手动导入
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('#error').classList.add('hidden');
  $('#progress').classList.remove('hidden');
  $('#progress').textContent = `正在导入「${file.name}」…`;
  const content = await file.text();
  try {
    const resp = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, name: file.name }) });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || '导入失败');
    const sel = $('#profile');
    const o = document.createElement('option');
    o.value = `i|${data.id}`;
    o.textContent = `手动导入 · ${data.name}（${data.urlCount} 条） [导入]`;
    sel.prepend(o);
    sel.value = o.value;
    await loadFolders();
    $('#progress').textContent = `已导入「${data.name}」（${data.urlCount} 条），可勾选文件夹后扫描。`;
  } catch (err) {
    $('#progress').classList.add('hidden');
    $('#error').textContent = '导入错误：' + err.message;
    $('#error').classList.remove('hidden');
  }
  e.target.value = '';
});

// 开始扫描
$('#scanBtn').addEventListener('click', async () => {
  if (currentJob) return;
  $('#error').classList.add('hidden');
  // 必须显式选择来源，避免默默用错浏览器/配置文件
  if (!$('#profile').value) {
    $('#error').textContent = '请先在「书签来源」中选择一个浏览器 / 配置文件（或点「手动导入文件」），再开始扫描。';
    $('#error').classList.remove('hidden');
    return;
  }
  $('#result').classList.add('hidden');
  $('#progress').classList.remove('hidden');
  $('#bar').classList.remove('hidden');
  setBar(0, 0);
  $('#progress').textContent = '已提交扫描任务，准备中…';
  $('#scanBtn').disabled = true;
  $('#stopBtn').classList.remove('hidden');

  const body = {
    ...sourceBody(),
    doCheck: $('#doCheck').checked,
    removeDead: $('#removeDead').checked,
    sort: $('#doSort').checked,
    folders: selectedFolders(),
  };
  currentScanSource = sourceBody(); // 保存供写回使用
  try {
    const resp = await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || '启动扫描失败');
    currentJob = data.jobId;
    pollJob();
  } catch (e) {
    resetScanUI();
    $('#progress').classList.add('hidden');
    $('#bar').classList.add('hidden');
    $('#error').textContent = '错误：' + e.message;
    $('#error').classList.remove('hidden');
  }
});

// 停止扫描
$('#stopBtn').addEventListener('click', async () => {
  // 立即给用户反馈（按钮文案变化 + 不可重复点）
  const btn = $('#stopBtn');
  btn.disabled = true;
  btn.textContent = '停止中…';
  $('#progress').textContent = '正在停止扫描（最长 8 秒完成）…';
  if (!currentJob) {
    // 没在跑 scan 时，单纯恢复 UI
    setTimeout(() => { resetScanUI(); }, 500);
    return;
  }
  try {
    const r = await fetch(`/api/job/${currentJob}/cancel`, { method: 'POST' });
    if (!r.ok) console.warn('cancel 失败', r.status);
  } catch (e) {
    console.warn('cancel 请求失败', e);
  }
  // 启动兜底：8 秒后无论如何强制重置 UI（即使后端没响应）
  // —— 单 URL timeout 已改为 8s，abortWatcher 100ms，最坏 8 秒内一定停止
  setTimeout(() => {
    if (currentJob) {
      console.warn('8 秒兜底：强制重置 UI');
      resetScanUI();
      currentJob = null;
    }
  }, 8500);
});

function setBar(done, total) {
  const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
  $('#barfill').style.width = pct + '%';
  $('#barfill').textContent = `${done} / ${total}（${pct}%）`;
}

// 轮询任务进度
function pollJob() {
  if (pollTimer) clearTimeout(pollTimer);
  const tick = async () => {
    if (!currentJob) return;
    try {
      const r = await (await fetch(`/api/job/${currentJob}`)).json();
      if (r.status === 'running') {
        setBar(r.progress.done, r.progress.total);
        $('#progress').textContent = r.progress.total
          ? `扫描中… ${r.progress.done}/${r.progress.total}　当前：${r.progress.current || ''}`
          : '加载书签中…';
        pollTimer = setTimeout(tick, 400);
      } else if (r.status === 'done' || r.status === 'stopped') {
        setBar(r.progress.done, r.progress.total);
        render(r.report, r.status === 'stopped');
        $('#progress').textContent = r.status === 'stopped' ? `已停止，已扫描 ${r.progress.done}/${r.progress.total} 条（结果含已完成的检测）。` : '扫描完成。';
        resetScanUI();
      } else if (r.status === 'error') {
        resetScanUI();
        $('#progress').classList.add('hidden');
        $('#error').textContent = '扫描错误：' + (r.error || '未知错误');
        $('#error').classList.remove('hidden');
      }
    } catch {
      pollTimer = setTimeout(tick, 1000);
    }
  };
  tick();
}

function resetScanUI() {
  $('#scanBtn').disabled = false;
  $('#stopBtn').classList.add('hidden');
  currentJob = null;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function render(data, partial) {
  reportData = data; // 保存供选中操作使用
  // 应用用户手动状态覆盖（解决检测器受代理/反爬限制的误报）
  bms = applyManual(data.bookmarks);
  // 预建索引 Map：重复组内每条不再做 findIndex（最坏 O(n*m)）
  idxByKey = new Map();
  bms.forEach((b, i) => idxByKey.set(keyOf(b), i));

  const r = data;
  const s = r.summary;
  // 统计卡片用 bms（已应用 manual 覆盖）重算，让用户手动改的状态立即反映在数字上
  const counts = { valid: 0, dead: 0, login: 0, suspect: 0, unknown: 0 };
  bms.forEach(b => { counts[b.status] = (counts[b.status] || 0) + 1; });
  $('#cards').innerHTML = [
    ['书签总数', bms.length], ['有效', counts.valid, 'ok'],
    ['失效', counts.dead, 'bad'], ['需登录', counts.login, 'warn'],
    ['疑似失效', counts.suspect, 'warn'], ['未检测', counts.unknown || 0], ['合并重复', s.merged],
    ['整理后保留', s.kept],
  ].map(([label, val, cls]) => `<div class="card ${cls || ''}"><b>${val}</b><span>${label}</span></div>`).join('');

  const groups = [...r.duplicates.urlGroups, ...r.duplicates.redirectGroups];
  $('#dupCount').textContent = `（${groups.length} 组）`;
  $('#dups').innerHTML = groups.length ? groups.map((g, gi) => renderDupGroup(g, gi, r, idxByKey)).join('') : '<p class="muted" style="margin:0 24px">未发现重复书签。</p>';

  // 绑定重复组内事件
  bindDupGroupActions();

  // 明细表分页渲染（首屏只渲染前 PAGE_SIZE 行，避免近千行一次性卡顿）
  tableRendered = 0;
  $('#tbl tbody').innerHTML = '';
  appendRowChunk();
  bindTableInteractions();

  $('#exHtml').href = '/output/report.html';
  $('#exCsv').href = '/output/report.csv';
  $('#exJson').href = '/output/report.json';
  // Safari 导入文件：必须强制下载（Content-Disposition: attachment），否则浏览器会直接渲染 HTML
  $('#exSafari').href = '/api/download/safari-bookmarks';
  $('#exSafari').download = 'safari-bookmarks.html';

  $('#result').classList.remove('hidden');
}

// 追加一页明细表行
function appendRowChunk() {
  const end = Math.min(tableRendered + PAGE_SIZE, bms.length);
  let html = '';
  for (let i = tableRendered; i < end; i++) {
    const b = bms[i];
    const c = statusColor[b.status] || '#6e7781';
    html += `<tr data-idx="${i}"><td class="chkcol"><input type="checkbox" class="bm-cb" data-idx="${i}"></td>`
      + `<td><span class="dot" style="background:${c}"></span><span class="title-cell" data-idx="${i}" title="点击修改标题" style="cursor:text">${esc(b.title)}</span> <span class="title-edit" data-idx="${i}" title="点击修改标题" style="cursor:pointer;color:#888">✎</span></td>`
      + `<td><a class="url-link" href="${esc(b.url)}" target="_blank">${esc(b.url)}</a> <span class="url-edit" data-idx="${i}" title="点击修改 URL" style="cursor:pointer;color:#888">✎</span></td>`
      + `<td>${esc(b.folder)}</td>`
      + `<td style="color:${c};cursor:pointer;user-select:none" class="status-cell" data-url="${esc(b.url)}" data-idx="${i}" title="点击切换状态：${statusLabel[b.status] || b.status} → 下一个（shift+点击=清除手动覆盖恢复检测结果）">${statusLabel[b.status] || b.status}${b.manual ? ' ✎' : ' ↻'}</td>`
      + `<td>${esc(reasonText(b.reason, b.status, b.suspicious, b.note))}</td>`
      + `<td>${b.dupGroups && b.dupGroups.length ? '组' + b.dupGroups.join(',') : ''}</td></tr>`;
  }
  const tbody = $('#tbl tbody');
  tbody.insertAdjacentHTML('beforeend', html);
  // 仅给本页新增的复选框绑定事件
  for (let i = tableRendered; i < end; i++) {
    const cb = tbody.querySelector(`tr[data-idx="${i}"] .bm-cb`);
    if (cb) cb.addEventListener('change', updateSelBar);
  }
  tableRendered = end;
  updateSelBar();
  const btn = $('#loadMore');
  if (btn) {
    if (tableRendered < bms.length) {
      btn.classList.remove('hidden');
      btn.textContent = `加载更多（还剩 ${bms.length - tableRendered} 条）`;
    } else {
      btn.classList.add('hidden');
    }
  }
}

// ========== 重复组渲染与操作 ==========

// 渲染单个重复组（含选择框 + 操作工具栏）
// idxMap: url+title+folder -> globalIdx 的预建索引，避免 O(n*m) 查找
function renderDupGroup(group, groupIdx, report, idxMap) {
  const items = group.map((b, bi) => {
    const globalIdx = idxMap ? (idxMap.get(keyOf(b)) ?? -1) : -1;
    const statusTag = b.status ? `<span class="dup-status dup-status-${b.status}">${statusLabel[b.status] || b.status}</span>` : '';
    const displayUrl = b.finalUrl && b.finalUrl !== b.url ? `<code class="dup-final-url">→ ${esc(b.finalUrl)}</code>` : '';
    // 文件夹路径：reporter 输出的是字符串 "A / B / C"，兼容数组和字符串两种格式
    const rawFolder = b.folder;
    const folderArr = Array.isArray(rawFolder) ? rawFolder : (typeof rawFolder === 'string' && rawFolder ? rawFolder.split(' / ') : []);
    const folderPath = folderArr.length
      ? `<span class="dup-folder-path" title="书签位于：${esc(folderArr.join(' > '))}">📁 ${esc(folderArr.join(' > '))}</span>`
      : '';
    return `<li class="dup-item" data-dup-gi="${groupIdx}" data-dup-bi="${bi}" data-global-idx="${globalIdx}">
      <input type="checkbox" class="dup-cb" data-global-idx="${globalIdx}">
      <div class="dup-item-body">
        <a href="${esc(b.url)}" target="_blank" class="dup-link">${esc(b.title || b.url)}</a>
        ${folderPath}
        <span class="dup-url"><span class="dup-url-label">URL:</span> <a href="${esc(b.url)}" target="_blank" class="dup-url-link">${esc(b.url)}</a></span>
        ${displayUrl}
        ${statusTag}
      </div>
    </li>`;
  }).join('');

  return `<div class="dup" data-dup-group="${groupIdx}">
    <div class="dup-header">
      <h4>重复组 #${groupIdx + 1}（${group.length} 条）</h4>
      <div class="dup-toolbar">
        <button class="dup-btn dup-keep-best" data-gi="${groupIdx}" title="自动保留最佳（优先有效+最短URL），其余标记待删除">✓ 保留最佳</button>
        <button class="dup-btn dup-merge-selected" data-gi="${groupIdx}" title="勾选2条以上后合并为一条（保留第一条的标题和URL）">🔗 合并选中</button>
        <button class="dup-btn dup-del-selected" data-gi="${groupIdx}" title="将组内选中的书签从Chrome中删除">🗑 删除选中</button>
        <button class="dup-btn dup-copy-urls" data-gi="${groupIdx}" title="复制组内全部 URL 到剪贴板">📋 复制 URL</button>
        <button class="dup-btn dup-edit-mode" data-gi="${groupIdx}" title="进入/退出行内编辑模式（可改标题和URL）">✏ 编辑</button>
      </div>
    </div>
    <ul>${items}</ul>
    <div class="dup-feedback" data-fb-gi="${groupIdx}"></div>
  </div>`;
}

// 绑定重复组的所有交互事件
function bindDupGroupActions() {
  document.querySelectorAll('.dup').forEach((dupEl) => {
    const gi = parseInt(dupEl.dataset.dupGroup, 10);
    dupEl.querySelectorAll('.dup-cb').forEach((cb) => {
      cb.addEventListener('change', () => refreshDupToolbar(gi));
    });
  });

  document.querySelectorAll('.dup-keep-best').forEach((btn) => {
    btn.addEventListener('click', () => handleKeepBest(parseInt(btn.dataset.gi, 10)));
  });
  document.querySelectorAll('.dup-merge-selected').forEach((btn) => {
    btn.addEventListener('click', () => handleDupMerge(parseInt(btn.dataset.gi, 10)));
  });
  document.querySelectorAll('.dup-del-selected').forEach((btn) => {
    btn.addEventListener('click', () => handleDupDeleteSelected(parseInt(btn.dataset.gi, 10)));
  });
  document.querySelectorAll('.dup-copy-urls').forEach((btn) => {
    btn.addEventListener('click', () => handleDupCopyUrls(parseInt(btn.dataset.gi, 10)));
  });
  document.querySelectorAll('.dup-edit-mode').forEach((btn) => {
    btn.addEventListener('click', () => toggleDupEditMode(parseInt(btn.dataset.gi, 10)));
  });
}

// 刷新工具栏按钮状态
function refreshDupToolbar(gi) {
  const dupEl = document.querySelector(`.dup[data-dup-group="${gi}"]`);
  if (!dupEl) return;
  const checked = dupEl.querySelectorAll('.dup-cb:checked').length;
  const delBtn = dupEl.querySelector('.dup-del-selected');
  const mergeBtn = dupEl.querySelector('.dup-merge-selected');
  if (delBtn) delBtn.disabled = checked === 0;
  if (mergeBtn) mergeBtn.disabled = checked < 2;
}

// 获取某重复组的书签数据
function getDupGroupData(gi) {
  if (!reportData || !reportData.duplicates) return [];
  const urlGroups = reportData.duplicates.urlGroups || [];
  const redirectGroups = reportData.duplicates.redirectGroups || [];
  return [...urlGroups, ...redirectGroups][gi] || [];
}

// 收集组内勾选项的 {globalIdx, bookmark} 数据
function getCheckedDupItems(gi) {
  const dupEl = document.querySelector(`.dup[data-dup-group="${gi}"]`);
  if (!dupEl) return [];
  const group = getDupGroupData(gi);
  return Array.from(dupEl.querySelectorAll('.dup-cb:checked')).map((cb) => {
    const bi = parseInt(cb.closest('.dup-item')?.dataset.dupBi, 10);
    const globalIdx = parseInt(cb.dataset.globalIdx, 10);
    return { cb, li: cb.closest('.dup-item'), bi, globalIdx, bm: group[bi], reportBm: reportData?.bookmarks?.[globalIdx] };
  }).filter((x) => x.bm);
}

// ====== 保留最佳 ======
function handleKeepBest(gi) {
  const group = getDupGroupData(gi);
  if (!group.length) return;
  const dupEl = document.querySelector(`.dup[data-dup-group="${gi}"]`);
  const cbs = dupEl.querySelectorAll('.dup-cb');

  const scored = group.map((b, i) => ({
    idx: i, status: b.status || 'unknown', urlLen: (b.finalUrl || b.url).length,
  }));
  scored.sort((a, b) => {
    const sOrder = { valid: 0, login: 1, unknown: 2, dead: 3 };
    const sa = sOrder[a.status] ?? 99, sb = sOrder[b.status] ?? 99;
    if (sa !== sb) return sa - sb;
    return a.urlLen - b.urlLen;
  });

  cbs.forEach((cb) => (cb.checked = false));
  const bestCb = dupEl.querySelector(`.dup-cb[data-global-idx="${cbs[scored[0].idx].dataset.globalIdx}"]`);
  if (bestCb) bestCb.checked = true;

  showDupFeedback(gi, `已保留最佳：${esc(group[scored[0].idx].title || group[scored[0].idx].url)}，其余 ${group.length - 1} 条可删除。`, 'ok');
  refreshDupToolbar(gi);
}

// ====== 合并选中（写回Chrome）======
async function handleDupMerge(gi) {
  const items = getCheckedDupItems(gi);
  if (items.length < 2) return showDupFeedback(gi, '请至少勾选 2 条书签进行合并。', 'warn');

  const keep = items[0]; // 保留第一条
  const rest = items.slice(1); // 其余删除
  const titles = items.map((x) => esc(x.bm.title || x.bm.url));

  const confirmed = confirm(
    `⚠️ 即将合并以下 ${items.length} 条书签：\n\n` +
    titles.map((t, i) => (i === 0 ? '✓ 保留：' : '× 删除：') + t).join('\n') +
    `\n\n合并后仅保留「${keep.bm.title || keep.bm.url}」，其余将从 Chrome 书签文件中永久删除。\n\n此操作不可撤销！确定继续？`
  );
  if (!confirmed) return;

  showDupFeedback(gi, '正在写入 Chrome 书签文件…', 'warn');
  try {
    const resp = await fetch('/api/bookmarks/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'merge',
        ...currentScanSource, // 携带 browser+profile
        keep: { url: keep.bm.url, title: keep.bm.title, folder: keep.bm.folder },
        remove: rest.map((x) => ({ url: x.bm.url, title: x.bm.title, folder: x.bm.folder })),
      }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || '写入失败');

    // UI 更新：标记已删除项
    rest.forEach((x) => {
      x.li.classList.add('dup-deleted');
      x.li.style.opacity = '0.4';
      x.li.style.textDecoration = 'line-through';
      x.cb.disabled = true; x.cb.checked = false;
    });
    syncDupDeletionsToTable();
    showDupFeedback(gi, `✅ 已合并！保留「${esc(keep.bm.title)}」，已从 Chrome 删除 ${rest.length} 条。`, 'ok');
    refreshDupToolbar(gi);
  } catch (e) {
    showDupFeedback(gi, '❌ 写入失败：' + e.message, 'bad');
  }
}

// ====== 删除选中（写回Chrome）======
async function handleDupDeleteSelected(gi) {
  const items = getCheckedDupItems(gi);
  if (!items.length) return showDupFeedback(gi, '请先在组内勾选要删除的书签。', 'warn');

  const titles = items.map((x) => esc(x.bm.title || x.bm.url)).join('、');

  // 判断当前来源是否为同步账号
  let synced = false, runningProfile = false;
  if (currentScanSource && !currentScanSource.importId) {
    const v = `b|${currentScanSource.browser}|${currentScanSource.profile}`;
    const m = sourceMeta[v];
    synced = !!(m && m.hasAccount);
    runningProfile = !!(m && m.running);
  }

  // ---- 同步账号：走常驻扩展桥接（装一次即可永久生效）----
  if (synced) {
    startSyncedDelete(gi, items);
    return;
  }

  // ---- 非同步账号：走原来的改文件逻辑 ----
  const confirmed = confirm(
    `⚠️ 即将从 Chrome 书签中永久删除以下 ${items.length} 条书签：\n\n${titles}\n\n` +
    `此操作将直接修改 Chrome 的书签文件！\n` +
    `请确保：\n  ✓ Chrome 浏览器已完全关闭（包括后台进程）\n\n` +
    `确定继续？`
  );
  if (!confirmed) return;

  showDupFeedback(gi, '正在从 Chrome 删除书签…', 'warn');
  try {
    const resp = await fetch('/api/bookmarks/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'delete',
        ...currentScanSource,
        items: items.map((x) => ({ url: x.bm.url, title: x.bm.title, folder: x.bm.folder })),
      }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || '删除失败');

    items.forEach((x) => {
      x.li.classList.add('dup-deleted');
      x.li.style.opacity = '0.4';
      x.li.style.textDecoration = 'line-through';
      x.cb.disabled = true; x.cb.checked = false;
    });
    syncDupDeletionsToTable();

    let msg = `✅ 已从 Chrome 删除 ${items.length} 条书签。`;
    if (!data.verified) msg += '\n⚠️ 未能自动验证文件改动，请重启 Chrome 确认。';
    if (data.isSynced) msg += '\n\n📌 同步账号提醒：改动已写入本地文件，但 Chrome 若联网同步，云端旧数据可能把刚删的书签“复活”。';

    showDupFeedback(gi, msg, data.verified ? 'ok' : 'warn');
    refreshDupToolbar(gi);
  } catch (e) {
    showDupFeedback(gi, '❌ 删除失败：' + e.message, 'bad');
  }
}

// 同步删除状态到主表格
function syncDupDeletionsToTable() {
  document.querySelectorAll('.dup-item.dup-deleted').forEach((li) => {
    const globalIdx = li.dataset.globalIdx;
    if (globalIdx === undefined) return;
    const tr = document.querySelector(`#tbl tbody tr[data-idx="${globalIdx}"]`);
    if (!tr) return;
    tr.classList.add('row-deleted');
    tr.style.opacity = '0.4';
    tr.style.textDecoration = 'line-through';
    const cb = tr.querySelector('.bm-cb');
    if (cb) { cb.disabled = true; cb.checked = false; }
  });
  updateSelBar();
}

// ====== 复制 URL ======
async function handleDupCopyUrls(gi) {
  const group = getDupGroupData(gi);
  if (!group.length) return;
  const urls = group.map((b) => b.finalUrl || b.url).join('\n');
  try {
    await navigator.clipboard.writeText(urls);
    showDupFeedback(gi, `已复制 ${group.length} 个 URL 到剪贴板。`, 'ok');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = urls; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    showDupFeedback(gi, `已复制 ${group.length} 个 URL 到剪贴板。`, 'ok');
  }
}

// ====== 编辑模式（标题+URL）======
async function toggleDupEditMode(gi) {
  const dupEl = document.querySelector(`.dup[data-dup-group="${gi}"]`);
  const isEditing = dupEl.classList.toggle('dup-editing');
  const btn = dupEl.querySelector('.dup-edit-mode');
  btn.textContent = isEditing ? '💾 完成' : '✏ 编辑';

  if (isEditing) {
    // 进入编辑模式：标题和URL都变成 input
    dupEl.querySelectorAll('.dup-item').forEach((li) => {
      const body = li.querySelector('.dup-item-body');
      if (!body) return;
      const linkEl = body.querySelector('.dup-link');
      const urlLinkEl = body.querySelector('.dup-url-link');
      if (!linkEl) return;

      const origTitle = linkEl.textContent;
      const origHref = linkEl.getAttribute('href');
      const origUrl = urlLinkEl ? urlLinkEl.textContent : origHref;

      // 替换标题链接为 input
      linkEl.replaceWith(Object.assign(document.createElement('input'), {
        type: 'text', className: 'dup-edit-title', value: origTitle,
        placeholder: '书签标题', 'data-field': 'title',
        'data-orig': origTitle,
      }));

      // 替换 URL 链接为 input
      if (urlLinkEl) {
        urlLinkEl.replaceWith(Object.assign(document.createElement('input'), {
          type: 'text', className: 'dup-edit-url', value: origUrl,
          placeholder: 'https://...', 'data-field': 'url',
          'data-orig': origUrl,
        }));
      }

      // 隐藏状态标签和重定向信息（编辑时不需要）
      const statusTag = body.querySelector('.dup-status');
      if (statusTag) statusTag.style.display = 'none';
      const finalUrl = body.querySelector('.dup-final-url');
      if (finalUrl) finalUrl.style.display = 'none';
    });
  } else {
    // 退出编辑模式：收集变更 → 确认 → 写回Chrome
    const changes = []; // {globalIdx, oldTitle, newTitle, oldUrl, newUrl}
    let hasChange = false;

    dupEl.querySelectorAll('.dup-item').forEach((li) => {
      const body = li.querySelector('.dup-item-body');
      if (!body) return;

      const titleInput = body.querySelector('.dup-edit-title');
      const urlInput = body.querySelector('.dup-edit-url');
      if (!titleInput) return;

      const newTitle = titleInput.value.trim();
      const newUrl = (urlInput ? urlInput.value.trim() : '');
      const origTitle = titleInput.dataset.orig;
      const origUrl = urlInput ? urlInput.dataset.orig : '';
      const globalIdx = parseInt(li.dataset.globalIdx, 10);

      // 恢复为展示模式
      const titleA = Object.assign(document.createElement('a'), {
        href: newUrl || origUrl, target: '_blank', className: 'dup-link',
        textContent: newTitle || origTitle,
      });
      titleInput.replaceWith(titleA);

      if (urlInput) {
        const urlSpan = urlInput.closest('.dup-url');
        if (urlSpan) {
          const urlA = Object.assign(document.createElement('a'), {
            href: newUrl || origUrl, target: '_blank', className: 'dup-url-link',
            textContent: newUrl || origUrl,
          });
          urlInput.replaceWith(urlA);
        }
      }

      // 恢复隐藏的状态标签
      const statusTag = body.querySelector('.dup-status');
      if (statusTag) statusTag.style.display = '';
      const finalUrl = body.querySelector('.dup-final-url');
      if (finalUrl) finalUrl.style.display = '';

      if ((newTitle && newTitle !== origTitle) || (newUrl && newUrl !== origUrl)) {
        hasChange = true;
        changes.push({ globalIdx, oldTitle: origTitle, newTitle: newTitle || origTitle, oldUrl: origUrl, newUrl: newUrl || origUrl });
      }
    });

    if (!hasChange) { showDupFeedback(gi, '未做任何修改。', 'muted'); return; }

    // 有变更 → 弹确认 → 写回Chrome
    const changeSummary = changes.map((c) =>
      `「${esc(c.oldTitle)}」→ 标题:「${esc(c.newTitle)}」 URL:${c.oldUrl !== c.newUrl ? esc(c.oldUrl) + '→' + esc(c.newUrl) : '不变'}`
    ).join('\n');

    const confirmed = confirm(
      `📝 检测到 ${changes.length} 处修改：\n\n${changeSummary}\n\n` +
      `此操作将直接修改 Chrome 的 Bookmarks 文件！\n请确保 Chrome 浏览器已关闭。\n\n确定保存并写入 Chrome？`
    );
    if (!confirmed) {
      // 用户取消 → 回滚UI显示（重新渲染即可）
      showDupFeedback(gi, '已取消修改。', 'muted');
      return;
    }

    showDupFeedback(gi, '正在写入 Chrome 书签文件…', 'warn');
    try {
      const resp = await fetch('/api/bookmarks/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'edit',
          ...currentScanSource, // 携带 browser+profile
          changes: changes.map((c) => {
            const bm = reportData?.bookmarks?.[c.globalIdx];
            return { url: bm?.url || c.oldUrl, oldTitle: c.oldTitle, newTitle: c.newTitle, oldUrl: c.oldUrl, newUrl: c.newUrl, folder: bm?.folder || '' };
          }),
        }),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || '写入失败');

      // 同步更新 reportData 和主表格
      changes.forEach((c) => {
        if (reportData?.bookmarks?.[c.globalIdx]) {
          reportData.bookmarks[c.globalIdx].title = c.newTitle;
          if (c.newUrl !== c.oldUrl) reportData.bookmarks[c.globalIdx].url = c.newUrl;
          const tr = document.querySelector(`#tbl tbody tr[data-idx="${c.globalIdx}"]`);
          if (tr) {
            const bm = reportData.bookmarks[c.globalIdx];
            const sc = statusColor[bm.status] || '#6e7781';
            tr.cells[1].innerHTML = `<span class="dot" style="background:${sc}"></span>${esc(c.newTitle)}`;
            tr.cells[2].innerHTML = `<a href="${esc(c.newUrl)}" target="_blank">${esc(c.newUrl)}</a>`;
          }
        }
      });
      showDupFeedback(gi, `✅ 已保存 ${changes.length} 处修改并写入 Chrome。`, 'ok');
    } catch (e) {
      showDupFeedback(gi, '❌ 写入失败：' + e.message, 'bad');
    }
  }
}

// 显示反馈消息
function showDupFeedback(gi, msg, type) {
  const fb = document.querySelector(`.dup-feedback[data-fb-gi="${gi}"]`);
  if (!fb) return;
  fb.textContent = msg;
  fb.className = `dup-feedback dup-fb-${type || 'muted'}`;
  fb.style.display = 'block';
  clearTimeout(fb._timer);
  fb._timer = setTimeout(() => { fb.style.display = 'none'; }, 5000);
}

// ========== 同步账号删除：一次性临时扩展流程（弹窗） ==========
// 路线 A（自动）：服务端下载 Chrome for Testing → 临时重启浏览器加载一次性扩展 → 删 → 扩展自卸载 → 恢复浏览器
// 路线 B（引导式）：服务备好干净扩展目录，用户点一次「加载已解压的扩展程序」→ 自动删 → 扩展自卸载
// 终极回退：导出带复选框的删除清单 HTML，用户在书签管理器手动删

function payloadOf(items) { return items.map((x) => ({ url: x.bm.url, title: x.bm.title, folder: x.bm.folder })); }
function markDeleted(gi, items) {
  items.forEach((x) => {
    x.li.classList.add('dup-deleted');
    x.li.style.opacity = '0.4';
    x.li.style.textDecoration = 'line-through';
    x.cb.disabled = true; x.cb.checked = false;
  });
  syncDupDeletionsToTable();
  refreshDupToolbar(gi);
}
const sm = () => document.getElementById('syncedModal');
const smTitle = () => document.getElementById('smTitle');
const smBody = () => document.getElementById('smBody');
const smActions = () => document.getElementById('smActions');
let connTimer = null;
function openModal() { if (connTimer) { clearInterval(connTimer); connTimer = null; } sm().classList.remove('hidden'); }
function closeModal() { sm().classList.add('hidden'); }
function setModal(title, bodyHtml, busy) {
  smTitle().textContent = title;
  smBody().innerHTML = (busy ? '<div class="sm-spinner" aria-hidden="true"></div>' : '') + bodyHtml;
}
function modalBtn(label, onClick, disabled, primary) {
  const b = document.createElement('button');
  b.className = 'btn' + (primary ? ' primary' : '');
  b.textContent = label;
  b.disabled = !!disabled;
  if (onClick) b.addEventListener('click', onClick);
  smActions().appendChild(b);
  return b;
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch { return false; }
}

// 入口：同步账号删除（常驻扩展：装一次永久生效）
function startSyncedDelete(gi, items) {
  openModal();
  checkAndProceed(gi, items);
}

// 先判断扩展是否已连接：已连直接删；未连先弹「原因说明」
// 首次检查会重试一次（扩展 service worker 可能休眠，需唤醒）
async function checkAndProceed(gi, items) {
  setModal('检测扩展连接…', '<p>正在检查随附扩展是否已安装并连接…</p>', true);
  smActions().innerHTML = '';
  let connected = false;
  // 首次尝试
  try { const r = await fetch('/api/ext/status', { cache: 'no-store' }); const j = await r.json(); connected = !!j.connected; } catch {}
  // 若未连，等 2 秒再试（给 service worker 唤醒时间）
  if (!connected) {
    await new Promise((r) => setTimeout(r, 2000));
    try { const r = await fetch('/api/ext/status', { cache: 'no-store' }); const j = await r.json(); connected = !!j.connected; } catch {}
  }
  if (connected) { await doDelete(gi, items); return; }
  showReasonThenInstall(gi, items);
}

// 第一屏：说明为什么必须装扩展（原因）+ 是否安全
// 若扩展已连接则自动跳过此屏直接删；否则显示说明并持续检测连接状态
function showReasonThenInstall(gi, items) {
  openModal();
  smActions().innerHTML = '';
  const reasonBody = `
    <p>你勾选删除的是 <b>同步账号书签</b>（跟随 Google 账号，存于 <code>AccountBookmarks</code>）。</p>
    <p><b>为什么不能直接删文件？</b></p>
    <ul class="synced-list">
      <li>同步账号的云端是"权威"。直接改本机书签文件，Chrome 下次联网会把删除<b>覆盖回来</b>，书签"复活"。</li>
      <li>唯一可靠的办法是经 Chrome 官方 <code>chrome.bookmarks</code> 接口删除——它会作为"墓碑"同步上云，书签不再回来。</li>
      <li>而这个官方接口<b>只有扩展（extension）才能调用</b>，普通程序无法直接调用。</li>
    </ul>
    <p><b>这个扩展做了什么 / 安全吗？</b></p>
    <ul class="synced-list">
      <li>它<b>只</b>在本机 Chrome 打开时，听本地工具（127.0.0.1）的删除指令，调用官方接口删除。</li>
      <li>不做任何网络上报、不上传你的书签。</li>
      <li>你随时可在 <code>chrome://extensions</code> 一键关闭或移除。</li>
      <li>只需安装<b>一次</b>，之后删除同步书签全自动，无需每次下载大文件或重启浏览器。</li>
    </ul>
    <p class="muted" id="reasonStatus">点"我明白了，去安装"继续；若不想安装，也可选择导出删除清单、在 Chrome 书签管理器里手动删。</p>
  `;
  setModal('为什么需要先安装一个扩展', reasonBody, false);
  modalBtn('我明白了，去安装', () => { if (connTimer) { clearInterval(connTimer); connTimer = null; } showInstall(gi, items); }, false, true);
  modalBtn('改用清单手动删', () => { if (connTimer) { clearInterval(connTimer); connTimer = null; } showChecklist(gi, items); });

  // 持续检测扩展是否已连接——若用户实际上已经装好了扩展（或扩展刚唤醒），
  // 自动跳过说明屏直接进入删除，避免重复看说明。
  connTimer = setInterval(async () => {
    let c = false;
    try { const r = await fetch('/api/ext/status', { cache: 'no-store' }); const j = await r.json(); c = !!j.connected; } catch {}
    const st = document.getElementById('reasonStatus');
    if (c) {
      if (st) st.innerHTML = '<span style="color:#1a7f37;font-weight:600">✅ 检测到扩展已连接！正在跳转到删除…</span>';
      clearInterval(connTimer); connTimer = null;
      setTimeout(() => doDelete(gi, items), 600);
    }
  }, 2000);
}

// 第二屏：安装指引（只需一次），并轮询连接状态
function showInstall(gi, items) {
  openModal();
  smActions().innerHTML = '';
  setModal('安装随附扩展（一次即可，永久生效）', `
    <ol>
      <li>点下方「⬇ 下载扩展包」，得到 <code>bookmark-cleaner-extension.zip</code>。</li>
      <li>解压到一个你自己的文件夹（如 <code>~/Desktop/bm-ext</code>）。若系统提示“已隔离”，在该文件夹上右键 → 显示简介 → 底部「扩展属性」点【移除】；或在终端执行 <code>xattr -dr com.apple.quarantine ~/Desktop/bm-ext</code>。</li>
      <li>打开 Chrome，访问 <code>chrome://extensions</code>，右上角打开「开发者模式」。</li>
      <li>点「加载已解压的扩展程序」，选择解压出的 <code>bm-ext</code> 文件夹。</li>
      <li>扩展出现即启用——本工具会自动检测到连接（下方状态变绿），即可一键删除。</li>
    </ol>
    <p class="muted">连接状态：<b id="installConn">检测中…</b></p>
    <p class="muted">扩展仅在 Chrome 打开时听本地工具的删除指令；随时可在 chrome://extensions 关闭/删除。</p>
  `, false);
  modalBtn('⬇ 下载扩展包', () => { window.location.href = '/api/ext/download'; });
  modalBtn('复制扩展地址', async () => {
    const ok = await copyText('chrome://extensions');
    if (ok) flashBtn(event.target, '已复制 ✓ 请粘贴到地址栏');
    else alert('请手动在 Chrome 地址栏输入：chrome://extensions');
  });
  const startBtn = modalBtn('开始删除', () => doDelete(gi, items), true, true);
  connTimer = setInterval(async () => {
    let c = false;
    try { const r = await fetch('/api/ext/status', { cache: 'no-store' }); const j = await r.json(); c = !!j.connected; } catch {}
    const el = document.getElementById('installConn');
    if (el) el.textContent = c ? '已连接 ✓' : '未连接';
    if (startBtn) startBtn.disabled = !c;
  }, 1500);
}

// 执行删除（已确认扩展连接）
async function doDelete(gi, items) {
  if (connTimer) { clearInterval(connTimer); connTimer = null; }
  setModal('正在通过 Chrome 官方接口删除…', `<p>扩展已连接，正在获取书签树并执行删除…</p><p class="muted" id="delProgress">正在调用扩展接口…</p>`, true);
  smActions().innerHTML = '';
  try {
    const resp = await fetch('/api/delete-synced', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...currentScanSource, items: payloadOf(items) }),
    });
    const data = await resp.json();
    if (data.ok) showSuccess(gi, items, data);
    else if (data.code === 'NO_EXT') showReasonThenInstall(gi, items);
    else {
      // 构建带诊断信息的错误消息
      let msg = data.error || data.message || '删除失败';
      if (data.diag) {
        const d = data.diag;
        const parts = [];
        if (d.lastSeenAgoSec !== undefined) parts.push(`扩展最后活跃：${d.lastSeenAgoSec < 0 ? '从未' : d.lastSeenAgoSec + '秒前'}`);
        if (d.failedAfterMs) parts.push(`耗时：${Math.round(d.failedAfterMs / 1000)}秒后超时`);
        if (d.activeWaiters !== undefined) parts.push(`活跃等待数：${d.activeWaiters}`);
        if (d.queueLen !== undefined) parts.push(`命令队列：${d.queueLen}`);
        if (d.treeTookMs) parts.push(`getTree 耗时：${d.treeTookMs}ms`);
        if (parts.length) msg += '\n\n诊断信息：\n' + parts.join(' | ');
      }
      showChecklist(gi, items, msg + (data.notFound ? `\n（${data.notFound} 条未匹配）` : ''));
    }
  } catch (e) {
    showChecklist(gi, items, '删除失败：' + e.message);
  }
}

function showSuccess(gi, items, data) {
  openModal();
  setModal('✅ 删除完成', `<p>${esc(data.message || '已删除同步书签。')}</p>
    <p class="muted">随附扩展仍常驻于你的 Chrome（只听本机工具指令）。以后删除同步书签会自动生效；不需要时可在 chrome://extensions 移除。</p>`, false);
  smActions().innerHTML = '';
  modalBtn('完成', () => { closeModal(); markDeleted(gi, items); }, false, true);
}

function showChecklist(gi, items, reason) {
  openModal();
  const fmtFolder = (b) => (Array.isArray(b.folder) ? b.folder.join(' > ') : (b.folder || '（未知位置）'));
  const rows = items.map((x) => `<li><b>${esc(x.bm.title || x.bm.url)}</b><br><span class="dup-folder-path">📁 ${esc(fmtFolder(x.bm))}</span></li>`).join('');
  setModal('手动删除清单（最终回退）', `<p>${esc(reason || '')}</p>
    <p>以上为待删除的同步书签。在 Chrome 书签管理器（<a href="chrome://bookmarks" target="_blank" rel="noopener">chrome://bookmarks</a>）中逐条删除即可——同步开启时删除会同步上云成为“墓碑”，不会“复活”。</p>
    <ul class="synced-list">${rows}</ul>`, false);
  smActions().innerHTML = '';
  modalBtn('⬇ 导出删除清单(HTML)', () => exportDeleteChecklist(gi, items));
  modalBtn('复制清单', async () => {
    const t = items.map((x) => `- ${x.bm.title || x.bm.url}  [${fmtFolder(x.bm)}]`).join('\n');
    if (await copyText('请在 Chrome 书签管理器（chrome://bookmarks）中删除以下书签：\n' + t)) flashBtn(event.target, '已复制 ✓');
  });
  modalBtn('关闭', () => closeModal(), false, true);
}

function flashBtn(btn, txt) { if (btn && btn.textContent !== undefined) { const o = btn.textContent; btn.textContent = txt; setTimeout(() => { btn.textContent = o; }, 1500); } }

// 导出一份自带复选框的删除清单 HTML（勾一项划一项，可打印/保存留底）
function exportDeleteChecklist(gi, items) {
  const fmtFolder = (b) => (Array.isArray(b.folder) ? b.folder.join(' > ') : (b.folder || '（未知位置）'));
  let sourceLabel = 'Chrome';
  if (currentScanSource && !currentScanSource.importId) {
    const m = sourceMeta[`b|${currentScanSource.browser}|${currentScanSource.profile}`];
    if (m && m.browserLabel) sourceLabel = m.browserLabel;
  }
  const list = items.map((x) => ({
    title: x.bm.title || x.bm.url || '（无标题）',
    url: x.bm.url || '',
    folder: fmtFolder(x.bm),
  }));
  const dataJson = JSON.stringify(list).replace(/<\//g, '<\\/');
  const dateStr = new Date().toLocaleString('zh-CN');
  const safe = (sourceLabel || 'chrome').replace(/[^\w\u4e00-\u9fa5-]/g, '_');
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>书签删除清单 - ${esc(sourceLabel)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 780px; margin: 24px auto; padding: 0 16px; color: #1f2328; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #656d76; font-size: 13px; margin-bottom: 12px; }
  .hint { font-size: 13px; color: #533f03; background: #fff8c5; border: 1px solid #d4a72c; border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; line-height: 1.5; }
  .progress { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px; padding: 10px 14px; margin-bottom: 14px; font-size: 14px; display: flex; align-items: center; gap: 12px; }
  .bar { flex: 1; height: 10px; background: #eaeef2; border-radius: 6px; overflow: hidden; }
  .bar > i { display: block; height: 100%; width: 0; background: #2da44e; transition: width .2s; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid #eaeef2; border-radius: 8px; margin-bottom: 8px; }
  li.done { background: #f6f8fa; }
  li.done .t { text-decoration: line-through; color: #8b949e; }
  li.done .u a { text-decoration: line-through; }
  input[type=checkbox] { width: 18px; height: 18px; margin-top: 2px; flex: none; cursor: pointer; }
  .t { font-weight: 600; }
  .f { font-size: 12px; color: #656d76; margin-top: 2px; }
  .u { font-size: 12px; margin-top: 2px; }
  .u a { color: #0969da; word-break: break-all; }
  .actions { position: sticky; bottom: 12px; display: flex; gap: 10px; margin-top: 18px; }
  button { font-size: 14px; padding: 9px 16px; border-radius: 8px; border: 1px solid #d0d7de; background: #fff; cursor: pointer; }
  button.primary { background: #0969da; color: #fff; border-color: #0969da; }
  button.primary:disabled { background: #8b949e; border-color: #8b949e; cursor: default; }
  @media print { .actions { display: none; } body { margin: 0; } li { break-inside: avoid; } }
</style>
</head>
<body>
  <h1>书签删除清单</h1>
  <div class="meta">来源：${esc(sourceLabel)} ｜ 生成时间：${dateStr} ｜ 共 ${list.length} 条</div>
  <div class="hint">同步账号书签请保持 Google 同步开启，在 Chrome 书签管理器（chrome://bookmarks）中逐条删除。删除会同步上云成为“墓碑”，书签不会“复活”。每在 Chrome 里删掉一条，就在此页勾掉一条；全部勾完即可打印 / 另存为 PDF 留底。</div>
  <div class="progress">
    <span id="pcount">已完成 0 / 共 ${list.length}</span>
    <span class="bar"><i id="pbar"></i></span>
  </div>
  <ul id="list"></ul>
  <div class="actions">
    <button class="primary" id="allDone" disabled>全部完成（可打印 / 保存留底）</button>
    <button id="printBtn">🖨 打印 / 另存为 PDF</button>
  </div>
<script>
  const DATA = ${dataJson};
  const ul = document.getElementById('list');
  const pcount = document.getElementById('pcount');
  const pbar = document.getElementById('pbar');
  const allDone = document.getElementById('allDone');
  DATA.forEach((it, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<input type="checkbox" data-i="' + i + '"><div><div class="t"></div><div class="f"></div><div class="u"></div></div>';
    li.querySelector('.t').textContent = it.title;
    li.querySelector('.f').textContent = '📁 ' + it.folder;
    const u = li.querySelector('.u');
    if (it.url) { const a = document.createElement('a'); a.href = it.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = it.url; u.appendChild(a); }
    else u.textContent = '（无网址）';
    ul.appendChild(li);
    li.querySelector('input').addEventListener('change', (e) => { li.classList.toggle('done', e.target.checked); update(); });
  });
  function update() {
    const total = DATA.length, done = ul.querySelectorAll('input:checked').length;
    pcount.textContent = '已完成 ' + done + ' / 共 ' + total;
    pbar.style.width = (total ? (done / total * 100) : 0) + '%';
    allDone.disabled = done < total;
  }
  allDone.addEventListener('click', () => { if (!allDone.disabled) window.print(); });
  document.getElementById('printBtn').addEventListener('click', () => window.print());
</script>
</body>
</html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `书签删除清单_${safe}_${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  showDupFeedback(gi, `✅ 已导出删除清单 HTML（${list.length} 条），请在下载文件中逐条勾选删除。`, 'ok');
}

// ========== 选择框与批量操作 ==========

// 表头「全选」勾选（仅作用于已渲染行；分页下通过加载更多逐步覆盖）
$('#tblCheckAll').addEventListener('change', () => {
  const v = $('#tblCheckAll').checked;
  document.querySelectorAll('.bm-cb').forEach((cb) => (cb.checked = v));
  updateSelBar();
});
// 加载更多
$('#loadMore').addEventListener('click', () => appendRowChunk());

function updateSelBar() {
  const checked = document.querySelectorAll('.bm-cb:checked');
  const total = document.querySelectorAll('.bm-cb').length;
  $('#selCount').textContent = checked.length;
  $('#selectionBar').classList.toggle('hidden', total === 0);
  const delBtn = $('#selDel');
  if (delBtn) delBtn.disabled = checked.length === 0;
  $('#tblCheckAll').checked = total > 0 && checked.length === total;
  // 半选状态（可选优化：indeterminate）
  if (total > 0 && checked.length > 0 && checked.length < total) {
    $('#tblCheckAll').indeterminate = true;
  } else {
    $('#tblCheckAll').indeterminate = false;
  }
}

// 获取当前选中的书签索引列表
function selectedIndices() {
  return Array.from(document.querySelectorAll('.bm-cb:checked')).map((cb) => parseInt(cb.dataset.idx, 10));
}

// 获取选中的书签数据
function selectedBookmarks() {
  if (!reportData) return [];
  return selectedIndices().map((i) => reportData.bookmarks[i]).filter(Boolean);
}

// 全选
$('#selAllBms').addEventListener('click', () => { document.querySelectorAll('.bm-cb').forEach((cb) => (cb.checked = true)); updateSelBar(); });

// 全不选
$('#selNoneBms').addEventListener('click', () => { document.querySelectorAll('.bm-cb').forEach((cb) => (cb.checked = false)); updateSelBar(); });

// 仅选失效（dead 状态的行）
$('#selDeadOnly').addEventListener('click', () => {
  document.querySelectorAll('.bm-cb').forEach((cb) => {
    const idx = parseInt(cb.dataset.idx, 10);
    const bm = reportData?.bookmarks?.[idx];
    cb.checked = bm?.status === 'dead';
  });
  updateSelBar();
});

// 批量打开选中链接
$('#selOpen').addEventListener('click', () => {
  const bms = selectedBookmarks();
  if (!bms.length) return alert('请先选择要打开的书签。');
  bms.forEach((b) => window.open(b.url, '_blank'));
});

// 删除选中的书签（主表）：同步账号走扩展桥、本地账号走改文件
async function deleteSelectedBookmarks() {
  const indices = selectedIndices();
  const bms = selectedBookmarks();
  if (!bms.length) return alert('请先勾选要删除的书签。');

  // 导入来源（CSV/HTML）不在 Chrome 中，无法回写到浏览器删除
  if (currentScanSource && currentScanSource.importId) {
    return alert('当前来源为导入文件，书签不在浏览器中，无法通过本工具删除。请在导入前于来源处处理，或导出清单手动处理。');
  }

  const synced = (() => {
    if (!currentScanSource) return false;
    const m = sourceMeta[`b|${currentScanSource.browser}|${currentScanSource.profile}`];
    return !!(m && m.hasAccount);
  })();

  // 同步账号：复用扩展桥接弹窗（装一次永久生效）。把主表行元素包进 item，
  // 使 markDeleted 能直接给对应 <tr> 描删除线并禁用勾选框，无需改动弹窗逻辑。
  if (synced) {
    const wrapped = indices.map((i) => {
      const tr = document.querySelector(`#tbl tbody tr[data-idx="${i}"]`);
      const cb = tr ? tr.querySelector('.bm-cb') : null;
      return { bm: bms[indices.indexOf(i)], li: tr, cb };
    });
    startSyncedDelete(null, wrapped);
    return;
  }

  // 非同步：直接改 Chrome 书签文件
  const titles = bms.map((b) => (b.title || b.url)).join('、');
  const confirmed = confirm(
    `⚠️ 即将从 Chrome 书签中永久删除以下 ${bms.length} 条书签：\n\n${titles}\n\n` +
    `此操作将直接修改 Chrome 的书签文件！\n请确保：\n  ✓ Chrome 浏览器已完全关闭（包括后台进程）\n\n确定继续？`
  );
  if (!confirmed) return;

  try {
    const resp = await fetch('/api/bookmarks/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'delete',
        ...currentScanSource,
        items: bms.map((b) => ({ url: b.url, title: b.title, folder: b.folder })),
      }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || '删除失败');

    indices.forEach((i) => {
      const tr = document.querySelector(`#tbl tbody tr[data-idx="${i}"]`);
      if (!tr) return;
      tr.classList.add('row-deleted');
      tr.style.opacity = '0.4';
      tr.style.textDecoration = 'line-through';
      const cb = tr.querySelector('.bm-cb');
      if (cb) { cb.disabled = true; cb.checked = false; }
    });
    updateSelBar();
    alert(`✅ 已从 Chrome 删除 ${bms.length} 条书签。` + (data.verified ? '' : '\n⚠️ 未能自动验证文件改动，请重启 Chrome 确认。'));
  } catch (e) {
    alert('❌ 删除失败：' + e.message);
  }
}
$('#selDel').addEventListener('click', deleteSelectedBookmarks);

// ====== 移动选中书签到其他文件夹（写回 Chrome，需随附扩展） ======
// 弹窗选择目标文件夹（从文件夹树选取），确认后调用 /api/move-synced
function moveSelectedBookmarks() {
  const bms = selectedBookmarks();
  if (!bms.length) return alert('请先勾选要移动的书签。');
  if (currentScanSource && currentScanSource.importId) {
    return alert('当前来源为导入文件，书签不在浏览器中，无法通过本工具移动。请在浏览器书签管理器中整理。');
  }
  // 扩展必须已连接（移动要写回 Chrome）
  const el = document.getElementById('extStatus');
  if (el && el.className.indexOf('ext-on') < 0) {
    return alert('移动书签需要「随附扩展」已连接（用于写回 Chrome）。\n请先安装并启用随附扩展（书签清理助手），等待顶部状态变为"已连接 ✓"。');
  }
  openMoveDialog(bms);
}

// 弹出目标文件夹选择弹窗（树形可折叠列表）
function openMoveDialog(bms) {
  const m = _msgModal();
  const title = m.querySelector('#msgTitle');
  const body = m.querySelector('#msgBody');
  const actions = m.querySelector('#msgActions');
  title.textContent = `移动 ${bms.length} 个书签到…`;
  body.innerHTML = '<p style="margin-bottom:8px;font-size:13px;color:#57606a">选择目标文件夹（Chrome 中真实生效）：</p>'
    + '<input id="moveFolderFilter" type="text" placeholder="搜索/过滤文件夹（输入关键词过滤树）" autocomplete="off" style="width:100%;padding:7px 10px;border:1px solid #d0d7de;border-radius:6px;font-size:13px;box-sizing:border-box;margin-bottom:6px;" />'
    + '<div id="moveFolderList" style="max-height:320px;overflow-y:auto;border:1px solid #d0d7de;border-radius:8px;padding:6px;"></div>'
    + '<p style="margin-top:8px;font-size:12px;color:#8b949e">选中的书签会移动到该文件夹，位置随 Chrome 同步。</p>';
  actions.innerHTML = '';
  const cancel = document.createElement('button');
  cancel.className = 'btn ghost';
  cancel.textContent = '取消';
  cancel.onclick = () => { m.classList.add('hidden'); };
  actions.appendChild(cancel);
  const ok = document.createElement('button');
  ok.className = 'btn primary';
  ok.textContent = '移动到这里';
  ok.disabled = true;
  ok.onclick = async () => {
    const selPath = document.querySelector('.move-folder-item.selected')?.dataset.path;
    if (!selPath) return;
    m.classList.add('hidden');
    await doMoveBookmarks(bms, selPath);
  };
  actions.appendChild(ok);

  // 加载文件夹树
  const list = body.querySelector('#moveFolderList');
  const filterInput = body.querySelector('#moveFolderFilter');
  list.innerHTML = '<p class="muted" style="padding:12px">正在加载文件夹…</p>';
  loadMoveFolders(list, bms, ok);
  // 过滤输入：按 path / title 包含匹配（不区分大小写），保留所有匹配节点及其父链
  filterInput.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    const items = list.querySelectorAll('.move-folder-item');
    if (!q) { items.forEach(i => i.style.display = ''); return; }
    // 简化：直接按 textContent 包含关键词（树形结构相对简单够用）
    items.forEach(i => {
      const matches = i.textContent.toLowerCase().includes(q) || (i.dataset.path || '').toLowerCase().includes(q);
      i.style.display = matches ? '' : 'none';
    });
  });
  setTimeout(() => filterInput.focus(), 50);
  m.classList.remove('hidden');
}

async function loadMoveFolders(list, bms, okBtn) {
  try {
    // 检查扩展连接（移动要写回 Chrome）
    const extEl = document.getElementById('extStatus');
    if (extEl && extEl.className.indexOf('ext-on') < 0) {
      list.innerHTML = '<p class="muted" style="padding:12px;color:#cf222e">扩展未连接，无法读取 Chrome 实时文件夹。请确认顶部状态为「已连接 ✓」再试。</p>';
      return;
    }
    // 直接用扩展的 getFolders —— 与后端 moveViaExtension 用同一份数据，绝对一致
    const r = await fetch('/api/extension-folders', { cache: 'no-store' });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || '加载失败');
    // 扩展返回的 folders 是扁平数组 [{id,title,path:'A / B / C'}, ...]，需要构建成树形 UI
    const flat = d.folders || [];
    if (!flat.length) {
      list.innerHTML = '<p class="muted" style="padding:12px">未找到任何文件夹。请确认已选择书签来源并扫描。</p>';
      return;
    }
    // 按 path 长度从短到长构建：把每个 folder 挂到它的父级 path 下
    const sorted = flat.slice().sort((a, b) => (a.path.split(' / ').length) - (b.path.split(' / ').length));
    const nodeByPath = new Map();
    const roots = [];
    for (const f of sorted) {
      const parts = f.path.split(' / ');
      const node = { id: f.id, title: f.title, name: f.title, path: parts.slice(), children: [] };
      nodeByPath.set(f.path, node);
      const parentPath = parts.slice(0, -1).join(' / ');
      if (parentPath && nodeByPath.has(parentPath)) {
        nodeByPath.get(parentPath).children.push(node);
      } else {
        roots.push(node);
      }
    }
    list.innerHTML = '';
    let selected = null;
    const walk = (nodes, prefix) => {
      nodes.forEach((n) => {
        const item = document.createElement('div');
        item.className = 'move-folder-item' + (n.children && n.children.length ? ' has-children' : '');
        const indent = prefix ? 'padding-left:' + (10 + prefix * 14) + 'px;' : '';
        const path = n.path.join(' / ');
        item.dataset.path = path;
        item.dataset.id = n.id;
        item.style.cssText += indent;
        item.innerHTML = (n.children && n.children.length ? '📁 ' : '📂 ') + `<span>${esc(n.title)}</span>`;
        item.onclick = () => {
          if (selected) selected.classList.remove('selected');
          item.classList.add('selected');
          selected = item;
          okBtn.disabled = false;
        };
        list.appendChild(item);
        if (n.children && n.children.length) walk(n.children, prefix + 1);
      });
    };
    walk(roots, 0);
  } catch (e) {
    list.innerHTML = '<p class="muted" style="padding:12px;color:#cf222e">加载文件夹失败：' + esc(e.message) + '</p>';
  }
}

async function doMoveBookmarks(bms, targetFolderPath) {
  const btn = document.getElementById('selMove');
  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ 移动中…';
  try {
    const items = bms.map(b => ({ url: b.url, title: b.title }));
    // 路径标准化：trim + NFC + 合并空格（与后端 normPath 一致）
    const normalizedPath = String(targetFolderPath || '').trim().normalize('NFC').replace(/\s+/g, ' ');
    const r = await fetch('/api/move-synced', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, targetFolderPath: normalizedPath }),
    });
    const d = await r.json();
    if (d.ok) {
      alert(d.message || '✅ 移动完成');
    } else {
      alert(d.error || '移动失败');
      if (d.code === 'NO_EXT') alert('未检测到随附扩展。请在 chrome://extensions 启用「书签清理助手（本地桥）」后重试。');
    }
  } catch (e) {
    console.error('[move] ERR', e);
    alert('移动失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
}
$('#selMove').addEventListener('click', moveSelectedBookmarks);

// 导出选中
$('#selExport').addEventListener('click', async () => {
  const ids = selectedIndices();
  if (!ids.length) return alert('请先选择要导出的书签。');
  const fmt = $('#selExportFmt').value;
  try {
    const resp = await fetch('/api/export-selected', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, format: fmt }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || '导出失败');
    // 触发下载
    const a = document.createElement('a');
    a.href = data.url;
    a.download = data.filename;
    a.click();
  } catch (e) {
    alert('导出错误：' + e.message);
  }
});

// 同步修改到 Chrome（批量写回标题/URL）
$('#syncUpdates').addEventListener('click', syncPendingUpdates);

// ====== Safari 书签导出（最简方案）：导出到下载目录 + 提示手动导入步骤 ======
$('#safariImport').addEventListener('click', async () => {
  const btn = $('#safariImport');
  btn.disabled = true;
  btn.textContent = '正在导出…';
  try {
    const r = await fetch('/api/safari/export', { method: 'POST' });
    const d = await r.json();
    if (!d.ok) {
      alert(d.error || '导出失败');
      return;
    }
    // 复制文件路径到剪贴板，方便用户粘贴
    const copyOk = await copyText(d.file).catch(() => false);
    alert(
      d.message +
      '\n\n（文件路径已' + (copyOk ? '复制到剪贴板' : '显示在上方，可手动复制') + '）'
    );
  } catch (e) {
    console.error('[safari-export] ERR', e);
    alert('导出失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🍎 导出 Safari 书签';
  }
});
// 展示待同步数量（render 时刷新）
function refreshPendingCount() {
  const n = loadPending().length;
  $('#pendingCount').textContent = n ? `（${n} 条待同步）` : '';
}
setInterval(refreshPendingCount, 2000);
refreshPendingCount();

// ====== 随附扩展连接状态（轮询）======
// ====== 智能轮询：扩展连接状态 ======
// 启动后头 30 秒高频（1.5s）探测扩展注册，之后降到稳态（5s）。
// 避免 setInterval 固定 10s 带来的最长 10 秒等待感。
// 同时显示"检测中…"中间态，避免用户误以为程序卡住。
let _extFirstPollAt = 0;        // 第一次发起轮询的时间戳，用于切阶段
let _extLastConnected = false;   // 上一次的连接状态，避免重复刷新 DOM
let _extPollTimer = null;
let _extInFlight = false;
async function updateExtStatus() {
  const el = document.getElementById('extStatus');
  if (!el) return;
  if (_extInFlight) return; // 防止并发请求堆积
  _extInFlight = true;
  try {
    // 第一次拉取时显示"检测中"，让用户知道程序在等扩展注册
    if (_extFirstPollAt === 0) {
      _extFirstPollAt = Date.now();
      el.textContent = '随附扩展：检测中…';
      el.className = 'ext-status ext-checking';
    }
    const r = await fetch('/api/ext/status', { cache: 'no-store' });
    const j = await r.json();
    if (j.connected) {
      el.textContent = '随附扩展：已连接 ✓';
      el.className = 'ext-status ext-on';
      _extLastConnected = true;
    } else {
      el.textContent = '随附扩展：未连接';
      el.className = 'ext-status ext-off';
      _extLastConnected = false;
    }
  } catch {
    if (el.className.indexOf('ext-on') < 0) {
      el.textContent = '随附扩展：未连接';
      el.className = 'ext-status ext-off';
    }
  } finally {
    _extInFlight = false;
  }
}
function scheduleNextExtPoll() {
  // 启动 30 秒内高频（1.5s）以快速探测；之后稳态（5s）。这是简单分段线性退避。
  const FAST_MS = 1500;
  const STEADY_MS = 5000;
  const FAST_WINDOW = 30000;
  const elapsed = Date.now() - (_extFirstPollAt || Date.now());
  const interval = elapsed < FAST_WINDOW ? FAST_MS : STEADY_MS;
  _extPollTimer = setTimeout(async () => {
    await updateExtStatus();
    scheduleNextExtPoll();
  }, interval);
}
function startExtStatusPolling() {
  if (_extPollTimer) return;
  updateExtStatus();
  scheduleNextExtPoll();
}

// 表格内交互（点击状态/标题/URL）—— 委托到 #tbl tbody，新插入的行自动生效
function bindTableInteractions() {
  const tbody = $('#tbl tbody');
  if (!tbody) { console.warn('[bind] no tbody'); return; }
  if (tbody._bmBound) { console.log('[bind] already bound'); return; }
  tbody._bmBound = true;
  tbody.addEventListener('click', async (e) => {
    console.log('[tbody-click] target=', e.target.tagName, e.target.className);
    const cell = e.target.closest('.status-cell');
    if (cell) {
      e.preventDefault(); e.stopPropagation();
      const idx = parseInt(cell.dataset.idx, 10);
      const bm = bms[idx];
      if (!bm) { console.warn('[status-click] bms[' + idx + '] undefined'); return; }
      const url = bm.url;
      const manual = getManualStatus(url);
      const cur = manual || bm.status;
      console.log('[status-click]', url, 'cur=' + cur, 'manual=' + manual);
      let next;
      if (e.shiftKey && manual) next = null;
      else if (cur === 'suspect') next = 'valid';
      else if (cur === 'valid') next = 'dead';
      else if (cur === 'dead') next = 'valid';
      else next = 'valid';
      try {
        setManualStatus(url, next);
        render(reportData, false);
        console.log('[status-click] OK -> ' + next);
      } catch (err) {
        console.error('[status-click] ERR', err);
        alert('状态切换失败：' + err.message);
      }
      return;
    }
    const t = e.target.closest('.title-cell, .title-edit');
    if (t) {
      e.preventDefault(); e.stopPropagation();
      const idx = parseInt(t.dataset.idx, 10);
      const bm = bms[idx];
      if (!bm) return;
      console.log('[title-click]', bm.url, bm.title);
      const newTitle = await showPrompt('修改标题：', bm.title, { title: '修改标题' });
      if (newTitle == null || newTitle === bm.title) { console.log('[title-click] cancelled'); return; }
      const oldTitle = bm.title;
      bm.title = newTitle.trim() || bm.title;
      // 同步到 reportData.bookmarks
      if (reportData && reportData.bookmarks) {
        const live = reportData.bookmarks.find(x => x.url === bm.url && x.title === oldTitle);
        if (live) live.title = bm.title;
      }
      // 加入待同步队列（供"同步修改到 Chrome"批量写回）
      addPendingUpdate({ url: bm.url, oldTitle, newTitle: bm.title });
      try { render(reportData, false); console.log('[title-click] OK'); }
      catch (err) { console.error('[title-click] ERR', err); alert('标题修改失败：' + err.message); }
      return;
    }
    const u = e.target.closest('.url-edit');
    if (u) {
      e.preventDefault(); e.stopPropagation();
      const idx = parseInt(u.dataset.idx, 10);
      const bm = bms[idx];
      if (!bm) return;
      console.log('[url-click]', bm.url);
      const newUrl = await showPrompt('修改 URL：', bm.url, {
        title: '修改 URL',
        validate: (v) => { try { new URL(v); return true; } catch { return 'URL 格式非法（需包含 http:// 或 https://）'; } },
      });
      if (newUrl == null || newUrl === bm.url) { console.log('[url-click] cancelled'); return; }
      const oldUrl = bm.url;
      bm.url = newUrl.trim();
      if (reportData && reportData.bookmarks) {
        const live = reportData.bookmarks.find(x => x.url === oldUrl);
        if (live) live.url = bm.url;
      }
      // 清除旧 URL 的 manual 状态（URL 变了旧 manual 没意义）
      const m = loadManual();
      if (m[bm.url] === undefined) delete m[oldUrl];
      saveManual(m);
      // 加入待同步队列
      addPendingUpdate({ url: oldUrl, oldUrl, newUrl: bm.url, oldTitle: bm.title });
      try { render(reportData, false); console.log('[url-click] OK'); }
      catch (err) { console.error('[url-click] ERR', err); alert('URL 修改失败：' + err.message); }
    }
  });
}

// ====== 同步修改到 Chrome（批量写回标题/URL，经由随附扩展）======
async function syncPendingUpdates() {
  const pending = loadPending();
  if (!pending.length) return alert('当前没有待同步的修改。\n先点击表格里的标题或 URL 旁 ✎ 进行修改。');
  // 确认
  const ok = confirm(`即将把 ${pending.length} 条修改写入 Chrome 书签（标题/URL）：\n\n` +
    pending.map(p => `• ${p.oldTitle || p.url} → ${p.newTitle || ''}${p.newUrl ? ' / ' + p.newUrl : ''}`).join('\n') +
    `\n\n修改会同步到 Google 账号。继续？`);
  if (!ok) return;
  // 组装 items：url 是匹配键，newTitle/newUrl 是要更新的字段
  const items = pending.map(p => ({ url: p.oldUrl || p.url, title: p.oldTitle, newTitle: p.newTitle, newUrl: p.newUrl }));
  try {
    const resp = await fetch('/api/update-synced', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const data = await resp.json();
    if (data.ok) {
      // 成功同步的从队列移除（按 url 匹配，改过 URL 的按 oldUrl 移除）
      const syncedKeys = new Set(items.map(i => i.url));
      const rest = pending.filter(p => !syncedKeys.has(p.oldUrl || p.url));
      savePending(rest);
      showDupFeedback($('#tbl'), data.message || '✅ 同步完成', 'ok');
    } else {
      showDupFeedback($('#tbl'), data.error || '同步失败', 'err');
      if (data.code === 'NO_EXT') alert('未检测到随附扩展。\n请在 chrome://extensions 启用「书签清理助手（本地桥）」扩展后重试。');
    }
  } catch (e) {
    console.error('[sync] ERR', e);
    alert('同步失败：' + e.message);
  }
}

// 视觉反馈：行背景闪一下，让用户确认点击生效
function flashRow(el, kind) {
  if (!el) return;
  const tr = el.closest('tr') || (el.tagName === 'TR' ? el : null);
  if (!tr) return;
  const cls = kind === 'ok' ? 'flash-ok' : 'flash-err';
  tr.classList.remove('flash-ok', 'flash-err');
  // 强制 reflow 才能重启动画
  void tr.offsetWidth;
  tr.classList.add(cls);
  setTimeout(() => tr.classList.remove(cls), 800);
}

loadProfiles();
startExtStatusPolling();

// ====== 全局搜索：标题/URL/文件夹模糊匹配 + 回车直达打开 ======
const searchOverlay = () => document.getElementById('searchOverlay');
const searchInput = () => document.getElementById('searchInput');
const searchResults = () => document.getElementById('searchResults');
const searchEmpty = () => document.getElementById('searchEmpty');
let _searchIdx = -1;          // 当前高亮结果
let _searchList = [];         // 当前搜索结果（bms 引用）
let _searchMax = 50;          // 最多展示条数

// 搜索数据源：优先最近扫描的 bms（含手动覆盖），其次 reportData.bookmarks，最后 liveBookmarks
function searchPool() {
  if (Array.isArray(bms) && bms.length) return bms;
  if (reportData && Array.isArray(reportData.bookmarks) && reportData.bookmarks.length) return reportData.bookmarks;
  if (typeof liveBookmarks !== 'undefined' && Array.isArray(liveBookmarks) && liveBookmarks.length) return liveBookmarks;
  return [];
}

function openSearch() {
  const pool = searchPool();
  if (!pool.length) {
    searchResults().innerHTML = '';
    searchEmpty().classList.remove('hidden');
    searchEmpty().textContent = '没有可搜索的数据。请先选择书签来源并「开始扫描」。';
    searchOverlay().classList.remove('hidden');
    searchInput().value = '';
    searchInput().focus();
    return;
  }
  searchOverlay().classList.remove('hidden');
  searchEmpty().classList.add('hidden');
  searchInput().value = '';
  _searchIdx = -1;
  _searchList = [];
  renderSearchResults('');
  setTimeout(() => searchInput().focus(), 30);
}

function closeSearch() {
  searchOverlay().classList.add('hidden');
  _searchList = [];
  _searchIdx = -1;
}

function renderSearchResults(q) {
  const box = searchResults();
  const ql = q.trim().toLowerCase();
  box.innerHTML = '';
  searchEmpty().classList.add('hidden');
  if (!ql) {
    // 空查询：展示"搜索提示"（前几条书签作为示例）
    const pool = searchPool().slice(0, 8);
    if (!pool.length) return;
    const hint = document.createElement('div');
    hint.className = 'search-empty';
    hint.textContent = '输入关键词搜索标题 / URL / 文件夹，例如：知乎、github、旅行';
    box.appendChild(hint);
    _searchList = pool.slice(0, _searchMax);
    renderResultItems(box, _searchList);
    return;
  }
  const pool = searchPool();
  const hits = [];
  for (let i = 0; i < pool.length && hits.length < _searchMax; i++) {
    const b = pool[i];
    const t = String(b.title || '').toLowerCase();
    const u = String(b.url || '').toLowerCase();
    const f = String(b.folder || '').toLowerCase();
    if (t.includes(ql) || u.includes(ql) || f.includes(ql)) hits.push(b);
  }
  _searchList = hits;
  if (!hits.length) {
    searchEmpty().classList.remove('hidden');
    searchEmpty().textContent = `没有匹配「${q.trim()}」的书签。搜索基于最近一次扫描的数据，若刚导入请先「开始扫描」。`;
    return;
  }
  renderResultItems(box, hits);
  // 底部计数
  const total = pool.filter(b => String(b.title || '').toLowerCase().includes(ql) || String(b.url || '').toLowerCase().includes(ql) || String(b.folder || '').toLowerCase().includes(ql)).length;
  const cnt = document.createElement('div');
  cnt.className = 'search-count';
  cnt.textContent = total > _searchMax ? `匹配 ${total} 条，显示前 ${_searchMax} 条` : `匹配 ${total} 条`;
  box.appendChild(cnt);
}

function renderResultItems(box, list) {
  const colors = { valid: '#1a7f37', dead: '#cf222e', login: '#bf8700', unknown: '#6e7781', suspect: '#d4a017' };
  list.forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'search-result' + (i === _searchIdx ? ' active' : '');
    row.dataset.i = i;
    row.innerHTML =
      `<span class="sr-dot" style="background:${colors[b.status] || '#6e7781'}"></span>` +
      `<span class="sr-title">${esc(b.title || '(无标题)')}</span>` +
      `<span class="sr-url">${esc(b.url || '')}</span>` +
      (b.folder ? `<span class="sr-folder">${esc(b.folder)}</span>` : '');
    row.onclick = () => { _searchIdx = i; openSearchResult(); };
    row.onmouseenter = () => { setSearchActive(i); };
    box.appendChild(row);
  });
}

function setSearchActive(i) {
  _searchIdx = i;
  searchResults().querySelectorAll('.search-result').forEach((r, j) => r.classList.toggle('active', j === i));
}

function openSearchResult() {
  const b = _searchList[_searchIdx];
  if (!b || !b.url) return;
  window.open(b.url, '_blank'); // Electron 中会转交给系统浏览器打开（main.cjs setWindowOpenHandler）
  closeSearch();
}

// 键盘：Cmd+F / Ctrl+F 打开，↑↓ 选择，Enter 打开，Esc 关闭
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openSearch();
    return;
  }
  if (searchOverlay().classList.contains('hidden')) return;
  if (e.key === 'Escape') { closeSearch(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); if (_searchList.length) setSearchActive((_searchIdx + 1) % _searchList.length); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); if (_searchList.length) setSearchActive((_searchIdx - 1 + _searchList.length) % _searchList.length); return; }
  if (e.key === 'Enter') { e.preventDefault(); openSearchResult(); return; }
});

searchInput().addEventListener('input', (e) => {
  _searchIdx = -1;
  renderSearchResults(e.target.value);
});
document.getElementById('searchBtn').addEventListener('click', openSearch);
searchOverlay().addEventListener('mousedown', (e) => { if (e.target === searchOverlay()) closeSearch(); });

// ====== 随附扩展：下载按钮 ======
document.getElementById('downloadExtBtn').addEventListener('click', async () => {
  const btn = document.getElementById('downloadExtBtn');
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ 准备中…';
  try {
    const r = await fetch('/api/download-extension');
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    const blob = await r.blob();
    const filename = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'bm-ext.zip';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setTimeout(() => {
      alert(`已下载 ${filename}\n\n安装步骤：\n1. 双击 zip 解压（得到 bm-ext 文件夹）\n2. Chrome 打开 chrome://extensions\n3. 右上角打开「开发者模式」\n4. 点「加载已解压的扩展程序」→ 选择 bm-ext 文件夹\n5. 顶部状态变绿「已连接 ✓」即成功`);
    }, 200);
  } catch (e) {
    alert('下载失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
});

// ====== 部署版本号（强刷时如有变化说明加载到最新代码）======
// 顶部醒目版本号徽章
const buildEl = document.getElementById('buildTag');
if (buildEl) {
  // 拆分 BUILD 字符串：'v1.0.5 @ 2026-08-16T20:52' → 版本号 + 时间戳
  const m = BUILD.match(/^v([\d.]+)\s*@\s*(.+)$/);
  let buildTime = null;
  if (m) {
    buildEl.innerHTML = `v${m[1]} · <span style="opacity:.7">${m[2].replace('T', ' ').slice(0, 16)}</span>`;
    buildEl.title = `版本 v${m[1]}，构建时间 ${m[2]}\n如果版本号或时间与最新代码不一致，说明浏览器/桌面 app 没强刷\n点击 → 强制重新加载`;
    try { buildTime = new Date(m[2]).getTime(); } catch {}
  } else {
    buildEl.textContent = 'v' + BUILD;
    buildEl.title = `当前版本 BUILD（点击 → 强制重新加载）`;
  }
  buildEl.style.cursor = 'pointer';
  buildEl.addEventListener('click', (e) => {
    e.preventDefault();
    if (window.confirm(`当前 BUILD：${BUILD.replace(/^v/, '')}\n\n如果怀疑没拿到最新代码（如修复后界面仍异常），点确认强制刷新。\n（桌面 app 也可按 Cmd+R）`)) {
      window.location.reload();
    }
  });
}

// ====== 版本一致性自动检测 ======
// 定期请求 /api/health，若服务端部署的 app.js BUILD 与当前页面加载的不一致，
// 说明页面/桌面 app 没拿到最新代码 → 弹一次提醒（自动 reload 风险高，先提示用户）。
// 只在页面加载时检测一次 + 每 60s 一次，避免频繁打扰。
async function checkVersionConsistency() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const d = await r.json();
    if (!d.ok || !d.frontendBuild) return;
    const cur = BUILD.replace(/^v/, '');
    const srv = d.frontendBuild.replace(/^v/, '');
    if (cur !== srv) {
      // 避免重复弹窗：只弹一次，记录到 localStorage
      const last = localStorage.getItem('bm_version_warn');
      const now = Date.now();
      if (last && now - Number(last) < 60000) return; // 60s 内不重复
      localStorage.setItem('bm_version_warn', String(now));
      const reload = window.confirm(
        `检测到代码版本不一致：\n\n` +
        `当前页面加载：v${cur}\n服务端最新：v${srv}\n\n` +
        `你看到的是旧版界面，部分功能可能异常（如移动书签的文件夹列表）。\n` +
        `点「确定」立即刷新到最新版。`
      );
      if (reload) window.location.reload();
    } else {
      localStorage.removeItem('bm_version_warn');
    }
  } catch {
    // 健康检查失败（服务没起/网络问题）时静默，不打扰用户
  }
}
checkVersionConsistency();
setInterval(checkVersionConsistency, 60000);

// 书签清理助手 —— 本地桥（常驻扩展）
// 仅在本机 Chrome 打开时，听 localhost 上「书签清理工具」的删除指令，
// 调用官方 chrome.bookmarks 接口删除。删除会作为"墓碑"同步上云，书签不会"复活"。
// 本扩展不做任何网络上报，仅与本地 localhost 通信。
//
// 保活策略：MV3 Service Worker 约 30s 无事件会被 Chrome 杀掉。
// 使用 chrome.alarms 每 40s 重新注册 session，确保服务端认为扩展在线。

const BM_EXT_TOKEN = 'bm-tool-local-bridge-7f3a';
const API = 'http://localhost:4789/api/ext';
const KEEPALIVE_MS = 40000;

// 防止多个 poll 并发运行（SW 被杀重启或闹钟多触发时）
let pollingActive = false;

// 扁平化书签树，只返回 type=url 的节点 {id, title, url}
function flatten(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.url) out.push({ id: n.id, title: n.title, url: n.url });
    if (n.children && n.children.length) flatten(n.children, out);
  }
  return out;
}

async function getTree() {
  const t0 = Date.now();
  const tree = await chrome.bookmarks.getTree();
  const flat = flatten(tree);
  console.log(`[BM-ext] getTree done: ${flat.length} url nodes in ${Date.now() - t0}ms`);
  return flat;
}

// 展开全部文件夹节点（含 id + 完整路径标题），供移动书签时选择目标文件夹
async function getFolders() {
  const t0 = Date.now();
  const tree = await chrome.bookmarks.getTree();
  const out = [];
  const walk = (nodes, pathTitles) => {
    for (const n of nodes || []) {
      if (!n.url) {
        const titles = [...pathTitles, n.title];
        out.push({ id: n.id, title: n.title, path: titles.join(' / ') });
        if (n.children && n.children.length) walk(n.children, titles);
      }
    }
  };
  walk(tree, []);
  console.log(`[BM-ext] getFolders done: ${out.length} folders in ${Date.now() - t0}ms`);
  return out;
}

async function removeByIds(ids) {
  const removed = [];
  for (const id of ids || []) {
    try {
      await chrome.bookmarks.remove(id);
      removed.push(id);
    } catch (e) {
      // 节点可能已被删或不存在，忽略
    }
  }
  console.log(`[BM-ext] removeByIds: ${removed.length}/${ids?.length || 0} succeeded`);
  return removed;
}

// 修改书签标题/URL：chrome.bookmarks.update(id, {title, url})
// 只更新传给本函数的字段（title/url 可为 undefined），避免误覆盖。
async function updateBookmarks(changes) {
  const updated = [];
  for (const ch of changes || []) {
    if (!ch || !ch.id) continue;
    const props = {};
    if (typeof ch.title === 'string') props.title = ch.title;
    if (typeof ch.url === 'string') props.url = ch.url;
    if (!Object.keys(props).length) continue;
    try {
      await chrome.bookmarks.update(ch.id, props);
      updated.push({ id: ch.id, title: props.title, url: props.url });
    } catch (e) {
      console.warn(`[BM-ext] update ${ch.id} failed:`, e.message);
    }
  }
  console.log(`[BM-ext] updateBookmarks: ${updated.length}/${changes?.length || 0} succeeded`);
  return updated;
}

// 移动书签到其他文件夹：chrome.bookmarks.move(id, {parentId})
async function moveBookmarks(moves) {
  const moved = [];
  for (const mv of moves || []) {
    if (!mv || !mv.id || !mv.parentId) continue;
    try {
      await chrome.bookmarks.move(mv.id, { parentId: mv.parentId });
      moved.push({ id: mv.id, parentId: mv.parentId });
    } catch (e) {
      console.warn(`[BM-ext] move ${mv.id} failed:`, e.message);
    }
  }
  console.log(`[BM-ext] moveBookmarks: ${moved.length}/${moves?.length || 0} succeeded`);
  return moved;
}

async function postResult(requestId, ok, data, error) {
  try {
    await fetch(`${API}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, ok, data, error }),
    });
    console.log(`[BM-ext] result sent: id=${requestId} ok=${ok} err=${error || 'none'}`);
  } catch (e) {
    // 不 console.error，避免污染 chrome://extensions 错误列表（service worker
    // 会被 worker 关闭后立即重启，旧报可能仍残留）；改 debug + 提示
    console.debug(`[BM-ext] could not post result (本地工具已关闭？): id=${requestId}`, e.message);
  }
}

// 向服务端注册/心跳：告诉服务端"我还活着"
// 失败时不 console.error（避免触发 chrome://extensions 错误列表），改 console.debug + 降频提示
// 因为"app 没启"是正常状态（用户可能先开 Chrome 再开应用），不应被当作异常
let _lastWarnTs = 0;
async function registerSession() {
  try {
    const r = await fetch(`${API}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: BM_EXT_TOKEN, version: 2, resident: true }),
    });
    console.log('[BM-ext] session registered', r.ok ? 'OK' : 'FAIL');
  } catch (e) {
    // 失败可能是「app 没开」或「网络断开」，用 debug 级别 + 60s 降频 + 友好提示
    const now = Date.now();
    if (now - _lastWarnTs > 60000) {
      _lastWarnTs = now;
      console.debug('[BM-ext] session not yet registered (本地工具未运行？其服务启动后会自动连接):', e.message);
    }
  }
  // 心跳时顺便确保轮询在跑（SW 可能被杀后只剩闹钟唤醒，poll 已丢失）
  if (!pollingActive) {
    console.log('[BM-ext] heartbeat detected no active poll — restarting');
    poll();
  }
}

async function poll() {
  if (pollingActive) {
    console.log('[BM-ext] poll already active, skipping duplicate');
    return;
  }
  pollingActive = true;
  let cmd = null;
  try {
    const r = await fetch(`${API}/command?token=${BM_EXT_TOKEN}&wait=1&timeout=25000`, { cache: 'no-store' });
    if (r.ok) cmd = await r.json();
  } catch (e) {
    // 失败通常是「本地工具未启动」，不 console.warn 以避免污染 chrome://extensions 错误列表
    // 在用户没开 app 时，每 25s 一次失败会堆出大量错误
    console.debug('[BM-ext] poll fetch 无响应（本地工具未运行？启动后会自动恢复）:', e.message);
    cmd = { type: 'none' };
  }
  if (!cmd || cmd.type === 'none') {
    pollingActive = false;
    setTimeout(poll, 600);
    return;
  }

  console.log(`[BM-ext] received command: ${cmd.type} (id=${cmd.id})`);

  // 用 .then() 而非 await 确保即使命令处理出错也能继续轮询
  handleCommand(cmd).catch((e) => {
    console.error(`[BM-ext] unhandled error in ${cmd.type}:`, e);
    postResult(cmd.id, false, null, String(e && e.message || e));
  });

  pollingActive = false;
  setTimeout(poll, 200);
}

async function handleCommand(cmd) {
  if (cmd.type === 'getTree') {
    const tree = await getTree();
    await postResult(cmd.id, true, tree);
  } else if (cmd.type === 'getFolders') {
    const folders = await getFolders();
    await postResult(cmd.id, true, folders);
  } else if (cmd.type === 'remove') {
    const removed = await removeByIds(cmd.ids);
    await postResult(cmd.id, true, { removed });
  } else if (cmd.type === 'update') {
    const updated = await updateBookmarks(cmd.changes);
    await postResult(cmd.id, true, { updated });
  } else if (cmd.type === 'move') {
    const moved = await moveBookmarks(cmd.moves);
    await postResult(cmd.id, true, { moved });
  } else {
    await postResult(cmd.id, false, null, '未知命令: ' + cmd.type);
  }
}

async function start() {
  console.log('[BM-ext] starting...');
  await registerSession();
  // 设置定时保活闹钟（MV3 中 chrome.alarms 是唯一可靠的周期性唤醒方式）
  try {
    await chrome.alarms.create('bm-keepalive', { periodInMinutes: 0.67 }); // ~40s
    console.log('[BM-ext] keepalive alarm set');
  } catch (e) {
    // alarms 权限未声明时降级为 setTimeout（不可靠但聊胜于无）
    setInterval(registerSession, KEEPALIVE_MS);
    console.log('[BM-ext] fallback to setInterval keepalive');
  }
  poll();
}

chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
// 闹钟触发时重新注册 session + 重启轮询（MV3 SW 可能被杀后只剩闹钟能唤醒，
// 此时必须同时恢复 poll()，否则服务端认为在线但实际没人取命令）
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bm-keepalive') {
    console.log('[BM-ext] alarm fired — re-registering session + restarting poll');
    registerSession();
    // 重启 poll：如果当前没有活跃的 poll 循环（SW 被杀后丢失），
    // 这会新建一个；如果已有也不会重复堆积（poll 是串行的）
    poll();
  }
});
start();

// organizer.js — 非破坏性整理：保留最优、保留层级、清洗标题、排序
import { URL } from 'node:url';

const DEAD_REASONS = new Set([
  'not_found', 'dns_failure', 'timeout', 'connection_refused',
  'http_client_error', 'http_server_error', 'network', 'invalid_url', 'too_many_redirects',
]);

export function isDead(result) {
  if (!result) return false; // 未检测 = 保留
  if (result.ok) return false;
  if (result.suspicious) return false; // 网络层异常（可能误报）→ 保守保留，不参与自动删除
  return DEAD_REASONS.has(result.reason);
}

function isLoginRequired(result) {
  return result && !result.ok && result.reason === 'login_required';
}

// 轻量乱码修复（latin1 误读 UTF-8 场景）
function fixMojibake(s) {
  if (!s || !/Ã|Â|ï¿½|â€/.test(s)) return s;
  try {
    const fixed = Buffer.from(s, 'latin1').toString('utf8');
    if (fixed && fixed !== s && !/Ã/.test(fixed)) return fixed;
  } catch {}
  return s;
}

export function cleanTitle(s) {
  return fixMojibake(String(s || '').replace(/\s+/g, ' ').trim());
}

function score(bm, result) {
  let s = 0;
  if (result && result.ok) s += 4;
  try { if (new URL(bm.url).protocol === 'https:') s += 2; } catch {}
  s += (bm.dateAdded || 0) / 1e15; // 最近添加的极小加成
  return s;
}

/**
 * 用并查集把 urlGroups + redirectGroups 合并成重复簇，每簇选最优保留。
 * @returns {Map<number, boolean>} index -> 是否冗余（非保留）
 */
function clusterDedup(bookmarks, dup) {
  const parent = bookmarks.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  const groups = [...dup.urlGroups, ...dup.redirectGroups];
  for (const g of groups) {
    const idxs = g.map((bm) => bookmarks.indexOf(bm)).filter((i) => i >= 0);
    for (let i = 1; i < idxs.length; i++) union(idxs[0], idxs[i]);
  }
  // 每个簇选 keeper
  const byRoot = new Map();
  bookmarks.forEach((bm, i) => {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(i);
  });
  const redundant = new Set();
  const results = arguments[2] || new Map();
  for (const [, idxs] of byRoot) {
    if (idxs.length < 2) continue;
    let best = idxs[0];
    for (const i of idxs) if (score(bookmarks[i], results.get(bookmarks[i].url)) > score(bookmarks[best], results.get(bookmarks[best].url))) best = i;
    for (const i of idxs) if (i !== best) redundant.add(i);
  }
  return redundant;
}

/**
 * 整理主函数（非破坏性：返回全新结构，不写浏览器）。
 * @param {Array} bookmarks
 * @param {Map} results
 * @param {object} dup findDuplicates 的返回值
 * @param {object} opts {removeDead, sort}
 */
export function organize(bookmarks, results = new Map(), dup = { urlGroups: [], redirectGroups: [] }, opts = {}) {
  const { removeDead = false, sort = true } = opts;
  const redundant = clusterDedup(bookmarks, dup, results);

  const summary = { total: bookmarks.length, kept: 0, removedDead: 0, merged: 0, deadFlagged: 0, loginFlagged: 0 };
  const root = { type: 'folder', name: '根', children: [] };

  bookmarks.forEach((bm, i) => {
    const result = results.get(bm.url);
    const dead = isDead(result);
    const login = isLoginRequired(result);
    if (dead) summary.deadFlagged++;
    if (login) summary.loginFlagged++;

    // 决策：冗余必删；removeDead 时才删死链
    if (redundant.has(i)) { summary.merged++; return; }
    if (removeDead && dead) { summary.removedDead++; return; }

    const node = {
      type: 'bookmark',
      title: cleanTitle(bm.title) || bm.url,
      url: bm.url,
      status: result ? (result.ok ? 'valid' : (login ? 'login' : 'dead')) : 'unknown',
      reason: result ? result.reason : 'unchecked',
      redundant: false,
    };
    summary.kept++;
    insertIntoTree(root, bm.folderPath || [], node);
  });

  if (sort) sortTree(root);
  return { tree: root, summary };
}

function insertIntoTree(root, folderPath, node) {
  let cur = root;
  for (const name of folderPath) {
    let next = cur.children.find((c) => c.type === 'folder' && c.name === name);
    if (!next) {
      next = { type: 'folder', name, children: [] };
      cur.children.push(next);
    }
    cur = next;
  }
  cur.children.push(node);
}

function sortTree(node) {
  if (node.type !== 'folder') return;
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1; // 文件夹在前
    return (a.name || '').localeCompare(b.name || '', 'zh');
  });
  for (const c of node.children) sortTree(c);
}

export default { organize, isDead, cleanTitle };

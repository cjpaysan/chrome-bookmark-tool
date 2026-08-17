// parser.js — Chrome 书签解析（原生 JSON + HTML 导入兜底）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 把 Chrome Bookmarks JSON 解析为扁平书签列表 + 文件夹树。
 * @param {object} root Chrome Bookmarks JSON 根对象
 * @returns {{bookmarks: Array, folders: Array}}
 */
export function parseChromeJson(root) {
  const bookmarks = [];
  const folders = [];

  const walk = (node, parentPath) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'folder') {
      const folderPath = [...parentPath, node.name || '未命名文件夹'];
      folders.push({ id: node.id, name: node.name, path: folderPath });
      for (const child of node.children || []) walk(child, folderPath);
    } else if (node.type === 'url') {
      bookmarks.push({
        id: node.id,
        title: node.name || '',
        url: node.url || '',
        folderPath: parentPath,
        dateAdded: chromeTimeToMs(node.date_added),
        guid: node.guid || null,
      });
    }
  };

  const roots = root && root.roots ? root.roots : {};
  // 三个根：书签栏 / 其他书签 / 移动设备书签
  for (const key of ['bookmark_bar', 'other', 'synced']) {
    if (roots[key]) walk(roots[key], []);
  }
  return { bookmarks, folders };
}

// 合并「本地 Bookmarks」与「账号 AccountBookmarks」两份 roots（按 guid 去重，避免重复节点）。
// 新版 Chrome 开启账号同步后，书签分散在两份文件里，需合并才是用户在书签管理器里看到的全集。
export function mergeChromeObjects(a, b) {
  const ra = (a && a.roots) || {};
  const rb = (b && b.roots) || {};
  const merged = { version: (a && a.version) != null ? a.version : (b && b.version), roots: {} };
  const guids = new Set();
  for (const k of ['bookmark_bar', 'other', 'synced']) {
    const na = ra[k], nb = rb[k];
    const children = [];
    const push = (node) => {
      if (!node || !Array.isArray(node.children)) return;
      for (const c of node.children) {
        if (c && c.guid) { if (guids.has(c.guid)) continue; guids.add(c.guid); }
        children.push(c);
      }
    };
    push(na); push(nb);
    merged.roots[k] = { type: 'folder', name: (na && na.name) || (nb && nb.name) || k, children };
  }
  return merged;
}

// Chrome 时间戳是自 1601-01-01 起的微秒，转成 Unix 毫秒
export function chromeTimeToMs(t) {
  if (!t) return 0;
  const us = Number(t);
  if (!Number.isFinite(us)) return 0;
  return Math.floor(us / 1000 - 11644473600000);
}

// 已知 Chromium 系浏览器在 ~/Library/Application Support 下的目录
const KNOWN_BROWSERS = [
  { id: 'Chrome', label: 'Google Chrome', dir: ['Google', 'Chrome'] },
  { id: 'Chrome Beta', label: 'Chrome Beta', dir: ['Google', 'Chrome Beta'] },
  { id: 'Chrome Canary', label: 'Chrome Canary', dir: ['Google', 'Chrome Canary'] },
  { id: 'Chromium', label: 'Chromium', dir: ['Chromium'] },
  { id: 'Edge', label: 'Microsoft Edge', dir: ['Microsoft', 'Edge'] },
  { id: 'Brave', label: 'Brave', dir: ['BraveSoftware', 'Brave-Browser'] },
  { id: 'Arc', label: 'Arc', dir: ['Arc'] },
  { id: 'Doubao', label: '豆包 Doubao', dir: ['Doubao'] },
  { id: 'Quark', label: '夸克 Quark', dir: ['Quark'] },
  { id: 'QQBrowser', label: 'QQ 浏览器', dir: ['QQBrowser'] },
  { id: '360', label: '360 安全浏览器', dir: ['360Chrome', 'Chrome'] },
];

// 验证是否 Chromium 书签文件（有 roots 结构）
function isChromiumBookmarks(obj) {
  return !!(obj && typeof obj === 'object' && obj.roots && typeof obj.roots === 'object'
    && (obj.roots.bookmark_bar || obj.roots.other || obj.roots.synced || Object.keys(obj.roots).length > 0));
}

// 统计书签条数（url 节点）
function countUrls(obj) {
  let n = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'url') n++;
    for (const c of node.children || []) walk(c);
  };
  for (const k of ['bookmark_bar', 'other', 'synced']) if (obj.roots?.[k]) walk(obj.roots[k]);
  return n;
}

// 合并「本地 Bookmarks + 账号 AccountBookmarks」后的真实书签数（按 guid 去重，避免重复计数）
function countMerged(a, b) {
  const guids = new Set();
  let n = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'url') {
      if (node.guid) { if (guids.has(node.guid)) return; guids.add(node.guid); }
      n++;
    }
    for (const c of node.children || []) walk(c);
  };
  for (const k of ['bookmark_bar', 'other', 'synced']) { walk((a?.roots || {})[k]); walk((b?.roots || {})[k]); }
  return n;
}

/**
 * 扫描本机所有 Chromium 系浏览器的多 Profile，返回含 Bookmarks 文件的列表。
 * 自动发现 Chrome / Chrome Beta / Chrome Canary / Chromium / Edge / Brave / Arc /
 * 豆包 / 夸克 / QQ 浏览器 / 360 等，并对未知 Chromium 浏览器做兜底探测。
 * @param {string} [home] 用户主目录
 * @returns {Array<{browser,browserLabel,profile,name,path,urlCount}>}
 */
export function findChromiumProfiles(home = os.homedir()) {
  const as = path.join(home, 'Library', 'Application Support');
  const out = [];
  const seen = new Set();

  // 统计单个文件路径里的书签数（无效/不可读返回 {count:0, obj:null}）
  const readFileSafe = (fp) => {
    try {
      const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!isChromiumBookmarks(obj)) return { count: 0, obj: null };
      return { count: countUrls(obj), obj };
    } catch { return { count: 0, obj: null }; }
  };

  /**
   * 登记一个 profile：同时检查「本地 Bookmarks」与「账号同步 AccountBookmarks」两份，
   * 兼容两种存储方式——国内很多用户无法使用 Google 账号同步，书签只在本地 Bookmarks；
   * 而开启同步的用户，书签主要存于 AccountBookmarks。
   */
  const addProfile = (browser, browserLabel, profile, profileDir) => {
    if (seen.has(profileDir)) return;
    const bmPath = path.join(profileDir, 'Bookmarks');
    const acctPath = path.join(profileDir, 'AccountBookmarks');
    if (!fs.existsSync(bmPath) && !fs.existsSync(acctPath)) return;
    seen.add(profileDir);

    // 本地 Bookmarks（仅当主文件为空「且」无账号同步时，才回退 .bak，避免恢复陈旧的本地数据）
    let localCount = 0, localPath = null, localObj = null;
    if (fs.existsSync(bmPath)) {
      const r = readFileSafe(bmPath);
      if (r.count > 0) { localCount = r.count; localPath = bmPath; localObj = r.obj; }
      else if (!fs.existsSync(acctPath)) {
        const bak = bmPath + '.bak';
        const rb = readFileSafe(bak);
        if (rb.count > 0) { localCount = rb.count; localPath = bak; localObj = rb.obj; }
      }
    }

    // 账号同步 AccountBookmarks
    let acctCount = 0, accountPath = null, acctObj = null;
    if (fs.existsSync(acctPath)) {
      const r = readFileSafe(acctPath);
      if (r.count > 0) { acctCount = r.count; accountPath = acctPath; acctObj = r.obj; }
    }

    const urlCount = countMerged(localObj, acctObj);
    if (urlCount === 0) return; // 两份都没数据则不列为有效来源

    out.push({
      browser, browserLabel, profile, name: profile,
      path: localPath || accountPath,
      profileDir,
      localPath, accountPath,
      urlCount,
      hasLocal: localCount > 0,
      hasAccount: acctCount > 0,
      isBackup: !!localPath && localPath.endsWith('.bak'),
    });
  };

  // 1) 已知浏览器：扫描其下所有 profile 子目录（Default / Profile 1 …）
  for (const b of KNOWN_BROWSERS) {
    const base = path.join(as, ...b.dir);
    if (!fs.existsSync(base)) continue;
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const profileDir = path.join(base, e.name);
      if (fs.existsSync(path.join(profileDir, 'Bookmarks')) || fs.existsSync(path.join(profileDir, 'AccountBookmarks')))
        addProfile(b.id, b.label, e.name, profileDir);
    }
  }

  // 2) 自动兜底：遍历 Application Support 下任意目录，找任意 profile 的 Bookmarks / AccountBookmarks（覆盖小众/未知浏览器）
  let top = [];
  try { top = fs.readdirSync(as, { withFileTypes: true }); } catch {}
  for (const e of top) {
    if (!e.isDirectory()) continue;
    const base = path.join(as, e.name);
    let sub = [];
    try { sub = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const s of sub) {
      if (!s.isDirectory()) continue;
      const profileDir = path.join(base, s.name);
      if (fs.existsSync(path.join(profileDir, 'Bookmarks')) || fs.existsSync(path.join(profileDir, 'AccountBookmarks'))) {
        const known = KNOWN_BROWSERS.find((k) => path.join(as, ...k.dir) === base);
        addProfile(known?.id || e.name, known?.label || e.name, s.name, profileDir);
      }
    }
  }

  // 有书签的排前面，便于默认选中真实数据
  out.sort((a, b) => (b.urlCount - a.urlCount) || a.browserLabel.localeCompare(b.browserLabel));
  return out;
}

// 兼容别名（旧调用方仍可用）
export const findChromeProfiles = findChromiumProfiles;

/**
 * 由扁平文件夹列表 + 书签列表构建嵌套文件夹树（带书签计数）。
 * 计数规则：每个文件夹计入其本身及所有子文件夹内的书签数，便于勾选时预估范围。
 * @param {Array} folders 解析出的扁平文件夹 [{id,name,path:[...]}]
 * @param {Array} bookmarks 解析出的书签 [{folderPath:[...]}]
 * @returns {{name, path, count, children}}
 */
export function buildFolderTree(folders, bookmarks = []) {
  const root = { name: '（根）', path: [], count: 0, children: [] };
  const map = new Map();
  map.set(JSON.stringify([]), root);

  // 统计每个文件夹路径下的书签数（含其所有子文件夹）
  const counts = new Map();
  for (const b of bookmarks) {
    const fp = b.folderPath || [];
    const acc = [];
    for (const name of fp) {
      acc.push(name);
      const k = JSON.stringify(acc);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }

  for (const f of folders) {
    const p = f.path || [];
    let parent = root;
    const acc = [];
    for (const name of p) {
      acc.push(name);
      const key = JSON.stringify(acc);
      let node = map.get(key);
      if (!node) {
        node = { name, path: acc.slice(), count: 0, children: [] };
        map.set(key, node);
        parent.children.push(node);
      }
      parent = node;
    }
  }

  for (const [k, node] of map) node.count = counts.get(k) || 0;
  return root;
}

// 判断书签的 folderPath 是否落在所选文件夹（或其子文件夹）中
export function matchesSelectedFolders(folderPath = [], selected = []) {
  if (!selected || selected.length === 0) return true;
  return selected.some((sel) => {
    if (sel.length > folderPath.length) return false;
    for (let i = 0; i < sel.length; i++) {
      if (sel[i] !== folderPath[i]) return false;
    }
    return true;
  });
}

/**
 * 解析 Netscape 格式 HTML 书签（导入兜底）。
 * 支持 <H3> 文件夹名 + <A HREF> 书签，按 <DL> 嵌套。
 */
export function parseHtmlBookmarks(html) {
  const bookmarks = [];
  const re = /<h3[^>]*>(.*?)<\/h3>|<a\s+[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis;
  let m;
  const stack = [[]]; // 文件夹路径栈
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== undefined) {
      // 文件夹标题
      stack.push([...stack[stack.length - 1], decodeHtml(m[1])]);
    } else if (m[2] !== undefined) {
      bookmarks.push({
        id: `imp-${bookmarks.length}`,
        title: decodeHtml(m[3] || ''),
        url: m[2],
        folderPath: stack[stack.length - 1],
        dateAdded: 0,
        guid: null,
      });
    }
  }
  return { bookmarks, folders: [] };
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * 统一入口：从 Profile 或导入文件载入书签。
 * @param {{profile?: string, inputFile?: string, home?: string}} opts
 */
export function loadBookmarks(opts = {}) {
  if (opts.inputFile) {
    const raw = fs.readFileSync(opts.inputFile, 'utf8');
    if (/\.html?$/i.test(opts.inputFile)) return parseHtmlBookmarks(raw);
    return parseChromeJson(JSON.parse(raw));
  }
  const profiles = findChromiumProfiles(opts.home);
  if (profiles.length === 0) {
    throw new Error('未找到任何 Chromium 系浏览器的书签文件，请确认浏览器已安装或用 --input 指定导出文件。');
  }
  let target;
  if (opts.browser && opts.profile) {
    target = profiles.find((p) => p.browser === opts.browser && p.profile === opts.profile);
  } else if (opts.profile) {
    target = profiles.find((p) => p.profile === opts.profile);
  }
  // 默认优先选中“有书签”的 profile（避免选中空的 Chrome/Default）
  if (!target) target = profiles.find((p) => p.urlCount > 0) || profiles[0];

  // 读取「本地 Bookmarks」+「账号 AccountBookmarks」两份并合并，
  // 兼容「书签存本地」与「跟随 Google 账号同步」两种存储方式。
  let localObj = null, acctObj = null;
  if (target.localPath) { try { localObj = JSON.parse(fs.readFileSync(target.localPath, 'utf8')); } catch {} }
  if (target.accountPath) { try { acctObj = JSON.parse(fs.readFileSync(target.accountPath, 'utf8')); } catch {} }
  const merged = mergeChromeObjects(localObj, acctObj);
  const parsed = parseChromeJson(merged);
  return {
    ...parsed,
    profile: `${target.browserLabel} · ${target.profile}`,
    browser: target.browser,
    profileName: target.profile,
    hasLocal: target.hasLocal,
    hasAccount: target.hasAccount,
  };
}

export default { parseChromeJson, findChromiumProfiles, findChromeProfiles, parseHtmlBookmarks, loadBookmarks, buildFolderTree, matchesSelectedFolders, chromeTimeToMs };

// server.js — 本地 Web UI 服务（GUI 主视图 + 异步扫描 + 文件夹选择 + 导入 + Chrome写回）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runPipeline, findChromiumProfiles } from './core/pipeline.js';
import { loadBookmarks, buildFolderTree, parseChromeJson, parseHtmlBookmarks } from './core/parser.js';
import { toHtml, toCsv, toJson } from './core/reporter.js';
import { toSafariHtml } from './core/safari-export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
// 输出目录可被环境变量覆盖（打包成 .app 后写进用户可写目录，避免写进包体）
const OUTPUT = process.env.BM_OUTPUT_DIR
  ? path.resolve(process.env.BM_OUTPUT_DIR)
  : path.join(__dirname, '..', 'output');
const UPLOADS = path.join(OUTPUT, 'uploads');
const PORT = process.env.PORT || 4789;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

// 内存态
const jobs = new Map();
const imports = new Map();
let lastReport = null;

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
ensureDir(UPLOADS);

// 极简 ZIP 文件构造器（够用，文件名仅 ASCII 兼容；UTF-8 文件名一般用 system zip 都支持）
// 输入：[{ name: 'manifest.json', data: Buffer }, ...]
// 返回 zip Buffer
function buildZip(entries) {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = (crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xffffffff) >>> 0;
  };
  const localParts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = crc32(data);
    const size = data.length;
    // local file header
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(0, 8);           // method (stored)
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0, 12);          // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra
    localParts.push(local, nameBuf, data);
    // central directory header
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);              // version made by
    c.writeUInt16LE(20, 6);              // version needed
    c.writeUInt16LE(0, 8);               // flags
    c.writeUInt16LE(0, 10);              // method
    c.writeUInt16LE(0, 12);              // time
    c.writeUInt16LE(0, 14);              // date
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(size, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(0, 30);              // extra
    c.writeUInt16LE(0, 32);              // comment
    c.writeUInt16LE(0, 34);              // disk
    c.writeUInt16LE(0, 36);              // internal attr
    c.writeUInt32LE(0, 38);              // external attr
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, end]);
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
  });
}

function randomId() { return crypto.randomBytes(6).toString('hex'); }

function resolveSource(body) {
  if (body.importId) {
    const imp = imports.get(body.importId);
    if (!imp) throw new Error('导入的书签不存在或已失效，请重新导入。');
    return { input: imp.path };
  }
  if (body.inputFile) return { input: body.inputFile };
  return { browser: body.browser, profile: body.profile };
}

function listProfiles() {
  const ps = findChromiumProfiles().map((p) => {
    // 检测浏览器是否正在运行（profile 目录下的 SingletonLock），用于写回前提醒
    let running = false;
    try {
      running = fs.existsSync(path.join(p.profileDir, 'SingletonLock'));
    } catch {}
    return {
      browser: p.browser, browserLabel: p.browserLabel, profile: p.profile,
      name: p.profile, path: p.path, profileDir: p.profileDir,
      urlCount: p.urlCount, isBackup: !!p.isBackup,
      hasLocal: !!p.hasLocal, hasAccount: !!p.hasAccount, running,
    };
  });
  for (const [id, imp] of imports) {
    ps.unshift({ browser: 'Import', browserLabel: '手动导入', profile: imp.name, name: imp.name, importId: id, path: imp.path, urlCount: imp.urlCount, isImport: true });
  }
  return ps;
}

// ========== 写回 Chrome 书签文件 ==========

async function writeBackToChrome(body) {
  const action = body.action;
  if (!['edit', 'delete', 'merge'].includes(action)) return { ok: false, error: '未知操作类型。' };

  // 1) 精确定位目标 profile：优先用前端传来的 browser+profile
  const allProfiles = findChromiumProfiles();
  let target = null;
  if (body.browser && body.profile) {
    target = allProfiles.find((p) => p.browser === body.browser && p.profile === body.profile);
  }
  if (!target) target = allProfiles.find((p) => p.urlCount > 0) || allProfiles[0];
  if (!target?.profileDir) return { ok: false, error: '未找到任何浏览器书签文件。' };

  // 2) 浏览器运行中 → 拒绝写入（否则改动会被 Chrome 覆盖，造成数据丢失）
  let running = false;
  try { running = fs.existsSync(path.join(target.profileDir, 'SingletonLock')); } catch {}
  if (running) {
    return {
      ok: false,
      error: `⛔ 目标浏览器（${target.browserLabel}）正在运行，无法安全写入！\n\n请完全退出浏览器（包括菜单栏后台进程），再执行此操作。\n\n如果浏览器已关闭仍看到此错误，请检查是否有其他 Chromium 系浏览器（Edge/Brave/Arc 等）锁定了配置目录。`,
      browserRunning: true,
    };
  }

  // 2.5) 同步账号警告标记
  const isSynced = !!target.accountPath;

  // 3) 待操作的目标文件：本地 Bookmarks（始终写回主文件）+ 账号 AccountBookmarks（若存在）
  //    书签节点可能存在于任一份文件中，需逐文件查找并改对文件。
  const files = [];
  if (target.localPath) files.push({ role: 'local', readPath: target.localPath, writePath: path.join(target.profileDir, 'Bookmarks') });
  if (target.accountPath) files.push({ role: 'account', readPath: target.accountPath, writePath: target.accountPath });

  const loaded = files.map((f) => {
    try {
      const raw = fs.readFileSync(f.readPath, 'utf8');
      return { ...f, raw, json: JSON.parse(raw), modified: false };
    } catch (e) { return { ...f, error: e.message }; }
  });

  const list = action === 'edit' ? (body.changes || []) : action === 'merge' ? (body.remove || []) : (body.items || []);
  const mode = action === 'merge' ? 'delete' : action;

  // 4) 执行修改：每条待办依次在两份文件里查找匹配，命中即改对应文件
  let modifiedCount = 0, notFound = 0;
  for (const item of list) {
    let matched = false;
    for (const f of loaded) {
      if (f.error || !f.json) continue;
      if (findAndModifyNode(f.json.roots, item, mode)) { matched = true; f.modified = true; break; }
    }
    if (matched) modifiedCount++; else notFound++;
  }

  if (modifiedCount === 0) {
    return {
      ok: false,
      error:
        `未找到匹配的书签节点（${action}），未做任何修改。\n` +
        `可能原因：\n` +
        `  • 标题或 URL 与书签文件中的不完全一致\n` +
        `  • 当前扫描来源与写入目标不一致\n` +
        `  • 该书签在其它浏览器 / 账号中\n\n` +
        `诊断信息：\n` +
        `  目标目录：${target.profileDir}\n` +
        `  浏览器：${target.browserLabel} (${target.browser}/${target.profile})\n` +
        `  尝试匹配第1条：url=${list[0]?.url} title=${list[0]?.title}`,
      notFound,
    };
  }

  // 5) 为每个被修改的文件分别备份并写回
  const backupDir = path.join(OUTPUT, 'backups');
  ensureDir(backupDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const writtenFiles = [];
  const backupPaths = [];
  for (const f of loaded) {
    if (f.error || !f.json || !f.modified) continue;
    const backupPath = path.join(backupDir, `Bookmarks-backup-${ts}-${f.role}.json`);
    fs.writeFileSync(backupPath, f.raw, 'utf8');
    backupPaths.push(backupPath);
    fs.writeFileSync(f.writePath, JSON.stringify(f.json, null, 3), 'utf8');
    writtenFiles.push(f.writePath);
  }

  // 6) 写后验证：以「删除/改动前后，匹配节点数量的差值 == 待处理条数」来判定，
  //    而不是「该 URL 是否完全不存在」。否则 http/https 同源变体残留（其实是你刻意保留的另一份）
  //    会被误报成“删除失败”，造成 verified:false 的假警报。
  let verified = false;
  let verifyDetails = '';
  try {
    const keyOf = (u, t) => {
      let nu;
      try { const U = new URL(u); nu = U.hostname.toLowerCase() + U.pathname.replace(/\/+$/, '') + U.search; }
      catch { nu = (u || '').trim().toLowerCase(); }
      return nu + '|' + (t || '').trim();
    };
    const keysSet = new Set(list.map((item) => keyOf(item.url || item.oldUrl || '', item.title || item.oldTitle || '')));
    const countMatching = (roots) => {
      let n = 0;
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'url') {
          let nu;
          try { const U = new URL(node.url); nu = U.hostname.toLowerCase() + U.pathname.replace(/\/+$/, '') + U.search; }
          catch { nu = (node.url || '').trim().toLowerCase(); }
          if (keysSet.has(nu + '|' + (node.name || '').trim())) n++;
        }
        for (const c of node.children || []) walk(c);
      };
      for (const k of ['bookmark_bar', 'other', 'synced']) if (roots?.[k]) walk(roots[k]);
      return n;
    };
    // 删除前：在各原始文件中统计匹配节点总数
    let before = 0;
    for (const f of loaded) if (f.json) before += countMatching(f.json.roots);
    // 删除后：重新从磁盘读取所有被加载文件，统计剩余匹配节点
    let after = 0;
    for (const f of loaded) {
      if (!f.readPath) continue;
      try { after += countMatching(JSON.parse(fs.readFileSync(f.readPath, 'utf8')).roots); } catch {}
    }
    // 改动条数 == 待处理条数 ⇒ 确认落盘成功（无论是否还残留同源变体）
    verified = (before - after === list.length);
    if (verified) verifyDetails = writtenFiles.join(', ');
  } catch {}

  const syncWarning = isSynced
    ? `\n\n⚠️ 同步账号提醒（重要）：\n` +
      `  你的书签跟随 Google 账号同步，存储于 AccountBookmarks。\n` +
      `  本工具已把改动写入本地文件，但 Chrome 下次联网启动时，云端旧数据可能【覆盖】本次改动，\n` +
      `  导致你刚删除的书签“复活”。这是云端同步机制，工具无法绕过。\n` +
      `  推荐做法：\n` +
      `    1) 先在 Chrome 设置里【关闭同步】（或退出 Google 账号）；\n` +
      `    2) 完全退出 Chrome 后，用本工具执行删除/编辑；\n` +
      `    3) 重新打开 Chrome，确认书签已删除；\n` +
      `    4) 再重新开启同步（此时以本地为准上传到云端）。`
    : '';

  const warnMsg = notFound > 0 ? `\n（另有 ${notFound} 条未匹配到，已跳过。）` : '';
  const writtenDesc = writtenFiles.map((p) => `  • ${p}`).join('\n');
  const backupDesc = backupPaths.map((p) => `  • ${p}`).join('\n');

  return {
    ok: true,
    verified,
    message:
      `${action === 'edit' ? '编辑' : action === 'delete' ? '删除' : '合并'}成功，共修改 ${modifiedCount} 条书签。${warnMsg}` +
      `${verified ? '\n✅ 已验证：文件改动已确认落盘（' + verifyDetails + '）' : '\n⚠️ 无法自动验证文件改动，请手动确认。'}` +
      `\n\n写入文件：\n${writtenDesc}\n\n备份文件：\n${backupDesc}` +
      syncWarning,
    writtenTo: writtenFiles[0] || null,
    backupPath: backupPaths[0] || null,
    backupPaths,
    modifiedCount,
    notFound: notFound || undefined,
    isSynced,
  };
}

function findAndModifyNode(nodeOrArray, target, mode) {
  // Chrome bookmarks roots 是 { bookmark_bar: {...}, other: {...}, synced: {...} }
  // 需要先展开对象值为数组再递归
  let candidates;
  if (Array.isArray(nodeOrArray)) {
    candidates = nodeOrArray;
  } else if (nodeOrArray && typeof nodeOrArray === 'object') {
    // 如果是 roots 对象，取所有值（每个值是一个根文件夹节点）
    if (nodeOrArray.children && Array.isArray(nodeOrArray.children)) {
      candidates = nodeOrArray.children;
    } else {
      // roots 本身：遍历每个根文件夹
      for (const val of Object.values(nodeOrArray)) {
        if (val && typeof val === 'object' && val.type === 'folder') {
          const found = findAndModifyNode(val, target, mode);
          if (found) return true;
        }
      }
      return false;
    }
  } else {
    return false;
  }

  // 从后向前遍历（删除时索引不乱）
  for (let i = candidates.length - 1; i >= 0; i--) {
    const child = candidates[i];
    if (!child) continue;

    if (child.type === 'url') {
      const nodeUrl = normalizeUrlForMatch(child.url);
      const targetUrl = normalizeUrlForMatch(target.url || target.oldUrl);
      const urlMatch = nodeUrl === targetUrl;
      const nameMatch = (child.name || '').trim() === (target.title || target.oldTitle || '').trim();
      if (urlMatch && nameMatch) {
        if (mode === 'edit') {
          if (target.newTitle !== undefined) child.name = target.newTitle;
          if (target.newUrl !== undefined && target.newUrl !== target.oldUrl) child.url = target.newUrl;
          return true;
        } else if (mode === 'delete') {
          candidates.splice(i, 1);
          return true;
        }
      }
    }

    // 递归子文件夹
    if (child.type === 'folder' && child.children?.length) {
      const found = findAndModifyNode(child.children, target, mode);
      if (found) return true;
    }
  }
  return false;
}

function normalizeUrlForMatch(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase() + u.pathname.replace(/\/+$/, '') + u.search;
  } catch { return url.trim().toLowerCase(); }
}

// ========== 同步账号删除：常驻扩展桥接 ==========
// 同步账号书签存于 AccountBookmarks，云端是权威；直接改文件会被云端覆盖回滚。
// 删除必须经由 Chrome 自身 chrome.bookmarks API（仅扩展可调用）发出，作为“墓碑”同步上云才真生效。
// 做法：用户一次性在 Chrome 中「Load unpacked」装入随附扩展（ext/），扩展常驻并长轮询本服务；
//       删除时本服务把命令发给扩展，扩展调用官方接口删除。扩展只需安装一次，永久生效。

const EXT_DIR = path.join(__dirname, '..', 'ext');
const BM_EXT_TOKEN = 'bm-tool-local-bridge-7f3a';
const EXT_PORT = 4789; // 扩展写死的本地端口，需与本服务 PORT 一致

const extState = {
  expectedToken: BM_EXT_TOKEN,
  lastContact: 0, // 最近一次扩展活跃时间（ms），用于判断“是否已连接”
  sessionReady: null,
  sessionResolve: null,
  queue: [],
  waiters: [],
  results: new Map(),
  reqCounter: 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueueExtCommand(type, payload = {}, timeoutMs = 30000) {
  const id = ++extState.reqCounter;
  const p = new Promise((resolve, reject) => {
    extState.results.set(id, {
      resolve,
      timer: setTimeout(() => { extState.results.delete(id); reject(new Error('扩展命令超时：' + type)); }, timeoutMs),
    });
  });
  const cmd = { id, type, ...payload };
  if (extState.waiters.length) {
    const w = extState.waiters.shift();
    w.respond(cmd);
  } else {
    extState.queue.push(cmd);
  }
  return p;
}

// （Chrome for Testing 临时加载路线已废弃；同步账号删除改为常驻扩展桥接，见 deleteViaExtension）

// 经由常驻扩展桥接删除（要求扩展已连接到本服务）
async function deleteViaExtension(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return { ok: false, error: '没有要删除的书签。' };

  const connected = extState.lastContact && Date.now() - extState.lastContact < 120000; // 2 分钟窗口（MV3 SW 保活 ~40s）
  if (!connected) {
    return { ok: false, code: 'NO_EXT', error: '未检测到随附扩展（书签清理助手）。请先在 Chrome 中安装并启用随附扩展，再执行删除。', diag: { lastContact: extState.lastContact, lastSeenAgoSec: extState.lastContact ? Math.round((Date.now() - extState.lastContact) / 1000) : -1 } };
  }

  const normNoProto = (u) => {
    if (!u) return '';
    try { const U = new URL(u); return U.hostname.toLowerCase() + U.pathname.replace(/\/+$/, '') + U.search; }
    catch { return (u || '').trim().toLowerCase(); }
  };

  const t0 = Date.now();
  try {
    // getTree 可能很慢（同步账号书签多时），给 60 秒
    const treeRes = await enqueueExtCommand('getTree', {}, 60000);
    const treeMs = Date.now() - t0;
    const tree = (treeRes && treeRes.data) || [];
    console.log(`[bridge] getTree done in ${treeMs}ms, got ${tree.length} nodes`);
    const idsToRemove = [];
    const notFound = [];
    for (const item of items) {
      const want = normNoProto(item.url);
      const wantTitle = (item.title || '').trim();
      let m = tree.filter((n) => normNoProto(n.url) === want && (n.title || '').trim() === wantTitle);
      if (!m.length) m = tree.filter((n) => normNoProto(n.url) === want); // 仅按归一化 url 兜底
      if (m.length) idsToRemove.push(...m.map((x) => x.id));
      else notFound.push(item);
    }
    if (!idsToRemove.length) {
      return { ok: true, removed: 0, notFound: items.length, verified: true, isSynced: true, viaExtension: true, message: '同步账号中未找到匹配的书签，未做删除。' };
    }
    const remRes = await enqueueExtCommand('remove', { ids: idsToRemove }, 30000);
    const removed = (remRes && remRes.data && remRes.data.removed) || [];
    const tree2 = ((await enqueueExtCommand('getTree', {}, 60000)).data) || [];
    const stillThere = items.filter((it) => tree2.some((n) => normNoProto(n.url) === normNoProto(it.url) && (n.title || '').trim() === (it.title || '').trim()));
    const verified = stillThere.length === 0;
    const totalMs = Date.now() - t0;
    console.log(`[bridge] full delete done in ${totalMs}ms: removed=${removed.length} verified=${verified}`);
    return {
      ok: true, removed: removed.length, notFound: notFound.length, verified,
      isSynced: true, viaExtension: true,
      diag: { treeTookMs: treeMs, totalTookMs: totalMs, treeSize: tree.length },
      message:
        `✅ 已通过 Chrome 官方接口删除 ${removed.length} 条同步书签，删除已作为墓碑同步到 Google 账号。\n` +
        `请保持 Chrome 打开几秒，确认云端同步完成——此后这些书签不会再被"复活"。` +
        (stillThere.length ? `\n⚠️ 仍有 ${stillThere.length} 条未删除（可能在其它位置或 url 不完全匹配）。` : '') +
        (notFound.length ? `\n（另有 ${notFound.length} 条未匹配到，已跳过。）` : ''),
    };
  } catch (e) {
    const errMs = Date.now() - t0;
    console.error(`[bridge] failed after ${errMs}ms:`, e.message);
    return {
      ok: false,
      error: '删除过程中出错：' + e.message,
      code: e.message?.includes('超时') ? 'EXT_TIMEOUT' : 'EXT_ERROR',
      diag: { failedAfterMs: errMs, lastContact: extState.lastContact, activeWaiters: extState.waiters.length, queueLen: extState.queue.length },
    };
  }
}

// 经由常驻扩展桥接修改书签标题/URL（要求扩展已连接到本服务）
// body: { items: [{ url, title?, newUrl?, newTitle? }] } —— 按 url 匹配，更新其标题/URL。
// 匹配策略：先按归一化 url 精确找，找不到再按旧标题兜底。
async function updateViaExtension(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return { ok: false, error: '没有要修改的书签。' };

  const connected = extState.lastContact && Date.now() - extState.lastContact < 120000;
  if (!connected) {
    return { ok: false, code: 'NO_EXT', error: '未检测到随附扩展（书签清理助手）。请先在 Chrome 中安装并启用随附扩展，再执行修改。', diag: { lastContact: extState.lastContact } };
  }

  const normNoProto = (u) => {
    if (!u) return '';
    try { const U = new URL(u); return U.hostname.toLowerCase() + U.pathname.replace(/\/+$/, '') + U.search; }
    catch { return (u || '').trim().toLowerCase(); }
  };
  // 严格匹配：保留 query 和 fragment —— 用于判断"用户是否真的改了 URL"
  const normStrict = (u) => {
    if (!u) return '';
    try { const U = new URL(u); return U.hostname.toLowerCase() + U.pathname.replace(/\/+$/, '') + U.search + U.hash; }
    catch { return (u || '').trim().toLowerCase(); }
  };

  const t0 = Date.now();
  try {
    const treeRes = await enqueueExtCommand('getTree', {}, 60000);
    const tree = (treeRes && treeRes.data) || [];
    const changes = [];   // {id, title?, url?} —— 发给扩展的更新清单
    const notFound = [];
    const skipped = [];   // {item, reason} —— 匹配到但不需要更新的
    const failed = [];    // {id, error} —— 扩展侧 update 失败的
    for (const it of items) {
      const want = normNoProto(it.url);
      let m = tree.filter((n) => normNoProto(n.url) === want);
      if (!m.length && it.title) m = tree.filter((n) => (n.title || '').trim() === (it.title || '').trim());
      if (!m.length) { notFound.push(it); continue; }
      // 每个匹配节点生成一条更新（可能有重复节点，全部更新保持一致）
      for (const n of m) {
        const ch = { id: n.id };
        if (typeof it.newTitle === 'string' && it.newTitle !== n.title) ch.title = it.newTitle;
        // URL 更新条件：用户传了 newUrl，且严格归一化（含 query+hash）后与原 URL 不同
        // —— 修 bug:之前用 normNoProto 比较，会把"改 fragment/query"误判为"没改"，跳过更新
        if (typeof it.newUrl === 'string' && normStrict(it.newUrl) !== normStrict(n.url)) ch.url = it.newUrl;
        if (ch.title || ch.url) {
          changes.push(ch);
        } else {
          skipped.push({ url: it.url, reason: '内容未变化' });
        }
      }
    }
    if (!changes.length) {
      const msg = '未找到需要更新的书签（可能已是最新，或未匹配到）。'
        + (notFound.length ? `\n未匹配 ${notFound.length} 条。` : '')
        + (skipped.length ? `\n匹配但内容未变 ${skipped.length} 条。` : '');
      return { ok: true, updated: 0, notFound: notFound.length, skipped: skipped.length, message: msg };
    }
    const updRes = await enqueueExtCommand('update', { changes }, 30000);
    const updated = (updRes && updRes.data && updRes.data.updated) || [];
    const updatedIds = new Set(updated.map(u => u.id));
    // 找出哪些 change 失败了
    for (const ch of changes) {
      if (!updatedIds.has(ch.id)) failed.push({ id: ch.id, attempted: ch });
    }
    const totalMs = Date.now() - t0;
    console.log(`[bridge] update done in ${totalMs}ms: updated=${updated.length} changes=${changes.length} notFound=${notFound.length}`);
    return {
      ok: true,
      updated: updated.length,
      attempted: changes.length,
      notFound: notFound.length,
      skipped: skipped.length,
      failed,
      message:
        `✅ 已通过 Chrome 官方接口更新 ${updated.length} 条书签（标题/URL），修改会随 Chrome 书签同步到 Google 账号。\n` +
        `请保持 Chrome 打开几秒，确认云端同步完成。` +
        (notFound.length ? `\n⚠️ ${notFound.length} 条未在 Chrome 书签中找到匹配（可能源是导入文件，或 URL 已变）。` : '') +
        (skipped.length ? `\n(另有 ${skipped.length} 条匹配但内容已是最新，无需修改。)` : '') +
        (failed.length ? `\n❌ ${failed.length} 条扩展侧更新失败：${failed.map(f => f.attempted.url || f.attempted.title || f.id).join(', ')}` : ''),
    };
  } catch (e) {
    const errMs = Date.now() - t0;
    console.error(`[bridge] update failed after ${errMs}ms:`, e.message);
    return {
      ok: false,
      error: '修改过程中出错：' + e.message,
      code: e.message?.includes('超时') ? 'EXT_TIMEOUT' : 'EXT_ERROR',
      diag: { failedAfterMs: errMs, lastContact: extState.lastContact, activeWaiters: extState.waiters.length, queueLen: extState.queue.length },
    };
  }
}

// 经由常驻扩展桥接移动书签到目标文件夹（要求扩展已连接到本服务）
// body: { items: [{ url, title }], targetFolderPath: "书签栏/工作/xx" }
// 流程：getTree 匹配书签 id → getFolders 找到目标文件夹 id → move 命令。
async function moveViaExtension(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  const targetPath = String(body.targetFolderPath || '').trim();
  if (!items.length) return { ok: false, error: '没有要移动的书签。' };
  if (!targetPath) return { ok: false, error: '未指定目标文件夹。' };

  const connected = extState.lastContact && Date.now() - extState.lastContact < 120000;
  if (!connected) {
    return { ok: false, code: 'NO_EXT', error: '未检测到随附扩展（书签清理助手）。请先在 Chrome 中安装并启用随附扩展，再执行移动。', diag: { lastContact: extState.lastContact } };
  }

  const normNoProto = (u) => {
    if (!u) return '';
    try { const U = new URL(u); return U.hostname.toLowerCase() + U.pathname.replace(/\/+$/, '') + U.search; }
    catch { return (u || '').trim().toLowerCase(); }
  };
  // 路径标准化：trim + NFC（防 Unicode 编码差异，如全角/半角空格、零宽字符）
  const normPath = (p) => (p || '').trim().normalize('NFC').replace(/\s+/g, ' ');

  const t0 = Date.now();
  try {
    // 1. 找到目标文件夹 id（按路径精确匹配；找不到按标准化路径兜底；再找不到按同名标题）
    const foldersRes = await enqueueExtCommand('getFolders', {}, 60000);
    const folders = (foldersRes && foldersRes.data) || [];
    const normalizedTarget = normPath(targetPath);
    let target = folders.find(f => f.path === targetPath);
    if (!target) target = folders.find(f => normPath(f.path) === normalizedTarget);
    if (!target) target = folders.find(f => f.title === targetPath);
    if (!target) {
      // 在错误里找最接近的匹配（包含 / 包含前缀），帮助用户快速定位
      const partial = folders.filter(f => f.path.includes(targetPath) || targetPath.includes(f.path));
      const examples = (partial.length ? partial : folders).slice(0, 20).map(f => '  • ' + f.path);
      return {
        ok: false,
        error: `未在 Chrome 书签中找到文件夹「${targetPath}」（共 ${folders.length} 个文件夹）。` +
               (partial.length ? `\n你是不是想选：\n` + examples.join('\n') : `\n可用文件夹示例：\n` + examples.join('\n')),
      };
    }
    console.log(`[bridge] move target folder: ${target.path} (id=${target.id})`);

    // 2. 匹配要移动的书签 id
    const treeRes = await enqueueExtCommand('getTree', {}, 60000);
    const tree = (treeRes && treeRes.data) || [];
    const moves = [];
    const notFound = [];
    const alreadyThere = [];
    for (const it of items) {
      const want = normNoProto(it.url);
      let m = tree.filter(n => normNoProto(n.url) === want);
      if (!m.length && it.title) m = tree.filter(n => (n.title || '').trim() === (it.title || '').trim());
      if (!m.length) { notFound.push(it); continue; }
      for (const n of m) {
        moves.push({ id: n.id, parentId: target.id });
      }
    }
    if (!moves.length) {
      return { ok: true, moved: 0, notFound: notFound.length, message: '未找到需要移动的书签（可能未匹配到）。' + (notFound.length ? `\n有 ${notFound.length} 条未匹配。` : '') };
    }

    // 3. 执行移动
    const mvRes = await enqueueExtCommand('move', { moves }, 30000);
    const moved = (mvRes && mvRes.data && mvRes.data.moved) || [];
    const totalMs = Date.now() - t0;
    console.log(`[bridge] move done in ${totalMs}ms: moved=${moved.length}/${moves.length}`);
    return {
      ok: true,
      moved: moved.length,
      attempted: moves.length,
      notFound: notFound.length,
      target: target.path,
      message:
        `✅ 已通过 Chrome 官方接口移动 ${moved.length} 条书签到「${target.path}」，位置会随 Chrome 书签同步到 Google 账号。\n` +
        `请保持 Chrome 打开几秒，确认云端同步完成。` +
        (moved.length < moves.length ? `\n⚠️ 有 ${moves.length - moved.length} 条移动失败（可能书签已被删除）。` : '') +
        (notFound.length ? `\n（另有 ${notFound.length} 条未匹配到，已跳过。）` : ''),
    };
  } catch (e) {
    const errMs = Date.now() - t0;
    console.error(`[bridge] move failed after ${errMs}ms:`, e.message);
    return {
      ok: false,
      error: '移动过程中出错：' + e.message,
      code: e.message?.includes('超时') ? 'EXT_TIMEOUT' : 'EXT_ERROR',
      diag: { failedAfterMs: errMs, lastContact: extState.lastContact, activeWaiters: extState.waiters.length, queueLen: extState.queue.length },
    };
  }
}

// ========== HTTP 服务 ==========

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const sendJson = (code, obj) => {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(JSON.stringify(obj));
  };

  // 预检
  if (req.method === 'OPTIONS') return sendJson(204, {});

  try {
    // profiles 列表
    if (url.pathname === '/api/profiles') return sendJson(200, listProfiles());

    // 文件夹树
    if (url.pathname === '/api/folders' && req.method === 'GET') {
      const browser = url.searchParams.get('browser');
      const profile = url.searchParams.get('profile');
      const importId = url.searchParams.get('importId');
      const src = resolveSource({ browser, profile, importId });
      const loaded = src.input ? loadBookmarks({ inputFile: src.input }) : loadBookmarks({ browser: src.browser, profile: src.profile });
      const tree = buildFolderTree(loaded.folders, loaded.bookmarks);
      return sendJson(200, { ok: true, tree, total: loaded.bookmarks.length });
    }

    // 手动导入
    if (url.pathname === '/api/import' && req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '导入书签').replace(/[^\w一-龥.\- ]/g, '_').slice(0, 60);
      const content = body.content || '';
      if (!content.trim()) return sendJson(400, { ok: false, error: '文件内容为空。' });
      const isHtml = /<html|<a\s|<!doctype/i.test(content) || /\.html?$/i.test(name);
      let parsed;
      try { parsed = isHtml ? parseHtmlBookmarks(content) : parseChromeJson(JSON.parse(content)); }
      catch (e) { return sendJson(400, { ok: false, error: '无法解析该文件，请确认是 Chrome 导出的 HTML 或 Bookmarks JSON。' }); }
      if (!parsed.bookmarks.length) return sendJson(400, { ok: false, error: '该文件中没有解析到任何书签。' });
      const id = randomId();
      const filePath = path.join(UPLOADS, `import-${id}.${isHtml ? 'html' : 'json'}`);
      fs.writeFileSync(filePath, content, 'utf8');
      imports.set(id, { name, path: filePath, urlCount: parsed.bookmarks.length });
      return sendJson(200, { ok: true, id, name, urlCount: parsed.bookmarks.length });
    }

    // 开始扫描
    if (url.pathname === '/api/scan' && req.method === 'POST') {
      const body = await readBody(req);
      // Web 扫描禁用文件缓存（pipeline cache:false），保证每次点「重新扫描」都是全新真实探测；
      // 否则旧缓存（7天TTL）会让代码更新后仍返回旧错误结果。
      const jobId = randomId();
      const job = { id: jobId, status: 'running', aborted: false, progress: { done: 0, total: 0, current: '' }, report: null, error: null };
      jobs.set(jobId, job);
      sendJson(200, { ok: true, jobId });

      const folders = Array.isArray(body.folders) ? body.folders : null;
      runPipeline({
        ...resolveSource(body),
        noCheck: !body.doCheck,
        cache: false, // Web 扫描永远真实探测，不用文件缓存
        out: OUTPUT,  // 显式指定输出目录，与静态文件服务 /output/* 保持一致（避免 cwd 与 __dirname 不一致导致文件写到别处）
        removeDead: !!body.removeDead,
        sort: body.sort !== false,
        contentHash: !!body.contentHash,
        folders,
        abort: () => job.aborted,
        onProgress: (done, total, bm) => { job.progress = { done, total, current: bm?.title || bm?.url || '' }; },
      }).then(({ report }) => {
        job.report = report;
        lastReport = report;
        job.status = job.aborted ? 'stopped' : 'done';
      }).catch((e) => { job.error = e.message; job.status = 'error'; });
      return;
    }

    // 查询 job 进度
    if (url.pathname.startsWith('/api/job/') && req.method === 'GET') {
      const id = url.pathname.slice('/api/job/'.length);
      const job = jobs.get(id);
      if (!job) return sendJson(404, { ok: false, error: '任务不存在' });
      return sendJson(200, { ok: true, status: job.status, progress: job.progress, report: job.report, error: job.error });
    }

    // 停止扫描
    if (url.pathname.startsWith('/api/job/') && url.pathname.endsWith('/cancel') && req.method === 'POST') {
      const id = url.pathname.slice('/api/job/'.length, -'/cancel'.length);
      const job = jobs.get(id);
      if (!job) return sendJson(404, { ok: false, error: '任务不存在' });
      job.aborted = true;
      job.status = 'stopping';
      console.log(`[server] 取消扫描任务 ${id}`);
      return sendJson(200, { ok: true });
    }

    // 导出选中
    if (url.pathname === '/api/export-selected' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const fmt = body.format || 'html';
      if (!lastReport) return sendJson(400, { ok: false, error: '没有可用的扫描报告，请先执行扫描。' });
      if (!ids.length) return sendJson(400, { ok: false, error: '未选择任何书签。' });
      const selectedBms = ids.map((i) => lastReport.bookmarks[i]).filter(Boolean);
      if (!selectedBms.length) return sendJson(400, { ok: false, error: '选中的书签索引无效。' });
      const subReport = { ...lastReport, summary: { ...lastReport.summary, total: selectedBms.length, kept: selectedBms.length }, bookmarks: selectedBms, meta: { ...lastReport.meta, exportedAt: new Date().toISOString(), selection: `选中 ${selectedBms.length} 条` } };
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      let content, filename;
      switch (fmt) {
        case 'csv': content = toCsv(subReport); filename = `bookmarks-selected-${ts}.csv`; break;
        case 'safari': content = toSafariHtml(lastReport.tree || { type: 'folder', name: '导出', children: [] }, '选中书签'); filename = `safari-selected-${ts}.html`; break;
        default: content = toHtml(subReport); filename = `report-selected-${ts}.html`;
      }
      const outPath = path.join(OUTPUT, filename);
      ensureDir(OUTPUT);
      fs.writeFileSync(outPath, content, 'utf8');
      return sendJson(200, { ok: true, url: `/output/${filename}`, filename });
    }

    // 写回 Chrome 书签文件
    if (url.pathname === '/api/bookmarks/write' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(200, await writeBackToChrome(body));
    }

    // ===== 随行扩展通信端点 =====

    // 扩展注册（携带 token）
    if (url.pathname === '/api/ext/session' && req.method === 'POST') {
      const body = await readBody(req);
      const matched = body.token && body.token === extState.expectedToken;
      if (matched) {
        extState.lastContact = Date.now();
        if (extState.sessionResolve) { const r = extState.sessionResolve; extState.sessionResolve = null; r(); }
      }
      return sendJson(200, { ok: true, matched });
    }

    // 扩展长轮询取命令（未命中则挂起至超时返回 {type:'none'}）
    if (url.pathname === '/api/ext/command' && req.method === 'GET') {
      const token = url.searchParams.get('token');
      if (token !== extState.expectedToken) return sendJson(403, { error: 'token mismatch' });
      extState.lastContact = Date.now();
      if (extState.queue.length) {
        const cmd = extState.queue.shift();
        return sendJson(200, cmd);
      }
      let settled = false;
      const t = Math.min(parseInt(url.searchParams.get('timeout') || '20000', 10), 25000);
      const timer = setTimeout(() => { if (settled) return; settled = true; removeWaiter(); sendJson(200, { type: 'none' }); }, t);
      const waiter = {
        respond: (cmd) => { if (settled) return; settled = true; clearTimeout(timer); removeWaiter(); sendJson(200, cmd); },
      };
      function removeWaiter() { const i = extState.waiters.indexOf(waiter); if (i >= 0) extState.waiters.splice(i, 1); }
      extState.waiters.push(waiter);
      // 客户端断开（如关闭 Chrome）时及时清理，避免残留 waiter 吞掉后续命令导致删除挂起
      req.on('close', () => { if (!settled) { settled = true; clearTimeout(timer); removeWaiter(); } });
      return;
    }

    // 扩展回传命令结果
    if (url.pathname === '/api/ext/result' && req.method === 'POST') {
      const body = await readBody(req);
      const rec = extState.results.get(body.requestId);
      if (rec) { extState.results.delete(body.requestId); if (rec.timer) clearTimeout(rec.timer); rec.resolve({ ok: body.ok, data: body.data, error: body.error }); }
      return sendJson(200, { ok: true });
    }

    // 同步账号删除（经由随附常驻扩展调用 Chrome 官方接口）
    if (url.pathname === '/api/delete-synced' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(200, await deleteViaExtension(body));
    }

    // 同步账号修改标题/URL（经由随附常驻扩展调用 Chrome 官方接口）
    if (url.pathname === '/api/update-synced' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(200, await updateViaExtension(body));
    }

    // 同步账号移动书签（经由随附常驻扩展调用 Chrome 官方接口）
    if (url.pathname === '/api/move-synced' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(200, await moveViaExtension(body));
    }

    // 下载随附扩展包（zip 包含 manifest.json + background.js）
    // 每次重新打 zip，确保返回的是源码最新版本（而非项目自带的旧 zip）
    if (url.pathname === '/api/download-extension' && req.method === 'GET') {
      try {
        const extDir = path.join(__dirname, '..', 'ext');
        const manifestPath = path.join(extDir, 'manifest.json');
        const bgPath = path.join(extDir, 'background.js');
        if (!fs.existsSync(manifestPath) || !fs.existsSync(bgPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: '扩展文件不存在: ' + extDir }));
        }
        const manifestText = fs.readFileSync(manifestPath, 'utf8');
        let manifestVer = 'unknown';
        try { manifestVer = JSON.parse(manifestText).version; } catch {}
        const bgText = fs.readFileSync(bgPath, 'utf8');
        const zip = buildZip([
          { name: 'manifest.json', data: Buffer.from(manifestText, 'utf8') },
          { name: 'background.js', data: Buffer.from(bgText, 'utf8') },
        ]);
        const filename = `bm-ext-v${manifestVer}.zip`;
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': zip.length,
          'Cache-Control': 'no-store',
        });
        res.end(zip);
        console.log(`[download-extension] served ${filename} (${zip.length} bytes)`);
        return;
      } catch (e) {
        console.error('[download-extension] error:', e);
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        } catch {}
        return;
      }
    }

    // 从扩展拿实时 Chrome 文件夹列表（path 与 moveViaExtension 用同一份数据 → 选哪个都能命中）
    if (url.pathname === '/api/extension-folders' && req.method === 'GET') {
      const connected = extState.lastContact && Date.now() - extState.lastContact < 120000;
      if (!connected) {
        return sendJson(200, { ok: false, code: 'NO_EXT', error: '扩展未连接，无法读取实时 Chrome 文件夹。' });
      }
      try {
        const t0 = Date.now();
        const res = await enqueueExtCommand('getFolders', {}, 60000);
        const ms = Date.now() - t0;
        const folders = (res && res.data) || [];
        return sendJson(200, { ok: true, folders, count: folders.length, fetchedInMs: ms });
      } catch (e) {
        return sendJson(500, { ok: false, error: '扩展读取文件夹失败：' + e.message });
      }
    }

    // 随附扩展连接状态（前端用来显示"已连接/未连接"）
    if (url.pathname === '/api/ext/status' && req.method === 'GET') {
      const now = Date.now();
      const lastContact = extState.lastContact || 0;
      const connected = !!(lastContact && now - lastContact < 120000);
      const ago = lastContact ? Math.round((now - lastContact) / 1000) : -1;
      return sendJson(200, { ok: true, connected, lastContact, lastSeenAgoSec: ago });
    }

    // 健康检查：返回服务端状态 + 当前部署的 app.js BUILD（供前端做版本一致性检测）
    if (url.pathname === '/api/health' && req.method === 'GET') {
      const now = Date.now();
      const extConnected = !!(extState.lastContact && now - extState.lastContact < 120000);
      let frontendBuild = 'unknown';
      try {
        const appJsPath = path.join(PUBLIC, 'app.js');
        if (fs.existsSync(appJsPath)) {
          const match = fs.readFileSync(appJsPath, 'utf8').match(/^const BUILD = '([^']+)'/m);
          if (match) frontendBuild = match[1];
        }
      } catch {}
      return sendJson(200, {
        ok: true,
        ts: new Date().toISOString(),
        serverVersion: '1.0.5',
        frontendBuild,
        extConnected,
        lastExtContactAgoSec: extState.lastContact ? Math.round((now - extState.lastContact) / 1000) : -1,
        outputDir: path.basename(OUTPUT),
        publicDir: path.basename(PUBLIC),
      });
    }

    // 临时调试：测试 classify 逻辑（上线前删除此接口）
    if (url.pathname === '/api/debug/classify' && req.method === 'GET') {
      const { classify } = await import('./core/checker.js');
      const tests = [
        { name: 'network_error', status: 0, error: { code: 'ECONNRESET' }, body: null },
        { name: '404_no_body', status: 404, error: null, body: null },
        { name: '404_fake_wp', status: 404, error: null, body: '<!DOCTYPE HTML><html lang="zh-CN"><head><meta charset="UTF-8"><title>更好的WordPress主题</title></head><body><div><p>欢迎访问我的WordPress博客</p><a href="/about">关于</a><a href="/contact">联系</a><a href="/blog">博客</a></div></body></html>' },
        { name: '404_real', status: 404, error: null, body: '<html><head><title>404 Not Found</title></head><body><h1>404 - Page Not Found</h1></body></html>' },
        { name: 'timeout', status: 0, error: { code: 'ETIMEDOUT' }, body: null },
      ];
      const results = tests.map(t => ({ name: t.name, result: classify(t.status, t.error, t.body) }));
      return sendJson(200, { ok: true, tests: results });
    }

    // 临时调试：查看上次扫描报告中指定URL的原始数据
    if (url.pathname === '/api/debug/report-item' && req.method === 'GET') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl || !lastReport || !lastReport.bookmarks) return sendJson(400, { ok: false, error: '需要 ?url= 参数或无报告数据' });
      const item = lastReport.bookmarks.find(b => b.url === targetUrl);
      return sendJson(200, { ok: true, found: !!item, item: item || null });
    }

    // 临时调试：用当前服务器真实网络环境探测任意 URL（验证"浏览器能开却标红"的根因）
    if (url.pathname === '/api/debug/probe' && req.method === 'GET') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return sendJson(400, { ok: false, error: '需要 ?url= 参数' });
      try {
        const { checkAll } = await import('./core/checker.js');
        const map = await checkAll([{ url: targetUrl, title: targetUrl }], { doCheck: true, concurrency: 1, timeout: 15000 });
        const r = map.get(targetUrl);
        return sendJson(200, { ok: true, url: targetUrl, result: r });
      } catch (e) {
        return sendJson(500, { ok: false, error: e.message });
      }
    }

    // 清除检测缓存（代码更新后必须清缓存，否则旧错误结果会持续 7 天）
    if (url.pathname === '/api/debug/clear-cache' && req.method === 'POST') {
      try {
        fs.unlinkSync(path.join(OUTPUT, '.check-cache.json'));
        return sendJson(200, { ok: true, message: '缓存已清除，请重新扫描' });
      } catch (e) {
        return sendJson(200, { ok: true, message: '缓存文件不存在（无需清除）' });
      }
    }

    // 下载随附扩展（zip），供用户在 Chrome 中 Load unpacked
    if (url.pathname === '/api/ext/download' && req.method === 'GET') {
      const zipPath = path.join(EXT_DIR, 'bookmark-cleaner-extension.zip');
      if (!fs.existsSync(zipPath)) return sendJson(404, { ok: false, error: '扩展包尚未生成，请联系开发者。' });
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="bookmark-cleaner-extension.zip"',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      fs.createReadStream(zipPath).pipe(res);
      return;
    }

    // 强制下载 Safari 导入文件（不被浏览器直接打开渲染）
    if (url.pathname === '/api/download/safari-bookmarks' && req.method === 'GET') {
      const filePath = path.join(OUTPUT, 'safari-bookmarks.html');
      if (!fs.existsSync(filePath)) return sendJson(404, { ok: false, error: '请先执行扫描生成 Safari 导入文件。' });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="safari-bookmarks.html"',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // 导出 Safari 书签文件到「下载」目录（最简方案：用户自己打开 Safari 导入）
    if (url.pathname === '/api/safari/export' && req.method === 'POST') {
      const srcPath = path.join(OUTPUT, 'safari-bookmarks.html');
      if (!fs.existsSync(srcPath)) return sendJson(400, { ok: false, error: '请先执行扫描生成 Safari 导入文件，再导出。' });
      // 目标：~/Downloads/safari-bookmarks.html（macOS 下载目录）
      const dlDir = path.join(os.homedir(), 'Downloads');
      const dlPath = path.join(dlDir, 'safari-bookmarks.html');
      try {
        fs.mkdirSync(dlDir, { recursive: true });
        fs.copyFileSync(srcPath, dlPath);
        console.log(`[safari] exported to ${dlPath}`);
        return sendJson(200, {
          ok: true,
          file: dlPath,
          message:
            `✅ 书签文件已导出到下载目录：\n${dlPath}\n\n` +
            '接下来请手动导入到 Safari：\n' +
            '  1. 打开 Safari\n' +
            '  2. 菜单栏：文件 → 导入自 → 书签 HTML 文件…\n' +
            '  3. 选择「下载」文件夹里的 safari-bookmarks.html\n' +
            '  4. 导入完成，书签会出现在「书签整理」文件夹',
        });
      } catch (e) {
        return sendJson(500, { ok: false, error: '导出到下载目录失败：' + e.message });
      }
    }

    // 权限预检：只检查辅助功能权限，不执行任何操作（供前端展示权限状态）
    if (url.pathname === '/api/safari/check-perm' && req.method === 'GET') {
      const { execFile } = await import('node:child_process');
      const run = (args) => new Promise((res) => execFile('/usr/bin/osascript', args, { timeout: 8000 }, (e, so, se) => res({ ok: !e, err: se || (e && e.message) || '' })));
      // 仅探测权限：向 System Events 发一个无害查询，若被拒则无权限
      const probe = await run(['-e', 'tell application "System Events" to get name of first process']);
      return sendJson(200, { ok: true, permGranted: probe.ok, permError: probe.err || null });
    }

    // 静态文件
    if (url.pathname.startsWith('/output/')) {
      const file = path.join(OUTPUT, url.pathname.slice('/output/'.length));
      if (!file.startsWith(OUTPUT)) { res.writeHead(403); res.end(); return; }
      sendFile(res, file);
      return;
    }
    let file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
    sendFile(res, file);
  } catch (e) {
    sendJson(500, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`书签工具 GUI 已启动： http://localhost:${PORT}`);
  console.log('（在浏览器打开上面的地址，点「开始扫描」即可）');
});

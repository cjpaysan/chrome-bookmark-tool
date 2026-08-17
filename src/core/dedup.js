// dedup.js — 重复检测：归一化 URL 重复 + 重定向终点重复（内容哈希默认关）
import { URL } from 'node:url';

/**
 * 归一化 URL（用于重复判定）：
 * - 忽略 scheme（http/https 视为相同）
 * - host 转小写、去掉前导 www.
 * - 去掉默认端口（80/443）
 * - 去掉末尾斜杠（根路径 / 保留为 /）
 * - 去掉片段（#anchor）
 * - 保留 query（跟踪参数差异默认不合并）
 */
export function normalizeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return raw.trim().toLowerCase(); }
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  let path = u.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';
  // 重新拼：host(去www) + port + path + search，无 scheme、无 hash
  return `${host}${port}${path}${u.search}`;
}

function groupBy(bookmarks, keyFn) {
  const map = new Map();
  for (const bm of bookmarks) {
    const k = keyFn(bm);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(bm);
  }
  // 只保留 size>1 的组
  return [...map.values()].filter((g) => g.length > 1);
}

/**
 * 查找重复书签。
 * @param {Array} bookmarks
 * @param {Map} results 检测结果（url -> result，含 finalUrl）
 * @param {object} opts {contentHash?: boolean}
 * @returns {{urlGroups: Array, redirectGroups: Array, byUrl: Map}}
 */
export function findDuplicates(bookmarks, results = new Map(), opts = {}) {
  const urlGroups = groupBy(bookmarks, (bm) => normalizeUrl(bm.url));

  // 重定向终点重复：用检测阶段得到的 finalUrl 归一化后分组
  const redirectGroups = [];
  if (results.size) {
    const rg = groupBy(bookmarks, (bm) => {
      const r = results.get(bm.url);
      if (r && r.finalUrl) return normalizeUrl(r.finalUrl);
      return normalizeUrl(bm.url);
    });
    // 过滤掉与 urlGroups 完全一致的（即 finalUrl==url 的组）
    for (const g of rg) {
      const keys = new Set(g.map((bm) => normalizeUrl(bm.url)));
      if (keys.size > 1) redirectGroups.push(g); // 仅保留"URL 不同但终点相同"的组
    }
  }

  // 建立 url -> 所属重复组编号（用于报告标记）
  const byUrl = new Map();
  let gid = 0;
  for (const g of [...urlGroups, ...redirectGroups]) {
    gid++;
    for (const bm of g) {
      if (!byUrl.has(bm.url)) byUrl.set(bm.url, []);
      byUrl.get(bm.url).push(gid);
    }
  }

  return { urlGroups, redirectGroups, byUrl };
}

/**
 * 内容哈希重复（默认关闭的进阶功能）。
 * 真正的实现需抓取页面正文并比对哈希/ canonical，成本高；
 * 本测试版保留接口，默认不启用（返回空）。
 */
export function findContentDuplicates() {
  return [];
}

export default { normalizeUrl, findDuplicates, findContentDuplicates };

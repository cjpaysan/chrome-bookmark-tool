// pipeline.js — 串联整条管线（CLI 与 Web 共用）
import fs from 'node:fs';
import path from 'node:path';
import { loadBookmarks, findChromiumProfiles, findChromeProfiles, matchesSelectedFolders } from './parser.js';
import { checkAll } from './checker.js';
import { findDuplicates } from './dedup.js';
import { organize } from './organizer.js';
import { assemble, toHtml, toCsv, toJson } from './reporter.js';
import { toSafariHtml } from './safari-export.js';
import { ResultStore } from './store.js';
import { ensureDir } from './util.js';

export async function runPipeline(opts = {}) {
  const out = opts.out || path.join(process.cwd(), 'output');
  ensureDir(out);

  const loaded = loadBookmarks({ profile: opts.profile, inputFile: opts.input });
  // 仅扫描所选文件夹（及其子文件夹）内的书签；不传或为空则全扫
  let bookmarks = loaded.bookmarks;
  const folders = opts.folders && opts.folders.length ? opts.folders : null;
  if (folders) {
    bookmarks = bookmarks.filter((b) => matchesSelectedFolders(b.folderPath, folders));
  }

  let results = new Map();
  if (!opts.noCheck) {
    // Web 场景（cache===false）不用文件缓存，永远真实探测 —— 否则旧缓存（7天TTL）会让
    // 代码更新后仍返回旧错误结果，正是"改了代码误报不变"的元凶。
    const store = opts.cache === false ? null : new ResultStore(path.join(out, '.check-cache.json'));
    results = await checkAll(bookmarks, {
      concurrency: opts.concurrency || 25,
      perHost: opts.perHost || 6,
      timeout: opts.timeout || 12000,
      cache: store,
      abort: typeof opts.abort === 'function' ? opts.abort : () => false,
    }, { onProgress: opts.onProgress });
    if (store) await store.flush();
  }

  const dup = findDuplicates(bookmarks, results, { contentHash: opts.contentHash });
  const organizeResult = organize(bookmarks, results, dup, { removeDead: opts.removeDead, sort: opts.sort !== false });
  const report = assemble({ bookmarks, results, dup, organizeResult, meta: { profile: loaded.profile || opts.input || 'import' } });

  const outputs = {
    html: path.join(out, 'report.html'),
    csv: path.join(out, 'report.csv'),
    json: path.join(out, 'report.json'),
    safari: path.join(out, 'safari-bookmarks.html'),
  };
  fs.writeFileSync(outputs.html, toHtml(report));
  fs.writeFileSync(outputs.csv, toCsv(report));
  fs.writeFileSync(outputs.json, toJson(report));
  fs.writeFileSync(outputs.safari, toSafariHtml(organizeResult.tree));

  return { report, outputs, summary: report.summary, bookmarks: report.bookmarks };
}

export { findChromiumProfiles, findChromeProfiles };
export default { runPipeline, findChromiumProfiles, findChromeProfiles };

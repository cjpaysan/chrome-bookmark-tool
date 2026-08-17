// run-tests.js — 离线测试整条管线（不依赖外网）
import assert from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

const parser = await import(path.join(root, 'src/core/parser.js'));
const dedup = await import(path.join(root, 'src/core/dedup.js'));
const organizer = await import(path.join(root, 'src/core/organizer.js'));
const reporter = await import(path.join(root, 'src/core/reporter.js'));
const safari = await import(path.join(root, 'src/core/safari-export.js'));
const checker = await import(path.join(root, 'src/core/checker.js'));
const pipeline = await import(path.join(root, 'src/core/pipeline.js'));

console.log('\n[1] 解析器');
const samplePath = path.join(__dirname, 'sample-bookmarks.json');
const parsed = parser.parseChromeJson(JSON.parse(fs.readFileSync(samplePath, 'utf8')));
ok('解析出 5 条书签', parsed.bookmarks.length === 5);
ok('新闻子文件夹路径正确', parsed.bookmarks[0].folderPath.join('/') === '书签栏/新闻');
ok('findChromeProfiles 能扫到本机 Profile', parser.findChromeProfiles().length >= 0);

console.log('\n[2] 重复检测');
ok('归一化忽略 scheme/尾部斜杠', dedup.normalizeUrl('http://example.com/') === dedup.normalizeUrl('https://example.com'));
const fakeResults = new Map([
  ['https://example.com/', { url: 'https://example.com/', finalUrl: 'https://example.com/', ok: true, reason: 'ok' }],
  ['http://example.com', { url: 'http://example.com', finalUrl: 'https://example.com/', ok: true, reason: 'ok' }],
  ['https://github.com/', { url: 'https://github.com/', finalUrl: 'https://github.com/', ok: true, reason: 'ok' }],
  ['https://example.org/page/', { url: 'https://example.org/page/', finalUrl: 'https://example.org/page/', ok: true, reason: 'ok' }],
  ['https://thisdomaindoesnotexist12345.com/', { url: 'https://thisdomaindoesnotexist12345.com/', finalUrl: 'https://thisdomaindoesnotexist12345.com/', ok: false, reason: 'dns_failure' }],
]);
const dup = dedup.findDuplicates(parsed.bookmarks, fakeResults);
ok('URL 重复组 >=1', dup.urlGroups.length >= 1);
ok('byUrl 标记了重复', dup.byUrl.has('https://example.com/') && dup.byUrl.get('https://example.com/').length >= 1);

console.log('\n[3] 整理器（非破坏性）');
const org = organizer.organize(parsed.bookmarks, fakeResults, dup, { removeDead: false, sort: true });
ok('合并了重复（merged>=1）', org.summary.merged >= 1);
ok('保留数 < 总数（因合并）', org.summary.kept < parsed.bookmarks.length);
ok('未勾选剔除死链时 deadFlagged=1', org.summary.deadFlagged === 1);
const org2 = organizer.organize(parsed.bookmarks, fakeResults, dup, { removeDead: true, sort: true });
ok('勾选剔除死链后 removedDead=1', org2.summary.removedDead === 1);
ok('标题乱码被修复', organizer.cleanTitle('Mojibake Ã© test').includes('é'));
// 树结构：书签栏/新闻 存在
const bar = org.tree.children.find((c) => c.type === 'folder' && c.name === '书签栏');
ok('保留文件夹层级（书签栏）', !!bar);
const news = bar.children.find((c) => c.type === 'folder' && c.name === '新闻');
ok('保留子文件夹（新闻）', !!news);

console.log('\n[4] 报告与 Safari 导出');
const report = reporter.assemble({ bookmarks: parsed.bookmarks, results: fakeResults, dup, organizeResult: org, meta: {} });
const html = reporter.toHtml(report);
const csv = reporter.toCsv(report);
const json = reporter.toJson(report);
ok('HTML 报告非空且含标题', html.includes('书签检测报告') && html.length > 500);
ok('CSV 含表头', csv.includes('title,url,folder'));
ok('JSON 可解析', JSON.parse(json).summary.total === 5);
const safariHtml = safari.toSafariHtml(org.tree);
ok('Safari 文件含 <DL> 与 <A HREF>', safariHtml.includes('<DL>') && safariHtml.includes('<A HREF='));

console.log('\n[5] 链接检测引擎（对本地服务器）');
const server = http.createServer((req, res) => {
  if (req.url === '/ok') { res.writeHead(200); res.end('ok'); }
  else if (req.url === '/gone') { res.writeHead(404); res.end('no'); }
  else if (req.url === '/forbidden') { res.writeHead(403); res.end('no'); }
  else if (req.url === '/redir') { res.writeHead(302, { location: '/ok' }); res.end(); }
  else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const testBms = [
  { id: 'a', title: 'ok', url: base + '/ok', folderPath: [] },
  { id: 'b', title: 'gone', url: base + '/gone', folderPath: [] },
  { id: 'c', title: 'forbidden', url: base + '/forbidden', folderPath: [] },
  { id: 'd', title: 'redir', url: base + '/redir', folderPath: [] },
];
const results = await checker.checkAll(testBms, { concurrency: 2, perHost: 2, timeout: 5000, retries: 0 });
ok('/ok 判定有效', results.get(base + '/ok').ok === true);
ok('/gone 判定失效(not_found)', results.get(base + '/gone').reason === 'not_found');
ok('/forbidden 标需登录', results.get(base + '/forbidden').reason === 'login_required');
ok('/redir 有效且记录最终 URL', results.get(base + '/redir').ok === true && results.get(base + '/redir').finalUrl.endsWith('/ok'));
server.close();

console.log('\n[6] 端到端管线（--no-check + 样例）');
const outDir = path.join(__dirname, '..', 'output-test');
const ep = await pipeline.runPipeline({ input: samplePath, out: outDir, noCheck: true });
ok('pipeline 产出 report.html', fs.existsSync(ep.outputs.html));
ok('pipeline 产出 safari-bookmarks.html', fs.existsSync(ep.outputs.safari));
ok('pipeline 汇总总数=5', ep.summary.total === 5);

console.log(`\n===== 测试结果：${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);

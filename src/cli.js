#!/usr/bin/env node
// cli.js — 命令行入口
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline, findChromeProfiles } from './core/pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') opts.profile = argv[++i];
    else if (a === '--input') opts.input = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--no-check') opts.noCheck = true;
    else if (a === '--remove-dead') opts.removeDead = true;
    else if (a === '--no-sort') opts.sort = false;
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i]);
    else if (a === '--per-host') opts.perHost = Number(argv[++i]);
    else if (a === '--content-hash') opts.contentHash = true;
    else if (a === 'scan' || a === 'profiles') opts.cmd = a;
  }
  opts.cmd = opts.cmd || 'scan';
  opts.out = opts.out || path.join(__dirname, '..', 'output');
  opts.sort = opts.sort !== false;
  return opts;
}

async function cmdProfiles() {
  const ps = findChromeProfiles();
  if (!ps.length) { console.log('未找到 Chrome Profile。'); return; }
  console.log('检测到 Chrome Profile：');
  ps.forEach((p) => console.log(`  - ${p.name}  (${p.path})`));
}

async function cmdScan(opts) {
  console.log(`▶ 载入书签（来源：${opts.input ? opts.input : 'Chrome ' + (opts.profile || '默认')}）`);
  const lastPct = { v: -1 };
  const { report, outputs, summary } = await runPipeline({
    ...opts,
    onProgress: (done, t) => {
      const pct = Math.floor((done / t) * 100);
      if (pct !== lastPct.v && pct % 10 === 0) { process.stdout.write(`  …${pct}% (${done}/${t})\n`); lastPct.v = pct; }
    },
  });
  console.log(`  共 ${summary.total} 条书签`);
  console.log('\n===== 汇总 =====');
  console.log(`书签总数      : ${summary.total}`);
  console.log(`  有效        : ${summary.statusCounts?.valid || 0}`);
  console.log(`  失效        : ${summary.statusCounts?.dead || 0}`);
  console.log(`  需登录      : ${summary.statusCounts?.login || 0}`);
  console.log(`  未检测      : ${summary.statusCounts?.unknown || 0}`);
  console.log(`重复合并      : ${summary.merged} 条`);
  console.log(`整理后保留    : ${summary.kept} 条`);
  if (opts.removeDead) console.log(`（已剔除死链 : ${summary.removedDead} 条）`);
  console.log('\n===== 输出文件 =====');
  console.log(`报告 HTML  : ${outputs.html}`);
  console.log(`报告 CSV   : ${outputs.csv}`);
  console.log(`报告 JSON  : ${outputs.json}`);
  console.log(`Safari 导入: ${outputs.safari}  （Safari ▸ 文件 ▸ 导入书签 选择此文件）`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.cmd === 'profiles') return cmdProfiles();
  if (opts.cmd === 'scan') return cmdScan(opts);
  console.log('用法：node src/cli.js scan [--profile 名称] [--input 文件] [--out 目录] [--no-check] [--remove-dead] [--no-sort] [--concurrency N] [--per-host N]');
}

main().catch((e) => { console.error('错误：', e.message); process.exit(1); });

#!/usr/bin/env node
// sync-version.mjs — 从 package.json 自动注入版本号到 app.js 的 BUILD 字符串
// 解决问题：手工维护 BUILD 字符串与 package.json version 经常脱钩。
// 用法：node scripts/sync-version.mjs
// 自动：npm run dist 已自动调用

import fs from 'node:fs';
import path from 'node:path';

const PKG = path.join(process.cwd(), 'package.json');
const APP_JS = path.join(process.cwd(), 'public', 'app.js');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
const v = pkg.version;

// 用 ISO 时间戳（精确到分钟，够用且稳定）
const now = new Date();
const ts = now.toISOString().slice(0, 16); // 2026-08-16T21:55
const newBuild = `v${v} @ ${ts}`;

let src = fs.readFileSync(APP_JS, 'utf8');
// 匹配 const BUILD = '...' （; 和 // 注释都可选，兼容有无注释两种格式）
const re = /^const BUILD = '[^']*';?(\s*\/\/[^\n]*)?$/m;
const m = src.match(re);
if (!m) {
  console.error('❌ 找不到 const BUILD = ... 行，请手动检查 app.js');
  process.exit(1);
}
const newLine = `const BUILD = '${newBuild}';`;
src = src.replace(re, newLine);

// VERSION 也要同步
const vRe = /^const VERSION = '[^']*';/m;
const vMatch = src.match(vRe);
if (vMatch) {
  src = src.replace(vRe, `const VERSION = '${v}';`);
}

fs.writeFileSync(APP_JS, src);

console.log(`✅ BUILD 注入成功`);
console.log(`   package.json version: ${v}`);
console.log(`   app.js BUILD:        ${newBuild}`);
console.log(`   app.js VERSION:      ${v}`);
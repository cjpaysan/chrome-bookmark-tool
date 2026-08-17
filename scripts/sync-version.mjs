#!/usr/bin/env node
// sync-version.mjs — 把 displayVersion 注入 app.js 的 VERSION / BUILD 字符串
// 解决问题：手工维护 BUILD 与版本号经常脱钩；并确保界面显示的是四段展示版本。
// 用法：node scripts/sync-version.mjs
// 自动：打包脚本已自动调用

import fs from 'node:fs';
import path from 'node:path';

const PKG = path.join(process.cwd(), 'package.json');
const APP_JS = path.join(process.cwd(), 'public', 'app.js');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
const v = pkg.displayVersion || pkg.version;

// 用 ISO 时间戳（精确到分钟，够用且稳定）破静态资源缓存
const now = new Date();
const ts = now.toISOString().slice(0, 16); // 2026-08-16T21:55
const newBuild = `v${v} @ ${ts}`;

let src = fs.readFileSync(APP_JS, 'utf8');

// 匹配 const BUILD = '...' （; 和 // 注释都可选）
const re = /^const BUILD = '[^']*';?(\s*\/\/[^\n]*)?$/m;
if (!re.test(src)) {
  console.error('❌ 找不到 const BUILD = ... 行，请手动检查 app.js');
  process.exit(1);
}
src = src.replace(re, `const BUILD = '${newBuild}';`);

// VERSION 同步为四段展示版
const vRe = /^const VERSION = '[^']*';/m;
if (vRe.test(src)) {
  src = src.replace(vRe, `const VERSION = '${v}';`);
} else {
  src = `const VERSION = '${v}';\n` + src;
}

fs.writeFileSync(APP_JS, src);

console.log(`✅ 版本注入成功`);
console.log(`   displayVersion : ${v}`);
console.log(`   app.js BUILD    : ${newBuild}`);
console.log(`   app.js VERSION  : ${v}`);

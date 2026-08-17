#!/usr/bin/env node
// bump-version.mjs — 自动递增 package.json 的 patch 版本号
// 用法：node scripts/bump-version.mjs [major|minor|patch]
// 默认 patch。无需 git 依赖（--no-git-tag-version 等价效果）。
//
// 设计：
// 1. 读 package.json 当前 version（SemVer: MAJOR.MINOR.PATCH）
// 2. 按指定级别 +1，其它级别归零
// 3. 写回 package.json
// 4. 同步输出版本号，让调用者（npm scripts）捕获到

import fs from 'node:fs';
import path from 'node:path';

const PKG = path.join(process.cwd(), 'package.json');
const level = (process.argv[2] || 'patch').toLowerCase();

if (!['major', 'minor', 'patch'].includes(level)) {
  console.error('❌ level 必须是 major/minor/patch');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(Number);
let next;
if (level === 'major') next = `${maj + 1}.0.0`;
else if (level === 'minor') next = `${maj}.${min + 1}.0`;
else next = `${maj}.${min}.${pat + 1}`;

pkg.version = next;
// 加 build 时间戳（仅作记录，不影响 SemVer 解析）
pkg._buildAt = new Date().toISOString();
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');

console.log(`✅ version bumped → ${next}`);
console.log(`   (level=${level}, was ${maj}.${min}.${pat})`);
// 同时让 npm scripts 能拿到新版本（写到 stdout 末尾）
console.log(`__VERSION__=${next}`);
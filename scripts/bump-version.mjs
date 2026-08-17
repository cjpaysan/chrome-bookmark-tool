#!/usr/bin/env node
// bump-version.mjs — 按改动量递增版本号（双字段设计）
//
// 两个字段：
//   version        : 三段 SemVer（MAJOR.MINOR.PATCH），仅供 electron-builder 读取；
//                    必须是合法 SemVer，否则构建会被 app-builder-lib 拒绝。
//   displayVersion : 四段展示版（MAJOR.MINOR.PATCH.BUILD），界面与 DMG 文件名使用，
//                    不受 SemVer 限制，可自由带第四位。
//
// 用法：node scripts/bump-version.mjs [major|minor|patch|build]
// 默认 build（极小改动，仅第四位 +1）。
//
// 增量规则（改动量 → 增量大小）：
//   build : 极小改动（几行 hotfix）    → 1.2.0.0 → 1.2.0.1
//   patch : 小改动（一个功能/若干文件）→ 1.2.0.0 → 1.2.1.0
//   minor : 中等改动（新功能模块）     → 1.2.0.0 → 1.3.0.0
//   major : 大改（架构/重写）          → 1.2.0.0 → 2.0.0.0
// 说明：build 之外的级别都会把第四位 BUILD 归零，保持版本语义单调。

import fs from 'node:fs';
import path from 'node:path';

const PKG = path.join(process.cwd(), 'package.json');
const level = (process.argv[2] || 'build').toLowerCase();

if (!['major', 'minor', 'patch', 'build'].includes(level)) {
  console.error('❌ level 必须是 major/minor/patch/build');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));

// 解析四段 displayVersion（缺省时从 version 派生，第四段补 0）
function parseFour(s) {
  const parts = String(s).split('.').map((x) => parseInt(x, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts[3] || 0];
}

let [maj, min, pat, bld] = parseFour(pkg.displayVersion || pkg.version);

switch (level) {
  case 'major': maj += 1; min = 0; pat = 0; bld = 0; break;
  case 'minor': min += 1; pat = 0; bld = 0; break;
  case 'patch': pat += 1; bld = 0; break;
  case 'build': bld += 1; break;
}

const displayVersion = `${maj}.${min}.${pat}.${bld}`;
const version = `${maj}.${min}.${pat}`; // 三段，合法 SemVer

pkg.displayVersion = displayVersion;
pkg.version = version;
pkg._buildAt = new Date().toISOString();

fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');

console.log(`✅ version bumped (${level})`);
console.log(`   displayVersion   : ${displayVersion}`);
console.log(`   version (semver) : ${version}`);

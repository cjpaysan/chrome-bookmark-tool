// util.js — 小工具
import fs from 'node:fs';

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// store.js — 本地结果缓存（断点续跑）：JSON 文件存储
import fs from 'node:fs';
import path from 'node:path';

export class ResultStore {
  constructor(file) {
    this.file = file;
    this.ttl = 7 * 864e5; // 7 天
    this.map = new Map();
    this._dirty = false;
    this._saving = false;
    if (file && fs.existsSync(file)) {
      try {
        const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.map = new Map(obj);
      } catch { this.map = new Map(); }
    }
  }

  get(url) { return this.map.get(url); }

  async set(url, result) {
    this.map.set(url, result);
    this._dirty = true;
    this._scheduleSave();
  }

  _scheduleSave() {
    if (this._saving) return;
    this._saving = true;
    setTimeout(() => {
      this._saving = false;
      if (!this._dirty || !this.file) return;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify([...this.map.entries()]));
        this._dirty = false;
      } catch (e) { /* 忽略写入错误 */ }
    }, 500);
  }

  async flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify([...this.map.entries()]));
  }
}

export default { ResultStore };

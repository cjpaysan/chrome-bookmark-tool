// reporter.js — 报告生成（HTML / CSV / JSON）
import { escapeHtml } from './util.js';

// 失效/需登录等原因的中文含义（与前端 app.js 的 REASON_CN 保持一致），方便小白用户看懂
const REASON_CN = {
  login_required: '需要登录 / 授权',
  dns_failure: '域名解析失败（网址打不开）',
  not_found: '页面不存在（404）',
  network: '网络连接失败',
  connection_refused: '连接被拒绝（服务器拒接）',
  connection_reset: '连接被远程重置（可能是反爬或瞬时故障）',
  timeout: '连接超时（反应太慢）',
  http_client_error: '客户端错误（400-499）',
  http_server_error: '服务器错误（500+）',
  invalid_url: '链接格式非法',
  too_many_redirects: '跳转次数过多',
  unknown: '未知原因',
  aborted: '检测已停止',
  unchecked: '未检测',
};
// 原因显示：有效的留空；其余返回「中文（英文）」
function reasonCn(reason, status) {
  if (status === 'valid') return '';
  const cn = REASON_CN[reason];
  if (!cn) return reason || '';
  return `${cn}（${reason}）`;
}

/**
 * 汇总成统一报告对象。
 */
export function assemble({ bookmarks, results, dup, organizeResult, meta = {} }) {
  const rows = bookmarks.map((bm) => {
    const r = results.get(bm.url);
    const status = r ? (r.ok ? 'valid' : (r.reason === 'login_required' ? 'login' : (r.suspicious ? 'suspect' : 'dead'))) : 'unknown';
    const groups = dup.byUrl.get(bm.url) || [];
    return {
      title: bm.title || bm.url,
      url: bm.url,
      folder: (bm.folderPath || []).join(' / '),
      status,
      reason: r ? r.reason : 'unchecked',
      suspicious: r ? !!r.suspicious : false,
      note: r ? (r.note || null) : null,
      finalUrl: r && r.finalUrl !== bm.url ? r.finalUrl : '',
      dupGroups: groups,
      redundant: groups.length > 0,
    };
  });

  const dupView = {
    urlGroups: dup.urlGroups.map((g) => g.map((bm) => ({ title: bm.title, url: bm.url, folder: (bm.folderPath || []).join(' / ') }))),
    redirectGroups: dup.redirectGroups.map((g) => g.map((bm) => ({ title: bm.title, url: bm.url, folder: (bm.folderPath || []).join(' / '), finalUrl: (results.get(g[0].url) || {}).finalUrl || '' }))),
  };

  const statusCounts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});

  return {
    meta: { generatedAt: new Date().toISOString(), ...meta },
    summary: { ...organizeResult.summary, statusCounts },
    bookmarks: rows,
    duplicates: dupView,
    tree: organizeResult.tree,
  };
}

export function toJson(report) {
  return JSON.stringify(report, null, 2);
}

export function toCsv(report) {
  const header = ['title', 'url', 'folder', 'status', 'reason', 'finalUrl', 'duplicate_group', 'redundant'];
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [header.join(',')];
  for (const r of report.bookmarks) {
    lines.push([
      esc(r.title), esc(r.url), esc(r.folder), esc(r.status), esc(reasonCn(r.reason, r.status)),
      esc(r.finalUrl), esc(r.dupGroups.join('|')), esc(r.redundant ? 'yes' : ''),
    ].join(','));
  }
  // BOM 头，保证 Excel 正确识别 UTF-8
  return '﻿' + lines.join('\n');
}

export function toHtml(report) {
  const s = report.summary;
  const statusColor = { valid: '#1a7f37', dead: '#cf222e', login: '#bf8700', unknown: '#6e7781', suspect: '#d4a017' };
  const statusLabel = { valid: '有效', dead: '失效', login: '需登录', unknown: '未检测', suspect: '疑似失效' };

  const summaryCards = `
    <div class="cards">
      <div class="card"><b>${s.total}</b><span>书签总数</span></div>
      <div class="card ok"><b>${s.statusCounts?.valid || 0}</b><span>有效</span></div>
      <div class="card bad"><b>${s.statusCounts?.dead || 0}</b><span>失效</span></div>
      <div class="card warn"><b>${s.statusCounts?.login || 0}</b><span>需登录</span></div>
      <div class="card warn"><b>${s.statusCounts?.suspect || 0}</b><span>疑似失效</span></div>
      <div class="card"><b>${s.merged}</b><span>合并重复</span></div>
      <div class="card"><b>${s.kept}</b><span>整理后保留</span></div>
    </div>`;

  const rows = report.bookmarks.map((r) => {
    const c = statusColor[r.status] || '#6e7781';
    const reasonShown = r.suspicious
      ? '⚠️ ' + reasonCn(r.reason, r.status) + ' 建议手动确认' + (r.note ? `<br><small style="color:#8B6914">${escapeHtml(r.note)}</small>` : '')
      : reasonCn(r.reason, r.status);
    return `<tr>
      <td><span class="dot" style="background:${c}"></span>${escapeHtml(r.title)}</td>
      <td><a href="${escapeHtml(r.url)}" target="_blank">${escapeHtml(r.url)}</a></td>
      <td>${escapeHtml(r.folder)}</td>
      <td style="color:${c}">${statusLabel[r.status] || r.status}</td>
      <td>${escapeHtml(reasonShown)}</td>
      <td>${r.dupGroups.length ? '组' + r.dupGroups.join(',') : ''}</td>
    </tr>`;
  }).join('');

  const dupBlocks = [...report.duplicates.urlGroups, ...report.duplicates.redirectGroups].map((g, i) => {
    const items = g.map((b) => `<li><a href="${escapeHtml(b.url)}" target="_blank">${escapeHtml(b.title || b.url)}</a>${b.finalUrl ? ` → <code>${escapeHtml(b.finalUrl)}</code>` : ''}</li>`).join('');
    return `<div class="dup"><h4>重复组 #${i + 1}（${g.length} 条）</h4><ul>${items}</ul></div>`;
  }).join('') || '<p class="muted">未发现重复书签。</p>';

  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>书签检测报告</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:24px;color:#1f2328;background:#f6f8fa}
  h1{font-size:20px;margin:0 0 4px}
  .meta{color:#6e7781;font-size:13px;margin-bottom:16px}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px}
  .card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:12px 16px;min-width:90px}
  .card b{display:block;font-size:22px}.card span{font-size:12px;color:#6e7781}
  .card.ok b{color:#1a7f37}.card.bad b{color:#cf222e}.card.warn b{color:#bf8700}
  table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}
  th,td{border:1px solid #d0d7de;padding:6px 8px;text-align:left;vertical-align:top}
  th{background:#eaeef2}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
  a{color:#0969da;text-decoration:none}.a:hover{text-decoration:underline}
  code{background:#eaeef2;padding:1px 4px;border-radius:3px;font-size:12px}
  .dup{border:1px solid #d0d7de;border-radius:8px;padding:8px 14px;margin:8px 0;background:#fff}
  .dup h4{margin:6px 0}.dup ul{margin:4px 0;padding-left:20px}
  .muted{color:#6e7781}
  h2{font-size:16px;margin-top:28px;border-bottom:1px solid #d0d7de;padding-bottom:6px}
</style></head>
<body>
  <h1>书签检测报告</h1>
  <div class="meta">生成时间：${report.meta.generatedAt}${report.meta.profile ? ' ｜ Profile：' + escapeHtml(report.meta.profile) : ''}</div>
  ${summaryCards}
  <h2>书签明细</h2>
  <table><thead><tr><th>标题</th><th>URL</th><th>所属文件夹</th><th>状态</th><th>原因</th><th>重复组</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <h2>重复 / 冗余书签（${report.duplicates.urlGroups.length + report.duplicates.redirectGroups.length} 组）</h2>
  ${dupBlocks}
</body></html>`;
}

export default { assemble, toJson, toCsv, toHtml };

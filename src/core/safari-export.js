// safari-export.js — 生成 Safari / Chrome 可导入的 Netscape 格式书签文件
import { escapeHtml } from './util.js';

function renderNode(node, depth) {
  const pad = '    '.repeat(depth);
  if (node.type === 'folder') {
    const inner = node.children.map((c) => renderNode(c, depth + 1)).join('\n');
    return `${pad}<DT><H3>${escapeHtml(node.name)}</H3>\n${pad}<DL><p>\n${inner}\n${pad}</DL><p>`;
  }
  // bookmark
  const addDate = node.addDate ? Math.floor(node.addDate / 1000) : Math.floor(Date.now() / 1000);
  return `${pad}<DT><A HREF="${escapeHtml(node.url)}" ADD_DATE="${addDate}">${escapeHtml(node.title)}</A>`;
}

/**
 * 把整理后的树导出为 Netscape 书签 HTML。
 * @param {object} tree organize() 返回的树（根节点 type:'folder'）
 * @param {string} [rootName]
 */
export function toSafariHtml(tree, rootName = '书签整理') {
  const body = (tree.children || []).map((c) => renderNode(c, 1)).join('\n');
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3>${escapeHtml(rootName)}</H3>
    <DL><p>
${body}
    </DL><p>
</DL><p>
`;
}

export default { toSafariHtml, toChromeHtml };

/**
 * 把「待删除书签列表」导出为 Chrome / Safari 可导入的 Netscape 格式 HTML。
 * 与 toSafariHtml 同格式（Chrome 的「导入书签」→「书签 HTML 文件」可直接读取）。
 * @param {Array<{url,title,folder?}>} items 待删书签（folder 可为路径数组或字符串）
 * @param {string} [rootName]
 */
export function toChromeHtml(items, rootName = '书签清理备份') {
  const root = { type: 'folder', name: rootName, children: [] };
  const findOrCreate = (parent, name) => {
    let f = parent.children.find((c) => c.type === 'folder' && c.name === name);
    if (!f) { f = { type: 'folder', name, children: [] }; parent.children.push(f); }
    return f;
  };
  for (const it of (items || [])) {
    const folderPath = Array.isArray(it.folder)
      ? it.folder.filter(Boolean)
      : (it.folder ? [String(it.folder)] : []);
    let parent = root;
    for (const seg of folderPath) parent = findOrCreate(parent, seg);
    parent.children.push({
      type: 'bookmark',
      url: it.url || '',
      title: it.title || it.url || '（无标题）',
      addDate: Date.now(),
    });
  }
  return toSafariHtml(root, rootName);
}


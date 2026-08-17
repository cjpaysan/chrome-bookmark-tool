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

export default { toSafariHtml };

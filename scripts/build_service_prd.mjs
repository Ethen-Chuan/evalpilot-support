import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'docs/SERVICE_PLATFORM_PRD.md'), 'utf8');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const inline = value => escape(value).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/https:\/\/[^\s。<]+/g, url => `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`);
const sections = [];
const blocks = [];
const lines = source.split('\n');
let list = '';
const closeList = () => { if (list) { blocks.push(`</${list}>`); list = ''; } };
for (let index = 0; index < lines.length; index++) {
  const line = lines[index].trim();
  if (!line) { closeList(); continue; }
  if (/^#{1,4} /.test(line)) {
    closeList();
    const level = line.match(/^#+/)[0].length;
    const title = line.slice(level + 1);
    const anchor = `section-${index}`;
    if (level === 2) sections.push({ title, anchor });
    blocks.push(`<h${level} id="${anchor}">${inline(title)}</h${level}>`);
    continue;
  }
  if (line === '---') { closeList(); blocks.push('<hr>'); continue; }
  if (line.startsWith('|') && lines[index + 1]?.trim().match(/^\|[\s:|-]+\|$/)) {
    closeList();
    const cells = row => row.trim().slice(1, -1).split('|').map(value => value.trim());
    blocks.push('<div class="table-scroll"><table><thead><tr>' + cells(line).map(value => `<th scope="col">${inline(value)}</th>`).join('') + '</tr></thead><tbody>');
    index += 2;
    while (index < lines.length && lines[index].trim().startsWith('|')) { blocks.push('<tr>' + cells(lines[index]).map(value => `<td>${inline(value)}</td>`).join('') + '</tr>'); index++; }
    index--;
    blocks.push('</tbody></table></div>');
    continue;
  }
  const match = line.match(/^(- |\d+\. )(.*)/);
  if (match) {
    const type = match[1].startsWith('-') ? 'ul' : 'ol';
    if (type !== list) { closeList(); list = type; blocks.push(`<${type}>`); }
    blocks.push(`<li>${inline(match[2])}</li>`);
    continue;
  }
  closeList();
  blocks.push(`<p>${inline(line)}</p>`);
}
closeList();
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="EvalPilot智能对话客服平台产品需求文档，含岗位研究、功能规格、验收指标、设计系统与迭代路线图。"><title>EvalPilot · 智能服务平台 PRD V2.0</title><style>
:root{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#253044;background:#f6f7fa;font-synthesis:none}*{box-sizing:border-box}body{margin:0}a{color:#2153b8;text-underline-offset:3px}a:focus-visible{outline:3px solid #245cdb;outline-offset:3px}.top{height:62px;border-bottom:1px solid #d7dfe9;background:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 30px;position:sticky;top:0;z-index:3}.brand{font-size:18px;font-weight:650;letter-spacing:-.4px;color:#253044;text-decoration:none}.brand span{font-size:10px;letter-spacing:1px;margin-left:16px;color:#536176;font-weight:400}.top>a:last-child{font-size:12px}.layout{display:grid;grid-template-columns:255px minmax(0,1fr);max-width:1550px;margin:0 auto}nav{padding:30px 20px;position:sticky;top:62px;height:calc(100vh - 62px);overflow:auto}nav>span{font-size:10px;letter-spacing:1.5px;color:#6d788a;display:block;margin-bottom:18px}nav a{display:block;font-size:12px;line-height:1.7;padding:7px 8px;color:#536176;text-decoration:none;border-radius:4px}nav a:hover{background:#edf3ff;color:#2153b8}main{padding:45px 52px 80px;background:#fff;border-inline:1px solid #e5e9f0;min-width:0}h1{font-size:35px;line-height:1.45;letter-spacing:-1px;font-weight:650;margin:0 0 16px}h2{font-size:25px;line-height:1.5;letter-spacing:-.4px;margin:52px 0 20px;padding-top:10px;scroll-margin-top:80px}h2:first-of-type{font-size:20px;font-weight:450;color:#536176;margin-top:0}h3{font-size:18px;margin:30px 0 12px;line-height:1.6}p,li{font-size:14px;line-height:1.95}p{margin:12px 0}li{margin:7px 0}ul,ol{padding-left:23px}hr{border:0;border-top:1px solid #e5e9f0;margin:35px 0}.table-scroll{overflow:auto;border:1px solid #d7dfe9;border-radius:6px;margin:20px 0}table{border-collapse:collapse;width:100%;font-size:12px;line-height:1.8;min-width:580px}th{background:#f2f5fa;text-align:left;font-weight:600;vertical-align:top;padding:12px 14px;color:#39465a}td{padding:12px 14px;border-top:1px solid #e5e9f0;vertical-align:top}tbody tr:nth-child(even){background:#fafbfd}table p{font-size:12px}code{font:11px/1.7 ui-monospace,monospace;background:#edf3ff;padding:2px 5px;border-radius:3px;overflow-wrap:anywhere}p a,li a{overflow-wrap:anywhere}strong{font-weight:600}.document-note{border-left:3px solid #245cdb;padding:12px 18px;background:#edf3ff;margin:25px 0;font-size:12px;line-height:1.85}.bottom{font-size:12px;color:#6d788a;margin-top:50px;border-top:1px solid #e5e9f0;padding-top:20px}@media(max-width:1000px){.layout{grid-template-columns:205px minmax(0,1fr)}main{padding:30px}nav{padding:24px 12px}}@media(max-width:720px){.layout{display:block}nav{position:static;height:auto;max-height:210px;border-bottom:1px solid #d7dfe9}.top{padding:0 18px}.brand span{display:none}main{padding:25px 20px}h1{font-size:28px}h2{font-size:22px}p,li{font-size:14px}.table-scroll{margin-inline:0}}@media print{.top,nav{display:none}.layout{display:block}main{padding:0;border:0}body{background:white}h2,h3{break-after:avoid}tr{break-inside:avoid}.table-scroll{overflow:visible;border-radius:0}table{min-width:0;font-size:9px}p,li{font-size:10.5px}h1{font-size:26px}h2{font-size:19px}h3{font-size:14px}a{color:inherit;text-decoration:none}@page{size:A4;margin:16mm}}
</style></head><body><header class="top"><a class="brand" href="/#service">EvalPilot<span>PRODUCT REQUIREMENTS / V2.0</span></a><a href="/#service">返回智能服务平台 →</a></header><div class="layout"><nav aria-label="PRD章节目录"><span>产品定义与实施规格</span>${sections.map(section => `<a href="#${section.anchor}">${escape(section.title)}</a>`).join('')}</nav><main><div class="document-note">本地作品版 · 实现与规划分开标注 · 真实业务指标不造数<br>可使用浏览器打印保存。没有第三方脚本、外部字体或行为追踪。</div>${blocks.join('\n')}<footer class="bottom">EvalPilot · 独立产品作品 · 2026-11-06<br>本文件不含真实客服对话或任何 API 凭证。</footer></main></div></body></html>`;
fs.mkdirSync(path.join(root, 'public'), { recursive: true });
fs.writeFileSync(path.join(root, 'public/product-prd.html'), html);
console.log(`PRD built: ${sections.length} sections, ${source.length} source characters`);

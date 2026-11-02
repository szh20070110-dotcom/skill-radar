#!/usr/bin/env node
/**
 * skill-finder.mjs - 华为云 Skills 本地检索器（零依赖）
 *
 * 数据入口: https://skills.huaweicloud.com
 * 门户是 SPA，脚本先从首页 bundle 动态发现搜索/列表接口，
 * 再按关键词检索；接口不可用时回退到公开列表接口与列表页 HTML。
 *
 * 用法:
 *   node skill-finder.mjs ecs
 *   node skill-finder.mjs obs mysql --limit 5
 *   node skill-finder.mjs cce-cost --gap --priority P1
 *   node skill-finder.mjs cce-cost --gap --json --out gaps/my-gap.md
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORTAL = 'https://skills.huaweicloud.com';
const CACHE_FILE = path.join(SCRIPT_DIR, '.skill-finder-cache.json');

const DEFAULT_API_BASE = 'https://devdata2.huaweicloud.com';
const API_PREFIX = '/rest/developer/fwdo/rest/developer/servlet/hdskillservice/v1';
const DEFAULT_SEARCH_PATH = `${API_PREFIX}/skill/search`;
const DEFAULT_LIST_PATH = `${API_PREFIX}/skills`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 25000;
const MAX_INDEX_PAGES = 20;
const INDEX_PAGE_SIZE = 20;
const runtimeIndexCache = new Map();

const HELP = `
skill-finder.mjs - 华为云 Skills 本地检索器（零依赖）

用法:
  node skill-finder.mjs <关键词...> [选项]

示例:
  node skill-finder.mjs ecs
  node skill-finder.mjs ecs obs --limit 5
  node skill-finder.mjs cce-cost --gap --priority P1

选项:
  --limit <n>        每个关键词最多展示 n 条（默认 10）
  --gap              无结果时生成 Markdown 问题单（gaps/ 目录）
  --type <type>      问题类型：能力缺口（默认）| 体验问题
  --expect <text>    问题单中的“期望能力”
  --workaround <txt> 问题单中的“当前替代方案”
  --priority <p>     优先级：P0 | P1 | P2（默认 P2）
  --reporter <name>  提交人（默认取 git config user.name）
  --out <file>       问题单输出路径（仅单关键词时生效）
  --json             以 JSON 输出检索结果
  --refresh          忽略 24h 缓存，重新发现接口
  --no-cache         不读写缓存
  --help             显示本帮助

退出码: 0 正常 / 1 索引获取失败 / 2 无结果且未指定 --gap
`.trim();

function parseArgs(argv) {
  const opts = {
    keywords: [],
    limit: 10,
    gap: false,
    type: '能力缺口',
    expect: '',
    workaround: '',
    priority: 'P2',
    reporter: '',
    out: '',
    json: false,
    refresh: false,
    noCache: false,
    help: false,
  };

  const takeValue = (arg, i) => {
    const eq = arg.indexOf('=');
    if (eq !== -1) return [arg.slice(eq + 1), i];
    return [argv[i + 1], i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      opts.keywords.push(arg);
      continue;
    }
    const name = arg.split('=')[0];
    switch (name) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--limit': {
        const [v, ni] = takeValue(arg, i);
        i = ni;
        opts.limit = Math.max(1, Number(v) || 10);
        break;
      }
      case '--gap':
        opts.gap = true;
        break;
      case '--type': {
        const [v, ni] = takeValue(arg, i);
        i = ni;
        opts.type = v === 'experience' || v === '体验问题' ? '体验问题' : '能力缺口';
        break;
      }
      case '--expect': {
        const [v, ni] = takeValue(arg, i);
        i = ni;
        opts.expect = v || '';
        break;
      }
      case '--workaround': {
        const [v, ni] = takeValue(arg, i);
        i = ni;
        opts.workaround = v || '';
        break;
      }
      case '--priority': {
        const [v, ni] = takeValue(arg, i);
        i = ni;
        opts.priority = ['P0', 'P1', 'P2'].includes(String(v).toUpperCase())
          ? String(v).toUpperCase()
          : 'P2';
        break;
      }
      case '--reporter': {
        const [v, ni] = takeValue(arg, i);
        i = ni;
        opts.reporter = v || '';
        break;
      }
      case '--out': {
        const [v, ni] = takeValue(arg, i);
        i = ni;
        opts.out = v || '';
        break;
      }
      case '--json':
        opts.json = true;
        break;
      case '--refresh':
        opts.refresh = true;
        break;
      case '--no-cache':
        opts.noCache = true;
        break;
      default:
        throw new Error(`未知参数: ${arg}（用 --help 查看用法）`);
    }
  }
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestText(url, { method = 'GET', body, timeout = REQUEST_TIMEOUT_MS } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const headers = { referer: `${PORTAL}/`, 'user-agent': 'skill-finder/1.0 (+local)' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} @ ${url}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (attempt < 2) await sleep(400 * (attempt + 1));
    }
  }
  throw lastError;
}

async function requestJson(url, options) {
  const text = await requestText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回内容不是 JSON @ ${url}`);
  }
}

function pickBundleUrl(html) {
  const patterns = [
    /<script[^>]+type=["']module["'][^>]+src=["']([^"']*index-[^"']+\.js)["']/i,
    /<script[^>]+src=["']([^"']*\/assets\/index-[^"']+\.js)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1].startsWith('http') ? m[1] : new URL(m[1], PORTAL).href;
  }
  return '';
}

function pickApiBase(js) {
  const m = js.match(/["'](https:\/\/[a-z0-9.-]*devdata[0-9]*\.huaweicloud\.com)["']/i);
  return m ? m[1].replace(/\/$/, '') : '';
}

function pickApiPath(js, suffix) {
  const re = new RegExp(`["'](\\/rest\\/[\\w/.-]*\\/v1\\/${suffix})["']`);
  const m = js.match(re);
  return m ? m[1] : '';
}

async function readCache(noCache) {
  if (noCache) return null;
  try {
    const raw = await readFile(CACHE_FILE, 'utf8');
    const cached = JSON.parse(raw);
    if (cached && cached.at && Date.now() - cached.at < CACHE_TTL_MS) return cached;
  } catch {
    /* 缓存不存在或损坏时忽略 */
  }
  return null;
}

async function writeCache(value, noCache) {
  if (noCache) return;
  try {
    await writeFile(CACHE_FILE, JSON.stringify(value, null, 2), 'utf8');
  } catch {
    /* 缓存写入失败不影响检索 */
  }
}

async function discoverEndpoints(opts) {
  const cached = await readCache(opts.noCache);
  if (cached && !opts.refresh) return { ...cached, cached: true };

  const discovered = {
    at: Date.now(),
    portal: PORTAL,
    apiBase: DEFAULT_API_BASE,
    searchPath: DEFAULT_SEARCH_PATH,
    listPath: DEFAULT_LIST_PATH,
    bundleUrl: '',
    discovered: false,
  };

  try {
    const html = await requestText(`${PORTAL}/`);
    const bundleUrl = pickBundleUrl(html);
    if (bundleUrl) {
      discovered.bundleUrl = bundleUrl;
      const js = await requestText(bundleUrl, { timeout: 40000 });
      discovered.apiBase = pickApiBase(js) || discovered.apiBase;
      discovered.searchPath = pickApiPath(js, 'skill/search') || discovered.searchPath;
      discovered.listPath = pickApiPath(js, 'skills') || discovered.listPath;
      discovered.discovered = true;
    }
  } catch (err) {
    process.stderr.write(`[warn] 门户 bundle 解析失败，使用内置端点: ${err.message}\n`);
  }

  await writeCache(discovered, opts.noCache);
  return { ...discovered, cached: false };
}

function normalizeSkill(raw) {
  const id = String(raw.skill_id || '');
  const name = String(raw.skill_name || id.split('/').pop() || '').trim();
  return {
    id,
    name,
    url: `${PORTAL}/detail/${encodeURIComponent(name)}`,
    description: String(raw.description || '').replace(/\s+/g, ' ').trim(),
    tags: String(raw.tags || '').trim(),
  };
}

function oneLine(description, maxLength = 110) {
  if (!description) return '（无简介）';
  let text = description.replace(/\s+/g, ' ').trim();
  const triggerAt = text.search(/\bTriggers?\s*[:：]/i);
  if (triggerAt > 0) text = text.slice(0, triggerAt).trim();
  text = text.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  const sentence = text.match(/^.*?[。！？!?](?:\s|$)/);
  if (sentence && sentence[0].length >= 12) text = sentence[0].trim();
  if (text.length > maxLength) text = `${text.slice(0, maxLength).trimEnd()}…`;
  return text.replace(/^["'“”]+|["'“”]+$/g, '').trim() || '（无简介）';
}

async function fetchIndexTotal(endpoints) {
  try {
    const data = await requestJson(`${endpoints.apiBase}${endpoints.listPath}`, {
      method: 'POST',
      body: { page: 1, size: 1 },
    });
    const total = Number(data?.total_elements);
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

async function searchByApi(endpoints, keyword, limit) {
  const data = await requestJson(`${endpoints.apiBase}${endpoints.searchPath}`, {
    method: 'POST',
    body: { keyword, limit },
  });
  const list = Array.isArray(data) ? data : data?.data || data?.result || data?.content || [];
  if (!Array.isArray(list)) throw new Error('搜索接口返回结构无法识别');
  return list.map(normalizeSkill).filter((item) => item.name);
}

async function listAllSkills(endpoints) {
  const all = [];
  let totalPages = Infinity;
  for (let page = 1; page <= Math.min(totalPages, MAX_INDEX_PAGES); page++) {
    const data = await requestJson(`${endpoints.apiBase}${endpoints.listPath}`, {
      method: 'POST',
      body: { page, size: INDEX_PAGE_SIZE },
    });
    const content = Array.isArray(data?.content) ? data.content : [];
    all.push(...content.map(normalizeSkill));
    totalPages = Number(data?.total_pages) || totalPages;
    if (content.length < INDEX_PAGE_SIZE) break;
  }
  return all;
}

function matchLocal(skills, keyword) {
  const needle = keyword.toLowerCase();
  return skills
    .map((item) => {
      const name = item.name.toLowerCase();
      const tags = item.tags.toLowerCase();
      const desc = item.description.toLowerCase();
      let score = 0;
      if (name.includes(needle)) score += 100;
      if (tags.includes(needle)) score += 40;
      if (desc.includes(needle)) score += 10;
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

async function searchByList(endpoints, keyword, limit) {
  let all = runtimeIndexCache.get('all');
  if (!all) {
    all = await listAllSkills(endpoints);
    runtimeIndexCache.set('all', all);
  }
  if (!all.length) return [];
  return matchLocal(all, keyword).slice(0, limit);
}

async function searchByHtml(keyword, limit) {
  const html = await requestText(`${PORTAL}/skills`);
  const names = new Set();
  for (const m of html.matchAll(/\/detail\/([^"'#?\s<>]+)/g)) {
    try {
      names.add(decodeURIComponent(m[1]));
    } catch {
      names.add(m[1]);
    }
  }
  return [...names]
    .filter((name) => name.toLowerCase().includes(keyword.toLowerCase()))
    .slice(0, limit)
    .map((name) => ({
      id: '',
      name,
      url: `${PORTAL}/detail/${encodeURIComponent(name)}`,
      description: '',
      tags: '',
    }));
}

async function searchKeyword(endpoints, keyword, opts) {
  const tried = [];
  try {
    const results = await searchByApi(endpoints, keyword, opts.limit);
    if (results.length) return { keyword, results: results.slice(0, opts.limit), source: 'search-api', tried };
    tried.push('搜索接口: 0 命中，转本地索引');
  } catch (err) {
    tried.push(`搜索接口: ${err.message}`);
  }
  try {
    const results = await searchByList(endpoints, keyword, opts.limit);
    if (results.length) return { keyword, results, source: 'list-api', tried };
    tried.push('列表接口: 0 命中');
  } catch (err) {
    tried.push(`列表接口: ${err.message}`);
  }
  try {
    const results = await searchByHtml(keyword, opts.limit);
    return { keyword, results, source: 'list-page', tried };
  } catch (err) {
    tried.push(`列表页: ${err.message}`);
  }
  return { keyword, results: [], source: 'none', tried };
}

function formatTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function slugify(text) {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'gap';
}

function resolveReporter(value) {
  if (value) return value;
  try {
    const name = execFileSync('git', ['config', 'user.name'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (name) return name;
  } catch {
    /* 没有 git 配置时退化为系统用户名 */
  }
  return os.userInfo().username || '未署名';
}

function defaultExpect(keyword) {
  return `在华为云技能库中提供覆盖「${keyword}」的官方技能，支持通过自然语言检索、安装并完成对应的云资源操作，且与现有技能保持一致的调用方式。`;
}

function buildGapReport(context) {
  const {
    keyword,
    opts,
    reportTime,
    indexTotal,
    related,
    endpointInfo,
    reporter,
  } = context;
  const title = `[${opts.type}] 未找到与「${keyword}」相关的华为云技能`;
  const relatedLines = related.length
    ? related
        .slice(0, 10)
        .map((item) => `- ${item.name}（${oneLine(item.description, 70)}）`)
    : ['- 无'];
  const relatedNote = related.length
    ? `检索到 ${related.length} 个相关技能，但均未声明覆盖「${keyword}」所述能力。`
    : '技能索引中未检索到相关技能。';

  const priorityLabel = { P0: 'P0（最高）', P1: 'P1（高）', P2: 'P2（中）' }[opts.priority];

  return `---
title: "${title}"
type: ${opts.type === '体验问题' ? 'experience-issue' : 'capability-gap'}
keyword: "${keyword}"
priority: ${opts.priority}
reporter: "${reporter}"
created_at: "${reportTime}"
index_source: "${endpointInfo.apiBase}${endpointInfo.searchPath}"
index_total: ${indexTotal ?? 'unknown'}
---

# 华为云技能问题单

> 由 skill-finder.mjs --gap 自动生成于 ${reportTime}，内容基于当次检索结果。

## 标题

${title}

## 问题类型

${opts.type}

## 涉及技能

${relatedNote}

${relatedLines.join('\n')}

## 期望能力

${opts.expect || defaultExpect(keyword)}

## 当前替代方案

${opts.workaround || '暂无对应技能，需在华为云控制台或通过 OpenAPI 手工完成相关操作。'}

## 复现步骤

1. 打开 https://skills.huaweicloud.com 。
2. 在搜索框输入关键词 \`${keyword}\`（或调用门户搜索接口）。
3. 观察结果：返回 0 条匹配技能。
4. 本地等价复现：\`node skill-finder.mjs ${keyword}\`。
5. 记录时间：${reportTime}（本地时区）。

## 优先级

${priorityLabel}

## 提交人

${reporter}

## 补充信息

- 检索时间：${reportTime}
- 索引技能总数：${indexTotal ?? '未知'}
- 索引来源：${endpointInfo.apiBase}${endpointInfo.searchPath}
- 门户入口：${PORTAL}
- 检索方式：${endpointInfo.cached ? '缓存端点' : '实时发现端点'}${
    endpointInfo.bundleUrl ? `（bundle: ${endpointInfo.bundleUrl}）` : ''
  }
`;
}

function printResults(result, opts) {
  const { keyword, results, source } = result;
  const sourceLabel = {
    'search-api': '门户搜索接口',
    'list-api': '门户列表接口（本地过滤）',
    'list-page': '公开列表页',
    none: '无可用来源',
  }[source];

  console.log(`\n关键词: ${keyword}  来源: ${sourceLabel}  命中: ${results.length}`);
  if (!results.length) {
    console.log('  未找到匹配的技能。');
    if (result.tried.length) {
      for (const line of result.tried) console.log(`  [fallback] ${line}`);
    }
    return;
  }
  results.forEach((item, index) => {
    console.log(`  ${index + 1}. ${item.name}`);
    console.log(`     ${item.url}`);
    console.log(`     ${oneLine(item.description)}`);
  });
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }

  if (opts.help || !opts.keywords.length) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 1);
  }

  const endpoints = await discoverEndpoints(opts);
  const indexTotal = await fetchIndexTotal(endpoints);
  const reportTime = formatTime(new Date());
  const reporter = resolveReporter(opts.reporter);

  const output = {
    portal: PORTAL,
    indexSource: `${endpoints.apiBase}${endpoints.searchPath}`,
    indexTotal,
    searchedAt: reportTime,
    keywords: [],
  };

  let hadNetworkFailure = false;
  let hadResults = false;
  let generatedGap = false;

  for (const keyword of opts.keywords) {
    const result = await searchKeyword(endpoints, keyword, opts);
    hadResults = hadResults || result.results.length > 0;
    if (result.source === 'none') hadNetworkFailure = true;

    const entry = {
      keyword,
      source: result.source,
      count: result.results.length,
      results: result.results.map((item) => ({
        name: item.name,
        url: item.url,
        summary: oneLine(item.description),
        id: item.id,
        tags: item.tags,
      })),
    };

    if (result.results.length === 0 && opts.gap && result.source !== 'none') {
      let related = [];
      const family = keyword.split(/[\s_-]+/).filter(Boolean)[0];
      if (family && family !== keyword.toLowerCase()) {
        const relatedResult = await searchKeyword(endpoints, family, {
          ...opts,
          limit: 10,
          gap: false,
        });
        related = relatedResult.results;
      }

      const markdown = buildGapReport({
        keyword,
        opts,
        reportTime,
        indexTotal,
        related,
        endpointInfo: endpoints,
        reporter,
      });
      const file =
        opts.out && opts.keywords.length === 1
          ? path.resolve(opts.out)
          : path.join(SCRIPT_DIR, 'gaps', `gap-${formatStamp(new Date())}-${slugify(keyword)}.md`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, markdown, 'utf8');
      entry.gapFile = path.relative(process.cwd(), file) || file;
      generatedGap = true;
      if (!opts.json) {
        console.log(`\n[gap] 已生成问题单: ${entry.gapFile}`);
      }
    }

    output.keywords.push(entry);
    if (!opts.json) printResults(result, opts);
  }

  if (opts.json) {
    console.log(JSON.stringify(output, null, 2));
  }

  if (hadNetworkFailure && !hadResults) {
    process.stderr.write('\n无法从 skills.huaweicloud.com 获取技能索引，请检查网络后重试。\n');
    process.exit(1);
  }
  if (!hadResults && !generatedGap) {
    process.stderr.write('\n未找到匹配技能；加 --gap 可自动生成问题单。\n');
    process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`运行失败: ${err.message}\n`);
  process.exit(1);
});
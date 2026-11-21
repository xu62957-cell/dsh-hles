/**
 * 页面解析：HTML 正文/标题/链接，RSS/Atom 条目，HN 讨论 JSON。
 * 纯正则实现，不引入 DOM 解析库（手机端内存友好、无依赖）。
 *
 * 提取原则：宁可少一点，也不要把导航/版权/推荐位当成正文 —— 语言样本一旦混进
 * 广告文案，学到的"表达规律"就是垃圾。
 */

import { oneLine, normalizeSpace, canonicalUrl, isPublicHttpUrl, isJunkLink, truncate } from './util.js';

const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
    hellip: '…', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
    middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±',
    times: '×', divide: '÷', frac12: '½', euro: '€', pound: '£', yen: '¥', sect: '§',
    para: '¶', dagger: '†', prime: '′', prime2: '″', le: '≤', ge: '≥', ne: '≠', infin: '∞',
};

export function decodeEntities(text) {
    return String(text ?? '')
        .replace(/&#x([0-9a-f]+);?/giu, (_, hex) => safeChar(parseInt(hex, 16)))
        .replace(/&#(\d+);?/gu, (_, dec) => safeChar(parseInt(dec, 10)))
        .replace(/&([a-z][a-z0-9]*);/giu, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeChar(code) {
    try {
        return String.fromCodePoint(code);
    } catch {
        return '';
    }
}

function stripCdata(text) {
    return String(text ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1');
}

export function stripTags(html) {
    return decodeEntities(String(html ?? '').replace(/<[^>]+>/gu, ' '));
}

/** 判断是不是订阅源（RSS 2.0 / Atom / RDF）。 */
export function looksLikeFeed(text, contentType = '') {
    const head = String(text ?? '').slice(0, 3000);
    if (/^\s*</u.test(head) && /<(rss|feed|rdf:RDF)\b/iu.test(head)) return true;
    return /(rss|atom|xml)/iu.test(contentType) && /<(item|entry)\b/iu.test(head);
}

export function parseFeed(xml, baseUrl = '') {
    const text = stripCdata(xml);
    const feedTitle = firstTag(text, /<channel\b[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/iu)
        || firstTag(text, /<feed\b[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/iu)
        || '';
    const blocks = [...text.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/giu)].map((m) => m[0]);
    const items = [];
    for (const block of blocks.slice(0, 40)) {
        const title = oneLine(stripTags(firstTag(block, /<title[^>]*>([\s\S]*?)<\/title>/iu))).slice(0, 200);
        const linkRaw = firstTag(block, /<link[^>]*href=["']([^"']+)["'][^>]*\/?>/iu)
            || firstTag(block, /<link[^>]*>([\s\S]*?)<\/link>/iu)
            || firstTag(block, /<guid[^>]*>([\s\S]*?)<\/guid>/iu);
        const link = resolveUrl(linkRaw, baseUrl);
        if (!link || !isPublicHttpUrl(link)) continue;
        const date = firstTag(block, /<(pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/\1>/iu);
        const desc = firstTag(block, /<(description|summary|content:encoded)[^>]*>([\s\S]*?)<\/\1>/iu);
        items.push({
            title: title || link,
            link: canonicalUrl(link),
            date: date ? new Date(date).toString() === 'Invalid Date' ? '' : new Date(date).toISOString() : '',
            summary: truncate(oneLine(stripTags(desc)), 300),
        });
    }
    return { feedTitle: oneLine(stripTags(feedTitle)), items };
}

function firstTag(text, re) {
    const m = re.exec(text);
    if (!m) return '';
    return m[m.length - 1] ?? m[1] ?? '';
}

const BLOCK_TAGS = /<\/?(?:p|div|section|article|main|header|footer|aside|nav|li|ul|ol|dl|dt|dd|h[1-6]|blockquote|pre|figure|figcaption|table|thead|tbody|tr|td|th|hr|br)\b[^>]*>/giu;

/** 去掉脚本样式与不可见元素。 */
function sanitizeMarkup(html) {
    return String(html ?? '')
        .replace(/<!--[\s\S]*?-->/gu, ' ')
        .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/giu, ' ')
        .replace(/<(script|style|noscript|svg|iframe|object|embed|template|form|select|button|input|textarea|canvas|video|audio)\b[\s\S]*?<\/\1>/giu, ' ')
        .replace(/<(script|style|link|meta)\b[^>]*\/?>/giu, ' ');
}

/** 优先取 <article>/<main>，取不到再用 body。 */
function mainRegion(html) {
    const articles = [...html.matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/giu)].map((m) => m[2]);
    if (articles.length) {
        articles.sort((a, b) => visibleLength(b) - visibleLength(a));
        if (visibleLength(articles[0]) > 200) return articles[0];
    }
    const body = /<body\b[^>]*>([\s\S]*)<\/body>/iu.exec(html)?.[1];
    return body || html;
}

function visibleLength(fragment) {
    return stripTags(sanitizeMarkup(fragment)).replace(/\s+/gu, '').length;
}

export function extractLinks(html, baseUrl, { max = 200 } = {}) {
    const out = [];
    const seen = new Set();
    const re = /<a\b[^>]*href\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/giu;
    let m;
    while ((m = re.exec(html)) && out.length < max * 3) {
        const href = m[1];
        if (!href || /^(?:javascript|mailto|tel|data|blob):/iu.test(href)) continue;
        const url = resolveUrl(href, baseUrl);
        if (!url || !isPublicHttpUrl(url) || isJunkLink(url)) continue;
        const clean = canonicalUrl(url);
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        const anchor = oneLine(stripTags(m[2])).slice(0, 100);
        out.push({ url: clean, anchor });
        if (out.length >= max) break;
    }
    return out;
}

export function parseHtml(html, url) {
    const raw = String(html ?? '');
    const title = oneLine(decodeEntities(
        /<h1[^>]*>([\s\S]*?)<\/h1>/iu.exec(mainRegion(sanitizeMarkup(raw)))?.[1]
        || /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(raw)?.[1]
        || /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/iu.exec(raw)?.[1]
        || '',
    )).replace(/<[^>]+>/gu, '').slice(0, 240);
    const description = oneLine(decodeEntities(
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/iu.exec(raw)?.[1]
        || /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/iu.exec(raw)?.[1]
        || '',
    )).slice(0, 400);
    const lang = (/<html[^>]+lang=["']?([a-zA-Z-]+)/iu.exec(raw)?.[1] || '').toLowerCase().startsWith('en') ? 'en' : 'zh';
    const region = mainRegion(sanitizeMarkup(raw));
    const withBreaks = region
        .replace(BLOCK_TAGS, '\n')
        .replace(/<li\b[^>]*>/giu, '\n· ')
        .replace(/<[^>]+>/gu, ' ');
    const text = decodeEntities(withBreaks)
        .replace(/\u00a0/gu, ' ')
        .replace(/[ \t\f\v]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
    const paragraphs = text.split(/\n+/u).map((x) => x.trim()).filter((x) => x.length >= 2);
    const headings = [...raw.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/giu)]
        .map((m) => oneLine(stripTags(m[2])))
        .filter((x) => x.length >= 2)
        .slice(0, 30);
    const links = extractLinks(raw, url);
    return {
        title,
        description,
        lang,
        text,
        paragraphs,
        headings,
        links,
        hasArticle: /<article\b/iu.test(raw),
        htmlLength: raw.length,
    };
}

/** 从 HN Algolia JSON 里取讨论文本（评论区语料）。 */
export function parseHnDiscussion(json) {
    const out = [];
    const walk = (node, depth = 0) => {
        if (!node || depth > 6) return;
        if (typeof node.text === 'string' && node.text.trim()) {
            out.push({ text: normalizeSpace(stripTags(node.text)), depth });
        }
        for (const child of node.children || []) walk(child, depth + 1);
    };
    if (Array.isArray(json?.hits)) {
        for (const hit of json.hits) {
            out.push({ text: oneLine(stripTags(hit.title || '')), depth: -1, title: true });
            walk(hit);
        }
    } else {
        walk(json);
    }
    return out.slice(0, 120);
}

export function resolveUrl(href, base) {
    try {
        const u = new URL(href, base || undefined);
        return u.toString();
    } catch {
        return '';
    }
}

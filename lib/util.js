/**
 * 通用小工具：随机、文本切分、统计、URL 判断。
 * 不依赖任何第三方包 —— 插件要能在 DSH 的 node 里直接跑。
 */

import { createHash } from 'node:crypto';

export const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

/** 陈述句相似度用的停用词（中文虚词+常见转述词），只影响相似度计算。 */
const SIM_STOP = /(通常|主要|一般|往往|常常|经常|研究|表明|显示|一项|认为|指出|可以|能够|可能|会|在|的|是|了|和|与|也|都|就|而|及|对|从|到|被|把|这|那|个|有|为|以|其|之|于|并|但|却|更|最|很|非常)/gu;

/** 中文近似陈述相似度：去掉虚词后按字二元组做 Dice 系数（0..1）。 */
export function statementSimilarity(a, b) {
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\u3400-\u9fff\w]/gu, '').replace(SIM_STOP, '');
    const A = norm(a);
    const B = norm(b);
    if (A.length < 4 || B.length < 4) return 0;
    const grams = (s) => {
        const out = new Map();
        const step = /[\u3400-\u9fff]/u.test(s) ? 1 : 1;
        for (let i = 0; i + 2 <= s.length; i += step) {
            const g = s.slice(i, i + 2);
            out.set(g, (out.get(g) || 0) + 1);
        }
        return out;
    };
    const ga = grams(A);
    const gb = grams(B);
    let inter = 0;
    let sizeA = 0;
    let sizeB = 0;
    for (const n of ga.values()) sizeA += n;
    for (const n of gb.values()) sizeB += n;
    for (const [g, na] of ga) {
        const nb = gb.get(g);
        if (nb) inter += Math.min(na, nb);
    }
    return sizeA + sizeB === 0 ? 0 : (2 * inter) / (sizeA + sizeB);
}
export const CJK_ALL = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;

export function sha1(input, len = 16) {
    return createHash('sha1').update(String(input)).digest('hex').slice(0, len);
}

export function pick(arr, rand = Math.random) {
    if (!arr || arr.length === 0) return undefined;
    return arr[Math.floor(rand() * arr.length) % arr.length];
}

/** 按权重取一项：items 为 [{weight}]，权重非正数的会被跳过。 */
export function weightedPick(items, rand = Math.random, weightOf = (x) => x.weight ?? 1) {
    const pool = [];
    let total = 0;
    for (const item of items) {
        const w = Number(weightOf(item));
        if (!Number.isFinite(w) || w <= 0) continue;
        total += w;
        pool.push({ item, at: total });
    }
    if (total <= 0) return undefined;
    const r = rand() * total;
    for (const entry of pool) if (r <= entry.at) return entry.item;
    return pool[pool.length - 1].item;
}

export function shuffle(arr, rand = Math.random) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

export const sleep = (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', done);
        resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
});

export function jitter(max) {
    return Math.floor(Math.random() * max);
}

export function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

export function round(n, digits = 2) {
    const f = 10 ** digits;
    return Math.round(n * f) / f;
}

export function truncate(text, max) {
    const s = String(text ?? '');
    if (s.length <= max) return s;
    return `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function normalizeSpace(text) {
    return String(text ?? '').replace(/\u00a0/gu, ' ').replace(/[ \t\f\v]+/gu, ' ').replace(/\s*\n\s*/gu, '\n').trim();
}

/** 单行化，用于标题/链接文字。 */
export function oneLine(text) {
    return normalizeSpace(text).replace(/\n+/gu, ' ').trim();
}

export function cjkLen(text) {
    return (String(text ?? '').match(CJK_ALL) || []).length;
}

export function isCjkHeavy(text) {
    const s = String(text ?? '');
    const cjk = (s.match(CJK_ALL) || []).length;
    return cjk >= 12 && cjk / Math.max(1, s.replace(/\s/gu, '').length) > 0.25;
}

export function langOf(text) {
    return isCjkHeavy(text) ? 'zh' : 'en';
}

/** 句子切分：中文全角标点 + 英文句点（后面跟空白或结尾），保留引号内内容。 */
export function splitSentences(text) {
    const s = String(text ?? '').replace(/\r\n?/gu, '\n');
    const out = [];
    let buf = '';
    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        if (ch === '\n') {
            if (buf.trim()) out.push(buf.trim());
            buf = '';
            continue;
        }
        buf += ch;
        if ('。！？!?…'.includes(ch)) {
            // 省略号只当分句，不结束整句
            if (ch === '…' && s[i + 1] === '…') {
                buf += s[i + 1];
                i += 1;
                if (s[i + 1] === '…') {
                    buf += s[i + 1];
                    i += 1;
                }
            }
            if (buf.trim()) out.push(buf.trim());
            buf = '';
        } else if (ch === '.' && /\s|$/u.test(s[i + 1] ?? '') && !/\d$/u.test(s[i - 1] ?? '')) {
            if (buf.trim()) out.push(buf.trim());
            buf = '';
        }
    }
    if (buf.trim()) out.push(buf.trim());
    return out.filter((x) => x.length > 0);
}

export function splitParagraphs(text) {
    return String(text ?? '')
        .replace(/\r\n?/gu, '\n')
        .split(/\n{1,}/u)
        .map((x) => x.trim())
        .filter((x) => x.length > 0);
}

/** 中文按字二元组、英文按词切，用于去重与相似度。 */
export function tokens(text) {
    const s = String(text ?? '').toLowerCase();
    const out = [];
    for (const word of s.match(/[a-z][a-z'-]{1,24}/gu) || []) out.push(word);
    const cjkRuns = s.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/gu) || [];
    for (const run of cjkRuns) {
        if (run.length === 1) out.push(run);
        for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2));
    }
    return out;
}

export function jaccard(a, b) {
    const A = new Set(tokens(a));
    const B = new Set(tokens(b));
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter += 1;
    return inter / (A.size + B.size - inter);
}

export function mean(nums) {
    if (!nums.length) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function stddev(nums) {
    if (nums.length < 2) return 0;
    const m = mean(nums);
    return Math.sqrt(nums.reduce((a, b) => a + (b - m) ** 2, 0) / (nums.length - 1));
}

/** 归一化香农熵（0..1），衡量用词/句式分散程度。 */
export function shannon(values) {
    const total = values.reduce((a, b) => a + b, 0);
    if (total <= 0) return 0;
    let h = 0;
    const kinds = new Set(values.filter((x) => x > 0)).size;
    for (const v of values) {
        if (v <= 0) continue;
        const p = v / total;
        h -= p * Math.log2(p);
    }
    return kinds > 1 ? h / Math.log2(kinds) : 0;
}

export function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./u, '');
    } catch {
        return '';
    }
}

export function originOf(url) {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}`;
    } catch {
        return '';
    }
}

export function stripFragment(url) {
    try {
        const u = new URL(url);
        u.hash = '';
        return u.toString();
    } catch {
        return '';
    }
}

/** 只允许 http(s)、不含账号密码、不指向本机/内网。 */
export function isPublicHttpUrl(url) {
    let u;
    try {
        u = new URL(url);
    } catch {
        return false;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (!host.includes('.') && host !== 'localhost') return false;
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/u.test(host)) {
        const [a, b] = host.split('.').map(Number);
        if (a === 10 || a === 127 || a === 0 || a === 169) return false;
        if (a === 192 && b === 168) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;
    }
    if (host.startsWith('[') || host.includes(':')) return false;
    return true;
}

/** 去掉追踪参数，减少同一页面的重复条目。 */
const TRACKING_PARAMS = /^(?:utm_|share_|fbclid$|gclid$|spm$|from$|ref$|ref_src$|sa$)/u;
export function canonicalUrl(url) {
    try {
        const u = new URL(url);
        u.hash = '';
        const keep = [];
        for (const [k, v] of u.searchParams.entries()) {
            if (TRACKING_PARAMS.test(k)) continue;
            keep.push([k, v]);
        }
        u.search = '';
        for (const [k, v] of keep) u.searchParams.append(k, v);
        let path = u.pathname.replace(/\/{2,}/gu, '/');
        if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
        u.pathname = path;
        return u.toString();
    } catch {
        return '';
    }
}

const JUNK_LINK = /(^|\/\/)(beian\.miit\.gov\.cn|partner\.)|(?:^|[\/._-])(sponsor|advert|promo|affiliate)[-\w]*|\/link\?target=|\/redirect\?|\/out\?url=|\/go\?url=/iu;

/** 账号/登录/结算/设置这类页面：不是内容，不学。 */
const ACCOUNT_PATH = /(?:^|\/)(?:log-?in|sign-?in|sign-?out|logout|register|sign-?up|account|dashboard|insider|subscribe|subscription|checkout|cart|settings|profile|password|oauth|sso|my-?account|privacy|policy|policies|terms|legal|donate|donation|support|help|faq|contact|about|search|tag|tags|category|categories|archive|archives)[-\w]*(?:[\/?#]|$)/iu;

/** 明显不是正文内容的链接：备案、赞助位、跳转壳、合作频道、账号页。 */
export function isJunkLink(url) {
    const s = String(url ?? '');
    if (JUNK_LINK.test(s)) return true;
    try {
        const u = new URL(s);
        if (ACCOUNT_PATH.test(u.pathname)) return true;
    } catch {
        return false;
    }
    return false;
}

export function nowIso() {
    return new Date().toISOString();
}

export function dayKey(ts = Date.now()) {
    return new Date(ts).toISOString().slice(0, 10);
}


/** 模型偶尔会把“标题：…”和正文再输出一遍：把重复的第二份切掉。 */
export function dedupeModelText(input) {
    const text = String(input || '').trim();
    const marker = '\n标题：';
    const first = text.indexOf(marker);
    if (first > 200) {
        const head = text.slice(0, first).trim();
        const tail = text.slice(first + marker.length);
        const sample = head.slice(0, 40);
        if (sample && tail.includes(sample)) return head;
    }
    return text;
}

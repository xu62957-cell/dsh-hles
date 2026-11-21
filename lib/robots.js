/**
 * robots.txt：抓取前先问路。
 *
 * 规则解析用 RFC 9309 的基本语义：
 *   - 按 User-agent 分组，`*` 与我们自己的 token 都算命中；
 *   - Allow / Disallow 取"最长匹配"为准，长度相同时 Allow 优先；
 *   - 支持 Crawl-delay（作为该主机的额外间隔下限）。
 * 拿不到 robots.txt（404/网络错误）按允许处理，但会把结果缓存一小段时间，
 * 避免每页都去撞一个已经失败的地址。
 */

import { sleep } from './util.js';

const UA_TOKEN = 'dsh-hles';

export class RobotsPolicy {
    /**
     * @param {{ timeoutMs:number, userAgent:string, rawGet:Function, ttlMs?:number, enabled?:boolean }} deps
     */
    constructor({ timeoutMs, userAgent, rawGet, ttlMs = 12 * 3600 * 1000, enabled = true }) {
        this.timeoutMs = Math.min(timeoutMs, 10_000);
        this.userAgent = userAgent;
        this.rawGet = rawGet;
        this.ttlMs = ttlMs;
        this.enabled = enabled;
        this.cache = new Map();
        this.inflight = new Map();
    }

    /** @returns {Promise<{allowed:boolean, delayMs:number, reason:string}>} */
    async check(url) {
        if (!this.enabled) return { allowed: true, delayMs: 0, reason: 'robots-disabled' };
        let origin;
        try {
            origin = new URL(url).origin;
        } catch {
            return { allowed: false, delayMs: 0, reason: 'bad-url' };
        }
        const cached = this.cache.get(origin);
        if (cached && cached.expires > Date.now()) return evaluate(cached, url);
        if (this.inflight.has(origin)) {
            const rules = await this.inflight.get(origin);
            const entry = this.cache.get(origin) || { rules, delay: 0, reason: 'robots-shared', expires: Date.now() + this.ttlMs };
            return evaluate(entry, url);
        }
        const load = this.#load(origin);
        this.inflight.set(origin, load);
        try {
            const entry = await load;
            this.cache.set(origin, entry);
            return evaluate(entry, url);
        } finally {
            this.inflight.delete(origin);
        }
    }

    async #load(origin) {
        try {
            const res = await this.rawGet(`${origin}/robots.txt`, {
                timeoutMs: Math.min(this.timeoutMs, 8000),
                maxBytes: 200 * 1024,
                noRobots: true,
            });
            if (!res.ok && res.status !== 404) {
                return { rules: [], delay: 0, reason: `robots-unavailable(${res.status || res.error})`, expires: Date.now() + 3600 * 1000 };
            }
            if (res.status === 404) return { rules: [], delay: 0, reason: 'robots-404', expires: Date.now() + this.ttlMs };
            const parsed = parseRobots(res.text, [UA_TOKEN, 'dsh', this.userAgent]);
            return { rules: parsed.rules, delay: parsed.delay, reason: 'robots-parsed', expires: Date.now() + this.ttlMs };
        } catch (error) {
            return { rules: [], delay: 0, reason: `robots-error(${error.message})`, expires: Date.now() + 3600 * 1000 };
        }
    }

    /** 遵守 Crawl-delay：同一主机的额外等待。 */
    async waitDelay(delayMs, signal) {
        if (delayMs > 0) await sleep(delayMs, signal);
    }
}

export function parseRobots(text, uaTokens = [UA_TOKEN]) {
    const lines = String(text ?? '').split(/\r?\n/u);
    const groups = [];
    let current = null;
    let lastWasAgent = false;
    for (const raw of lines) {
        const line = raw.replace(/#.*/u, '').trim();
        if (!line) continue;
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const field = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (field === 'user-agent') {
            if (!lastWasAgent || !current) {
                current = { agents: [], rules: [], delay: 0 };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            lastWasAgent = true;
            continue;
        }
        lastWasAgent = false;
        if (!current) continue;
        if (field === 'disallow' && value) current.rules.push({ allow: false, path: value });
        else if (field === 'allow' && value) current.rules.push({ allow: true, path: value });
        else if (field === 'crawl-delay') {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) current.delay = Math.min(30_000, n * 1000);
        }
    }
    const tokens = uaTokens.map((x) => String(x).toLowerCase());
    const matched = groups.filter((g) => g.agents.some((a) => a === '*' || tokens.some((t) => a.includes(t))));
    const rules = matched.flatMap((g) => g.rules);
    const delay = Math.max(0, ...matched.map((g) => g.delay));
    return { rules, delay };
}

export function evaluate(entry, url) {
    const rules = entry?.rules || [];
    const delayMs = Number(entry?.delay) || 0;
    let path = '/';
    try {
        const u = new URL(url);
        path = u.pathname + (u.search || '');
    } catch {
        return { allowed: false, delayMs: 0, reason: 'bad-url' };
    }
    let best = null;
    for (const rule of rules) {
        const pattern = rule.path;
        if (pattern === '') continue;
        if (!matchPrefix(pattern, path)) continue;
        const score = pattern.length;
        if (!best || score > best.score || (score === best.score && rule.allow && !best.allow)) {
            best = { score, allow: rule.allow };
        }
    }
    return {
        allowed: best ? best.allow : true,
        delayMs,
        reason: best ? (best.allow ? 'robots-allow' : 'robots-disallow') : (entry?.reason || 'robots-default-allow'),
    };
}

function matchPrefix(pattern, path) {
    if (pattern === '/') return true;
    if (pattern.includes('*')) {
        const parts = pattern.split('*').map(escapeRe);
        return new RegExp(`^${parts.join('.*')}`, 'u').test(path);
    }
    return path.startsWith(pattern);
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

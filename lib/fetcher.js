/**
 * 抓取器：限速、限大小、限跳转、robots 预检、编码识别、失败降级。
 *
 * 两条通道：
 *   1. 原生 fetch（可控 UA/大小/跳转，最常用）；
 *   2. DSH 的 ctx.web.fetch（原生失败时的兜底，走宿主已配置的 Web 提供方）。
 * 任何一条都不带 cookie、不带鉴权头，只取公开页面。
 */

import { isPublicHttpUrl, hostOf, sleep } from './util.js';
import { RobotsPolicy } from './robots.js';

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export class Fetcher {
    constructor({ config, web, store, logger }) {
        this.config = config;
        this.web = web;
        this.store = store;
        this.logger = logger;
        this.hostGate = new Map();
        this.aborts = new Set();
        this.robots = new RobotsPolicy({
            timeoutMs: config.explore.timeoutMs,
            userAgent: config.safety.userAgent,
            enabled: config.safety.respectRobots,
            rawGet: (url, opts) => this.rawGet(url, opts),
        });
    }

    /** 真正发请求，不查 robots（robots 自己要用）。 */
    async rawGet(url, { timeoutMs, maxBytes, signal, via = 'direct', redirects = 0, headers = {} } = {}) {
        const timeout = Math.min(timeoutMs ?? this.config.explore.timeoutMs, 60_000);
        const limit = maxBytes ?? this.config.explore.maxBytes;
        const started = Date.now();
        if (!isPublicHttpUrl(url)) {
            return { ok: false, status: 0, error: '拒绝访问非公开地址', ms: 0, bytes: 0, url };
        }
        if (via === 'direct') {
            try {
                const controller = new AbortController();
                const onAbort = () => controller.abort();
                signal?.addEventListener?.('abort', onAbort, { once: true });
                const timer = setTimeout(() => controller.abort(), timeout);
                this.aborts.add(controller);
                let res;
                try {
                    res = await fetch(url, {
                        redirect: 'manual',
                        signal: controller.signal,
                        headers: {
                            'user-agent': this.config.safety.userAgent,
                            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml;q=0.9,text/plain;q=0.6,*/*;q=0.4',
                            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
                            'cache-control': 'no-cache',
                            ...headers,
                        },
                    });
                } finally {
                    clearTimeout(timer);
                    signal?.removeEventListener?.('abort', onAbort);
                    this.aborts.delete(controller);
                }
                if (REDIRECT_CODES.has(res.status)) {
                    if (redirects >= this.config.safety.maxRedirects) {
                        return { ok: false, status: res.status, error: '跳转次数超限', ms: Date.now() - started, bytes: 0, url };
                    }
                    const next = new URL(res.headers.get('location') || '', url).toString();
                    if (!isPublicHttpUrl(next)) {
                        return { ok: false, status: res.status, error: '跳转到非公开地址', ms: Date.now() - started, bytes: 0, url };
                    }
                    return this.rawGet(next, { timeoutMs: timeout, maxBytes: limit, signal, via, redirects: redirects + 1 });
                }
                const ct = String(res.headers.get('content-type') || '').toLowerCase();
                if (ct && !/^(text\/|application\/(xhtml|xml|rss|atom|json|ld\+json))/u.test(ct)) {
                    try {
                        await res.body?.cancel();
                    } catch {
                        /* 忽略 */
                    }
                    return { ok: true, status: res.status, contentType: ct, text: '', bytes: 0, truncated: false, ms: Date.now() - started, url: res.url || url, via: 'direct', skipped: 'non-text' };
                }
                const { buffer, truncated } = await readCapped(res, limit);
                const text = decodeBody(buffer, res.headers.get('content-type') || '');
                return {
                    ok: res.status >= 200 && res.status < 300,
                    status: res.status,
                    contentType: res.headers.get('content-type') || '',
                    text,
                    bytes: buffer.length,
                    truncated,
                    ms: Date.now() - started,
                    url: res.url || url,
                    via: 'direct',
                };
            } catch (error) {
                const reason = error?.name === 'AbortError' ? `超时(${timeout}ms)` : String(error?.cause?.code || error?.message || error);
                return { ok: false, status: 0, error: reason, ms: Date.now() - started, bytes: 0, url, via: 'direct' };
            }
        }
        // 兜底：宿主 Web 提供方
        if (!this.web) return { ok: false, status: 0, error: '无 Web 提供方', ms: 0, bytes: 0, url };
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);
            const signal2 = signal ? AbortSignal.any?.([signal, controller.signal]) ?? controller.signal : controller.signal;
            let res;
            try {
                res = await this.web.fetch({ url }, signal2);
            } finally {
                clearTimeout(timer);
            }
            const content = String(res?.body?.content ?? '');
            return {
                ok: res?.statusCode >= 200 && res?.statusCode < 300,
                status: res?.statusCode ?? 0,
                contentType: res?.body?.kind === 'html' ? 'text/html' : 'text/plain',
                text: content,
                bytes: content.length,
                truncated: Boolean(res?.truncated),
                ms: Date.now() - started,
                url: res?.url || url,
                via: 'web',
            };
        } catch (error) {
            return { ok: false, status: 0, error: `web 通道失败：${String(error?.message || error)}`, ms: Date.now() - started, bytes: 0, url, via: 'web' };
        }
    }

    /** 对外入口：robots 预检 + 同主机限速 + 网络失败自动换通道。 */
    async get(url, { signal, purpose = 'page', timeoutMs, maxBytes, skipRobots = false, headers = {} } = {}) {
        const started = Date.now();
        let robots = { allowed: true, delayMs: 0, reason: '' };
        if (purpose !== 'robots' && !skipRobots) {
            robots = await this.robots.check(url);
            if (!robots.allowed) {
                return { ok: false, status: 0, error: `robots.txt 禁止抓取（${robots.reason}）`, robots, bytes: 0, ms: Date.now() - started, text: '', url };
            }
        }
        await this.waitHost(url, robots.delayMs, signal);
        let res = await this.rawGet(url, { timeoutMs, maxBytes, signal, via: 'direct', headers });
        if (!res.ok && res.status === 0 && this.web) {
            const fallback = await this.rawGet(url, { timeoutMs, maxBytes, signal, via: 'web' });
            if (fallback.ok || fallback.status > 0) res = { ...fallback, fallbackFrom: res.error };
        }
        this.noteHost(url);
        if (this.store) this.store.noteSource(hostOf(url), Boolean(res.ok), res.ms);
        return { ...res, robots };
    }

    async waitHost(url, extraDelayMs, signal) {
        const host = hostOf(url);
        const minGap = Math.max(this.config.explore.minHostIntervalMs, extraDelayMs || 0);
        const last = this.hostGate.get(host) || 0;
        const wait = last + minGap - Date.now();
        if (wait > 0) await sleep(wait, signal);
    }

    noteHost(url) {
        this.hostGate.set(hostOf(url), Date.now());
        if (this.hostGate.size > 500) {
            const oldest = [...this.hostGate.entries()].sort((a, b) => a[1] - b[1]).slice(0, 200);
            for (const [k] of oldest) this.hostGate.delete(k);
        }
    }

    abortAll() {
        for (const c of this.aborts) {
            try {
                c.abort();
            } catch {
                /* 已结束 */
            }
        }
        this.aborts.clear();
    }
}

async function readCapped(res, limit) {
    if (!res.body) {
        const buf = Buffer.from(await res.arrayBuffer());
        return { buffer: buf.subarray(0, limit), truncated: buf.length > limit };
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    let truncated = false;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(Buffer.from(value));
        total += value.length;
        if (total >= limit) {
            truncated = true;
            try {
                await reader.cancel();
            } catch {
                /* 忽略取消失败 */
            }
            break;
        }
    }
    const buffer = Buffer.concat(chunks).subarray(0, limit);
    return { buffer, truncated };
}

export function decodeBody(buffer, contentType = '') {
    const head = buffer.subarray(0, 4096).toString('latin1');
    const fromHeader = /charset=["']?([\w-]+)/iu.exec(contentType)?.[1];
    const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/iu.exec(head)?.[1]
        || /<meta[^>]+content=["'][^"']*charset=([\w-]+)/iu.exec(head)?.[1];
    const candidates = [fromHeader, fromMeta, 'utf-8'].filter(Boolean);
    for (const enc of candidates) {
        const lower = String(enc).toLowerCase();
        if (lower === 'gb2312' || lower === 'gbk' || lower === 'gb18030') {
            try {
                return new TextDecoder('gb18030').decode(buffer);
            } catch {
                continue;
            }
        }
        try {
            const text = new TextDecoder(lower === 'utf8' ? 'utf-8' : lower).decode(buffer);
            const bad = (text.match(/\uFFFD/gu) || []).length;
            if (bad === 0 || bad / Math.max(1, text.length) < 0.002) return text;
        } catch {
            /* 换下一个 */
        }
    }
    return new TextDecoder('utf-8').decode(buffer);
}

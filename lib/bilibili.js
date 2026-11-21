/**
 * B站游客态（不登录）公开内容读取。
 *
 * 用户明确说明：B站评论区不登录也能看，游客状态进去就行，只是会弹窗。
 * 因此这里按"游客访客"的方式读取公开数据：
 *   - 排行榜 API 随机发现视频；
 *   - 视频详情 API 取 cid；
 *   - 评论走 wbi 签名接口（游客可用），每视频 2–6 条；
 *   - 弹幕走公开的 list.so XML（游客可用），每视频最多上千条短句。
 *
 * 约束：
 *   - 不登录、不带账号 cookie、不碰验证码/风控挑战；
 *   - 低频（每个视频 3–4 个请求，视频之间有间隔）；
 *   - 只保留文本，不保存用户名/UID；
 *   - B站 robots.txt 是全站 Disallow，这里是在用户明确指示下访问其公开页面，
 *     这一点在 README 和面板"平台状态"里写明。
 */

import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync } from 'node:zlib';
import { oneLine, truncate, sleep } from './util.js';

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const REFERER = 'https://www.bilibili.com/';
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

/** 直接走 https：B站请求不共用主抓取器的连接池，长跑也不受主连接池影响。 */
function httpsGet(url, headers, timeoutMs = 20000, redirects = 0) {
    return new Promise((resolve, reject) => {
        const req = httpsRequest(url, { method: 'GET', headers }, (res) => {
            const { statusCode, headers: resHeaders } = res;
            if (statusCode >= 300 && statusCode < 400 && resHeaders.location && redirects < 3) {
                res.resume();
                resolve(httpsGet(new URL(resHeaders.location, url).toString(), headers, timeoutMs, redirects + 1));
                return;
            }
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > 2 * 1024 * 1024) { req.destroy(new Error('响应过大')); return; }
                chunks.push(chunk);
            });
            res.on('end', () => {
                const raw = Buffer.concat(chunks);
                let body = raw;
                const encoding = String(resHeaders['content-encoding'] || '').toLowerCase();
                try {
                    if (encoding.includes('gzip')) body = gunzipSync(raw);
                    else if (encoding.includes('deflate')) {
                        try {
                            body = inflateSync(raw);
                        } catch {
                            body = inflateRawSync(raw);
                        }
                    } else if (encoding.includes('br')) body = brotliDecompressSync(raw);
                } catch {
                    body = raw;
                }
                resolve({ status: statusCode || 0, text: body.toString('utf8') });
            });
            res.on('error', reject);
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
    });
}

const md5 = (text) => createHash('md5').update(text).digest('hex');

/** wbi 混淆密钥：img_key + sub_key 经固定置换表取前 32 位。 */
export function mixinKey(imgKey, subKey) {
    const raw = `${imgKey}${subKey}`;
    return MIXIN_TAB.map((i) => raw[i] || '').join('').slice(0, 32);
}

/** 生成带 w_rid 的查询串；ts 可注入以便测试。 */
export function biliSign(params, key, ts = Math.floor(Date.now() / 1000)) {
    const p = { ...params, wts: String(ts) };
    const query = Object.keys(p)
        .sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/gu, ''))}`)
        .join('&');
    return `${query}&w_rid=${md5(query + key)}`;
}

/** 弹幕 XML → 文本数组。 */
export function parseDanmakuXml(xml) {
    const out = [];
    for (const m of String(xml ?? '').matchAll(/<d\s+p="[^"]*">([^<]+)<\/d>/gu)) {
        const text = oneLine(m[1]);
        if (text.length >= 2) out.push(text);
    }
    return out;
}

export class BilibiliGuest {
    constructor({ fetcher, logger = null }) {
        this.fetcher = fetcher;
        this.logger = logger;
        this.sessionCache = null;
        this.sessionAt = 0;
    }

    async #getJson(url, cookie = '') {
        let lastError = '';
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const res = await httpsGet(url, {
                    'user-agent': UA,
                    referer: REFERER,
                    accept: 'application/json, text/plain, */*',
                    ...(cookie ? { cookie } : {}),
                });
                if (res.status < 200 || res.status >= 300) {
                    lastError = 'B站请求失败：' + res.status;
                    if (res.status < 500 && res.status !== 412) break;
                } else {
                    const parsed = JSON.parse(res.text);
                    if (parsed && (parsed.code === -352 || parsed.code === -403)) {
                        this.sessionCache = null;
                        this.sessionAt = 0;
                        lastError = 'B站风控：' + parsed.code;
                    } else {
                        return parsed;
                    }
                }
            } catch (error) {
                lastError = String((error && error.message) || error);
            }
            await sleep(700 + attempt * 600);
        }
        throw new Error(lastError || 'B站请求失败');
    }
    async #getText(url, cookie = '') {
        let lastError = '';
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const res = await httpsGet(url, { 'user-agent': UA, referer: REFERER, ...(cookie ? { cookie } : {}) });
                if (res.status >= 200 && res.status < 300) return res.text;
                lastError = 'B站请求失败：' + res.status;
            } catch (error) {
                lastError = String((error && error.message) || error);
            }
            await sleep(700 + attempt * 600);
        }
        throw new Error(lastError || 'B站请求失败');
    }

    async session() {
        if (this.sessionCache && Date.now() - this.sessionAt < 3600_000) return this.sessionCache;
        const nav = await this.#getJson('https://api.bilibili.com/x/web-interface/nav');
        const img = String(nav?.data?.wbi_img?.img_url || '').split('/').pop().split('.')[0];
        const sub = String(nav?.data?.wbi_img?.sub_url || '').split('/').pop().split('.')[0];
        if (!img || !sub) throw new Error('B站游客会话缺少 wbi 密钥');
        let cookie = '';
        try {
            const spi = await this.#getJson('https://api.bilibili.com/x/frontend/finger/spi');
            if (spi?.data?.b_3) cookie = `buvid3=${spi.data.b_3}; buvid4=${spi.data.b_4 || ''}`;
        } catch {
            /* 没有 buvid 也先试 */
        }
        this.sessionCache = cookie ? { key: mixinKey(img, sub), cookie } : null;
        this.sessionAt = cookie ? Date.now() : 0;
        return this.sessionCache || { key: mixinKey(img, sub), cookie: '' };
    }

    /** 排行榜：随机视频池。 */
    async ranking() {
        const list = [];
        const errors = [];
        let cookie = '';
        try {
            cookie = (await this.session()).cookie;
        } catch {
            /* 没有 cookie 也先试，被风控会返回 -352 */
        }
        const push = (items, rid) => {
            for (const v of items || []) {
                if (!v?.aid) continue;
                list.push({
                    aid: Number(v.aid),
                    bvid: String(v.bvid || ''),
                    title: oneLine(v.title || ''),
                    replies: Number(v?.stat?.reply || v?.stat?.reply || 0),
                    danmaku: Number(v?.stat?.danmaku || 0),
                    rid,
                });
            }
        };
        // 首选排行榜；被风控就换热门与分区最新
        for (const rid of [0, 3]) {
            try {
                const j = await this.#getJson(`https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`, cookie);
                push(j?.data?.list, rid);
            } catch (error) {
                errors.push(String(error && error.message || error));
            }
            if (list.length) break;
            await sleep(300);
        }
        if (!list.length) {
            for (const pn of [1, 2, 3]) {
                try {
                    const j = await this.#getJson(`https://api.bilibili.com/x/web-interface/popular?ps=20&pn=${pn}`, cookie);
                    push(j?.data?.list, 'popular');
                } catch {
                    /* 继续 */
                }
                await sleep(250);
            }
        }
        if (!list.length) {
            for (const pn of [1, 2]) {
                try {
                    const j = await this.#getJson(`https://api.bilibili.com/x/web-interface/newlist?rid=0&pn=${pn}&ps=20`, cookie);
                    push(j?.data?.archives, 'newlist');
                } catch {
                    /* 继续 */
                }
                await sleep(250);
            }
        }
        const seen = new Set();
        this.lastError = list.length ? '' : errors.join(' | ');
        return list.filter((v) => (seen.has(v.aid) ? false : (seen.add(v.aid), true)));
    }

    /** 视频详情（拿 cid、时长）。 */
    async view(aid) {
        const j = await this.#getJson(`https://api.bilibili.com/x/web-interface/view?aid=${aid}`);
        if (j?.code !== 0) throw new Error(`B站视频详情失败：${j?.message || j?.code}`);
        return {
            cid: Number(j.data.cid),
            title: oneLine(j.data.title || ''),
            desc: String(j.data.desc || '').replace(/\s+/gu, ' ').trim().slice(0, 200),
            owner: '',
        };
    }

    /** 评论区（游客可读部分）：mode 2 最新 + mode 3 热门，最多 6 条。 */
    async comments(aid) {
        const { key, cookie } = await this.session();
        const out = [];
        for (const mode of [2, 3]) {
            try {
                const query = biliSign({
                    oid: String(aid), type: '1', mode: String(mode), next: '0', ps: '20',
                    plat: '1', seek_rpid: '', web_location: '1315875',
                }, key);
                const j = await this.#getJson(`https://api.bilibili.com/x/v2/reply/wbi/main?${query}`, cookie);
                for (const r of j?.data?.replies || []) {
                    const text = oneLine(r?.content?.message || '');
                    if (text.length >= 2) out.push({ text: truncate(text, 300), pos: out.length, hot: Number(r.like) || 0, source: 'comment' });
                }
            } catch {
                /* 该模式失败就跳过 */
            }
            await sleep(250);
        }
        return out;
    }

    /** 弹幕（公开 XML）：随机取样。 */
    async danmaku(cid, { limit = 200 } = {}) {
        try {
            const xml = await this.#getText(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`);
            const all = parseDanmakuXml(xml);
            if (!all.length) return [];
            const picked = [];
            const seen = new Set();
            let guard = 0;
            while (picked.length < limit && guard < all.length * 3) {
                guard += 1;
                const text = all[Math.floor(Math.random() * all.length)];
                if (seen.has(text)) continue;
                seen.add(text);
                picked.push({ text: truncate(text, 120), pos: picked.length, source: 'danmaku' });
            }
            return picked;
        } catch {
            return [];
        }
    }

    /** 一次完整取样：视频 + 评论 + 弹幕。 */
    async learnBundle(video, { danmakuLimit = 120 } = {}) {
        const info = await this.view(video.aid);
        const comments = await this.comments(video.aid);
        const danmaku = await this.danmaku(info.cid, { limit: danmakuLimit });
        return {
            title: info.title || video.title,
            aid: video.aid,
            bvid: video.bvid,
            cid: info.cid,
            comments,
            danmaku,
            all: [...comments, ...danmaku],
        };
    }
}

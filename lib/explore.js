/**
 * 自主互联网探索引擎（AWE）。
 *
 * 三通道：
 *   random    完全随机：不看当前主题，从待访问队列/订阅源里挑陌生领域
 *   extension 自然延伸：跟着刚读的页面里偶然出现的链接走
 *   interest  自主兴趣：围绕探索中自然形成的阶段性兴趣深入
 *
 * 关键不是"随机数"，是**反茧房**：近期领域降权、长期未访领域提权、
 * 通道实际比例向目标比例做负反馈修正、连续同域强制跳走。
 * 任何一次探索都可以被暂停/恢复/停止，且每页处理完立刻释放正文，避免内存堆积。
 */

import {
    canonicalUrl, hostOf, isPublicHttpUrl, isJunkLink, weightedPick, shuffle, sleep, clamp,
    dayKey, truncate, oneLine, jitter,
} from './util.js';
import { FEEDS, DISCUSSION_API, classifyDomain } from './sources.js';
import { PLATFORMS, platformById } from './platforms.js';
import { extractCommentBlocks, sampleComments, commentFeatures, patternsFromComments, trendCandidates } from './discussions.js';
import { BilibiliGuest } from './bilibili.js';
import { looksLikeFeed, parseFeed, parseHtml, parseHnDiscussion } from './parse.js';
import { analyzePage, analyzeLanguage } from './analyze.js';
import { extractFeatures, extractPatterns } from './language.js';

const CHANNELS = ['random', 'extension', 'interest'];
const MAX_LAST_LINKS = 40;

export class Explorer {
    constructor({ store, fetcher, config, web, logger, settings = null, agents = null }) {
        this.store = store;
        this.settings = settings;
        this.agents = agents;
        this.bili = new BilibiliGuest({ fetcher, logger });
        this.fetcher = fetcher;
        this.config = config;
        this.web = web;
        this.logger = logger;
        this.lastLinks = [];
        this.lastUrl = '';
        this.lastHost = '';
        this.cycleSeq = 0;
        this.state = {
            running: false,
            paused: false,
            stopRequested: false,
            cycleId: '',
            startedAt: 0,
            pagesDone: 0,
            pagesTarget: 0,
            lastError: '',
            lastResult: null,
            controller: null,
        };
        this.domainCache = null;
    }

    // ---------------- 对外控制面 ----------------

    status() {
        const s = this.state;
        return {
            running: s.running,
            paused: s.paused,
            cycleId: s.cycleId,
            pagesDone: s.pagesDone,
            pagesTarget: s.pagesTarget,
            elapsedMs: s.startedAt ? Date.now() - s.startedAt : 0,
            lastError: s.lastError,
            lastResult: s.lastResult ? summarizeResult(s.lastResult) : null,
            heapMB: Math.round(process.memoryUsage().heapUsed / 1_048_576),
            frontier: this.store.frontierStats(),
            interests: this.store.topInterests(3),
            schedule: this.config.schedule,
            groups: this.store.groupCounts(),
            mode: this.cycleMode || 'normal',
            discussions: this.store.discussionStats(),
        };
    }

    start({ pages, minutes } = {}) {
        if (this.state.running) throw new Error('已有探索周期在运行，先 stop 或等它结束');
        const target = clamp(Math.round(pages || this.config.explore.pagesPerCycle), 1, this.config.explore.maxPagesPerCycle);
        this.state.stopRequested = false;
        this.state.paused = false;
        const promise = this.runCycle({ pages: target, minutes });
        return { started: true, pages: target, minutes: minutes || null, promise };
    }

    pause() {
        if (!this.state.running) throw new Error('当前没有运行中的探索');
        this.state.paused = true;
        this.store.log('info', '探索已暂停', this.state.cycleId);
        return this.status();
    }

    resume() {
        if (!this.state.running) throw new Error('当前没有运行中的探索');
        this.state.paused = false;
        this.store.log('info', '探索已恢复', this.state.cycleId);
        return this.status();
    }

    stop() {
        this.state.stopRequested = true;
        this.state.paused = false;
        try {
            this.state.controller?.abort();
        } catch {
            /* 已结束 */
        }
        this.fetcher.abortAll();
        this.store.log('info', '收到停止指令', this.state.cycleId);
        return { stopping: true, cycleId: this.state.cycleId };
    }

    // ---------------- 周期 ----------------

    async runCycle({ pages = this.config.explore.pagesPerCycle, minutes = 0, onProgress, mode = 'normal', mixed = false } = {}) {
        if (this.state.running) throw new Error('已有探索周期在运行');
        const cycleId = `c${Date.now().toString(36)}-${(this.cycleSeq += 1)}`;
        const controller = new AbortController();
        Object.assign(this.state, {
            running: true, paused: false, stopRequested: false, cycleId,
            startedAt: Date.now(), pagesDone: 0, pagesTarget: pages, lastError: '', controller,
        });
        this.cycleMode = mode;
        this.mixComments = Boolean(mixed) && mode !== 'comments';
        this.mixToggle = false;
        const deadline = minutes > 0 ? Date.now() + minutes * 60_000 : 0;
        const results = [];
        let stoppedReason = 'done';
        this.store.log('info', `探索周期开始：${pages} 页`, cycleId);
        try {
            this.refreshDomainCache();
            for (let i = 0; i < pages; i += 1) {
                if (this.state.stopRequested) {
                    stoppedReason = 'stopped';
                    break;
                }
                while (this.state.paused && !this.state.stopRequested) await sleep(400, controller.signal);
                if (this.state.stopRequested) {
                    stoppedReason = 'stopped';
                    break;
                }
                if (deadline && Date.now() > deadline) {
                    stoppedReason = 'time-budget';
                    break;
                }
                if (this.store.visitsTodayCount() >= this.config.explore.maxVisitsPerDay) {
                    stoppedReason = 'daily-cap';
                    break;
                }
                if (process.memoryUsage().heapUsed / 1_048_576 > this.config.memory.maxHeapMB) {
                    stoppedReason = 'memory';
                    this.store.log('warn', '堆内存超限，主动结束本周期', `${this.config.memory.maxHeapMB}MB`);
                    break;
                }
                const channel = this.chooseChannel();
                const target = await this.chooseTarget({ channel, signal: controller.signal });
                if (!target) {
                    const seeded = this.seedFrontier(6);
                    if (!seeded) {
                        stoppedReason = 'no-target';
                        break;
                    }
                    continue;
                }
                let result;
                try {
                    result = await this.processPage(target, channel, controller.signal);
                } catch (error) {
                    result = { url: target.url, ok: false, status: 'error', domain: target.domain, title: '', error: String(error?.message || error), patterns: 0, knowledge: 0, links: 0, ms: 0 };
                    this.store.log('error', `单页处理失败：${String(error?.message || error)}`, String(error?.stack || '').slice(0, 400));
                }
                results.push(result);
                this.state.pagesDone += 1;
                this.state.lastResult = result;
                onProgress?.(result);
                if (result.ok) this.consecutiveFailures = 0;
                else this.consecutiveFailures = (this.consecutiveFailures || 0) + 1;
                if (this.consecutiveFailures >= 6) {
                    stoppedReason = 'too-many-failures';
                    this.store.log('warn', '连续抓取失败过多，提前结束', String(this.consecutiveFailures));
                    break;
                }
                await sleep(this.config.explore.pageGapMs + jitter(600), controller.signal);
            }
        } catch (error) {
            stoppedReason = controller.signal.aborted ? 'stopped' : 'error';
            this.state.lastError = String(error?.message || error);
            this.store.log('error', `探索周期异常：${this.state.lastError}`, cycleId);
        } finally {
            this.state.running = false;
            this.state.paused = false;
            this.state.controller = null;
            this.lastLinks = this.lastLinks.slice(0, MAX_LAST_LINKS);
            try {
                this.store.decayInterests(0.9);
                this.store.prune();
            } catch (error) {
                this.store.log('warn', `收尾维护失败：${String(error?.message || error)}`);
            }
        }
        const diary = this.buildDiary({ cycleId, results, stoppedReason });
        let diaryId = 0;
        if (results.length > 0) {
            try {
                diaryId = this.store.addDiary({ cycleId, visited: results.filter((r) => r.ok).length, domains: diary.domains, body: diary.text });
            } catch (error) {
                this.store.log('warn', `日记写入失败：${String(error?.message || error)}`);
            }
        }
        const out = {
            cycleId,
            pages: results.length,
            ok: results.filter((r) => r.ok).length,
            failed: results.filter((r) => !r.ok).length,
            stoppedReason,
            elapsedMs: Date.now() - this.state.startedAt,
            results,
            diary: diary.text,
            diaryId,
            domains: diary.domains,
        };
        this.store.log('info', `探索周期结束：${out.ok}/${out.pages} 成功（${stoppedReason}）`, cycleId);
        return out;
    }

    // ---------------- 通道与目标选择 ----------------

    /** 负反馈控制器：让实际通道比例向目标比例收敛，但永远保留随机通道。 */
    chooseChannel() {
        const mix = this.config.explore.channelMix;
        const recent = this.store.recentDomainSequence(20);
        const counts = { random: 0, extension: 0, interest: 0 };
        for (const r of recent) counts[r.channel] = (counts[r.channel] || 0) + 1;
        const n = Math.max(5, recent.length);
        const weights = [];
        for (const ch of CHANNELS) {
            const actual = counts[ch] / n;
            const w = mix[ch] * clamp(1 + (mix[ch] - actual) * 1.4, 0.25, 3);
            weights.push({ ch, w });
        }
        // 连续三个不同站点但同领域 → 强制随机跳开
        const last3 = recent.slice(0, 3);
        if (last3.length === 3 && last3.every((r) => r.domain === last3[0].domain)) return 'random';
        const chosen = weightedPick(weights, Math.random, (x) => x.w) || { ch: 'random' };
        return chosen.ch;
    }

    async chooseTarget({ channel, signal }) {
        if (this.cycleMode === 'comments') {
            const direct = this.commentTarget();
            if (direct) return direct;
        }
        // 「学习一次」：评论区与普通页面交替，评论区占一半
        if (this.mixComments) {
            this.mixToggle = !this.mixToggle;
            if (this.mixToggle) {
                const direct = this.commentTarget();
                if (direct) return direct;
            }
        }
        if (channel === 'extension') {
            const t = this.targetFromLinks();
            if (t) return t;
        }
        if (channel === 'interest') {
            const t = await this.targetFromInterest(signal);
            if (t) return t;
        }
        return this.targetFromFrontier();
    }

    /** 评论区模式：直接从平台注册表合成目标，避免被队列冷却/已访问状态卡住。 */
    commentTarget() {
        const pool = PLATFORMS.filter((p) => (p.group === 'forum' || p.group === 'video') && p.status !== 'down');
        if (!pool.length) return null;
        const recent = this.store.recentVisits(30);
        const count = new Map();
        for (const v of recent) if (v.platform) count.set(v.platform, (count.get(v.platform) || 0) + 1);
        // 面板里设置的平台占比优先：0 = 不学该平台，其它按数值分配
        const weights = this.settings ? this.settings.get('platformWeights', null) : null;
        const useWeights = weights && typeof weights === 'object' && Object.keys(weights).length > 0;
        let active;
        let weighted;
        if (useWeights) {
            active = pool.filter((p) => Number(weights[p.id]) > 0);
            if (!active.length) active = pool;
            weighted = active.map((p) => ({
                platform: p,
                weight: (Number(weights[p.id]) || (p.weight || 0.6)) / (1 + (count.get(p.id) || 0)),
            }));
        } else {
            // 没设置时：有公开评论 API 的平台优先（当前是 GitHub 议题）：70% 概率直接走它们
            const apiPool = pool.filter((p) => p.comments === 'api' || p.comments === 'guest');
            active = apiPool.length && Math.random() < 0.7 ? apiPool : pool;
            weighted = active.map((p) => ({
                platform: p,
                weight: (p.weight || 0.6) * (p.comments === 'guest' ? 4 : p.comments === 'api' ? 3 : 1) / (1 + (count.get(p.id) || 0)),
            }));
        }
        const picked = weightedPick(weighted, Math.random, (x) => x.weight);
        if (!picked) return null;
        return {
            url: picked.platform.entry, domain: '未分类', host: hostOf(picked.platform.entry),
            source: `platform:${picked.platform.id}`, group: picked.platform.group, platform: picked.platform.id,
        };
    }

    targetFromFrontier() {
        this.ensureFrontier(12);
        const all = this.store.frontierCandidates(300);
        let rows = all.filter((r) => !this.tooRecent(r.url));
        if (!rows.length) {
            // 冷却期把所有目标都挡住了：允许重访平台入口（种子行），否则会空转
            rows = all.filter((r) => String(r.source || '').startsWith('seed:'));
        }
        if (this.cycleMode === 'comments') {
            // 评论区探索：只挑论坛/视频分组的目标（平台入口不受冷却期限制）
            const platformTarget = all.filter((r) => r.platform && r.platform !== 'rss' && (r.group === 'forum' || r.group === 'video'));
            if (platformTarget.length) {
                rows = platformTarget;
            } else {
                this.seedFrontier(4, 'forum');
                rows = this.store.frontierCandidates(300).filter((r) => r.group === 'forum' || r.group === 'video');
            }
        }
        if (!rows.length) return null;
        const domainCounts = this.domainCache || new Map();
        const prefer = this.config.inject.defaultLang || 'zh';
        // 4.0 中文优先：加权而不是硬过滤，否则容易掉进单一平台/单一领域
        const zhPriority = this.settings ? this.settings.get('chinesePriority', true) : true;
        // 领域/平台去偏：最近 30 次访问里占比过高的目标降权
        const recent30 = this.store.recentVisits(30);
        const domainShare = new Map();
        const platformShare = new Map();
        for (const v of recent30) {
            domainShare.set(v.domain, (domainShare.get(v.domain) || 0) + 1);
            if (v.platform) platformShare.set(v.platform, (platformShare.get(v.platform) || 0) + 1);
        }
        const biasFactor = (row) => {
            let factor = 1;
            const dShare = (domainShare.get(row.domain) || 0) / Math.max(1, recent30.length);
            if (dShare > 0.35) factor *= 0.15;
            else if (dShare > 0.2) factor *= 0.5;
            if (row.platform) {
                const pShare = (platformShare.get(row.platform) || 0) / Math.max(1, recent30.length);
                if (pShare > 0.35) factor *= 0.2;
                else if (pShare > 0.2) factor *= 0.55;
            }
            return factor;
        };
        const isZhRow = (row) => platformById(row.platform)?.lang === 'zh' || (row.platform && row.platform !== 'rss' && this.hostLangOf(row.host) === 'zh');
        // 中文占比不足时加大倾斜：中文 ×3，非中文 ×0.4；中文够了就温和加权
        const zhShare = recent30.length ? recent30.filter((v) => v.lang === 'zh').length / recent30.length : 0;
        const zhBoost = zhShare < 0.3 ? 3 : 1.8;
        const enPenalty = zhShare < 0.3 ? 0.4 : 1;
        // 语种平衡：最近访问里偏好语种太少时，提高同语种来源的权重（不改变领域分布）
        const recent = this.store.recentVisits(10);
        const preferShare = recent.length >= 5 ? recent.filter((v) => v.lang === prefer).length / recent.length : 0.5;
        const langFactor = preferShare < 0.25 ? 3 : 1;
        const weighted = rows.map((r) => ({
            ...r,
            weight: this.diversityWeight(r.domain, domainCounts, r.priority)
                * (this.hostLangOf(r.host) === prefer ? langFactor : 1)
                * this.hostYieldFactor(r.host)
                * biasFactor(r)
                * (zhPriority ? (isZhRow(r) ? zhBoost : enPenalty) : 1),
        }));
        const mix = this.settings ? this.settings.mix() : { video: 45, forum: 30, blog: 15, other: 10 };
        for (const row of weighted) {
            const share = (mix[row.group] ?? 10) / 100;
            row.weight *= 0.3 + share * 2.4;
        }
        const chosen = weightedPick(weighted, Math.random, (x) => x.weight);
        return chosen ? {
            url: chosen.url, domain: chosen.domain, host: chosen.host,
            source: chosen.source || 'frontier', group: chosen.group || 'other', platform: chosen.platform || '',
        } : null;
    }

    /** 抓得到但读不出正文的站点降权（连续 2 次平均正文 <500 字）。 */
    hostYieldFactor(host) {
        const stat = this.hostStats?.get(host);
        if (!stat || stat.n < 2) return 1;
        if (stat.avgLen >= 500) return 1;
        return stat.avgLen >= 250 ? 0.6 : 0.3;
    }

    /** 站点语种：来自注册表的源优先，其次按域名后缀/常见中文站点兜底。 */
    hostLangOf(host) {
        if (!this.langByHost) {
            this.langByHost = new Map();
            for (const feed of this.availableFeeds()) this.langByHost.set(hostOf(feed.url), feed.lang);
        }
        if (this.langByHost.has(host)) return this.langByHost.get(host);
        if (/\.(cn|com\.cn|net\.cn|org\.cn|io\.cn)$/u.test(host) || /(douban|zhihu|v2ex|sspai|gcores|solidot|ifanr|36kr|ruanyifeng|hupu|jiemian|lifeweek|guokr|infoq\.cn|oschina|csdn|jiemodui|jiandanxinli|sciencenet|allhistory|gushiwen)/u.test(host)) return 'zh';
        return 'en';
    }

    /** 从刚读页面的链接里延伸；同站优先，但只在 followSameHost 开启时。 */
    targetFromLinks() {
        const candidates = this.lastLinks.filter((l) => !this.tooRecent(l.url) && l.url !== this.lastUrl);
        if (!candidates.length) return null;
        // 同站占比过高时压一压延伸，避免在同一个站里绕圈
        const recent30 = this.store.recentVisits(30);
        const hostCount = new Map();
        for (const v of recent30) hostCount.set(v.site, (hostCount.get(v.site) || 0) + 1);
        const hostShare = this.lastHost ? (hostCount.get(this.lastHost) || 0) / Math.max(1, recent30.length) : 0;
        const weighted = candidates.map((l) => {
            const sameHost = hostOf(l.url) === this.lastHost;
            const anchorQuality = l.anchor.length >= 6 && l.anchor.length <= 40 ? 1.3 : 0.8;
            let weight = (this.config.explore.followSameHost && sameHost ? 1.6 : 1) * anchorQuality;
            if (sameHost && hostShare > 0.4) weight *= 0.2;
            if (sameHost && hostShare > 0.55) weight *= 0.1;
            // 中文优先时压低"锚文本没有中文 + 站点不是中文站"的链接
            const zhAnchor = /[\u3400-\u9fff]/u.test(l.anchor || '');
            const zhSite = this.hostLangOf(hostOf(l.url)) === 'zh';
            if (this.settings && this.settings.get('chinesePriority', true) && !zhAnchor && !zhSite) weight *= 0.3;
            return { ...l, sameHost, weight };
        });
        const chosen = weightedPick(weighted, Math.random, (x) => x.weight);
        return chosen ? {
            url: chosen.url, domain: '未分类', host: hostOf(chosen.url),
            source: `extension:${hostOf(this.lastUrl)}`, sameHost: chosen.sameHost,
            group: this.lastGroup || 'other', platform: this.lastPlatform || '',
        } : null;
    }

    async targetFromInterest(signal) {
        const interests = this.store.topInterests(3).filter((i) => i.weight >= 0.4);
        if (!interests.length) return null;
        const interest = interests[Math.floor(Math.random() * interests.length)];
        // 先看队列里有没有与兴趣相关的
        this.ensureFrontier(6);
        const rows = this.store.frontierCandidates(150).filter((r) => !this.tooRecent(r.url));
        const related = rows.filter((r) => r.domain === interest.domain || r.url.toLowerCase().includes(encodeURIComponent(interest.topic).toLowerCase()) || r.source.includes('feed'));
        if (related.length && Math.random() < 0.5) {
            const chosen = weightedPick(related, Math.random, (x) => x.priority * this.diversityWeight(x.domain, this.domainCache || new Map(), 1));
            if (chosen) return { url: chosen.url, domain: chosen.domain, host: chosen.host, source: `interest:${interest.topic}`, group: chosen.group || 'other', platform: chosen.platform || '' };
        }
        if (this.web?.search) {
            try {
                const res = await this.web.search({ query: `${interest.topic} ${interest.domain}`, maxResults: 3 }, signal);
                const urls = (res?.sources || []).map((s) => canonicalUrl(s.url)).filter((u) => u && !this.tooRecent(u));
                if (urls.length) {
                    return { url: urls[0], domain: interest.domain, host: hostOf(urls[0]), source: `interest-search:${interest.topic}`, group: 'other', platform: '' };
                }
            } catch (error) {
                this.store.log('warn', `兴趣检索失败（降级到队列）：${String(error?.message || error)}`, interest.topic);
            }
        }
        return null;
    }

    /** 反茧房权重：近期同域降权、长期未访提权、从未访问的领域最高。 */
    diversityWeight(domain, domainCounts, priority = 1) {
        const recent = this.store.recentDomainSequence(12);
        const recentSame = recent.filter((r) => r.domain === domain).length;
        const lastSeen = domainCounts.get(domain) || 0;
        let factor = 1 / (1 + recentSame * 1.2);
        if (!lastSeen) factor *= 1.9;
        else {
            const days = (Date.now() - lastSeen) / 86_400_000;
            factor *= clamp(0.45 + days / 5, 0.45, 1.7);
        }
        return Math.max(0.05, priority * factor);
    }

    tooRecent(url) {
        const canonical = canonicalUrl(url);
        if (!canonical) return true;
        const last = this.store.lastVisitAt(canonical);
        if (!last) return false;
        return Date.now() - last < this.config.explore.revisitCooldownDays * 86_400_000;
    }

    refreshDomainCache() {
        const counts = this.store.domainCounts(200);
        this.domainCache = new Map(counts.map((c) => [c.domain, c.last]));
        this.hostStats = this.store.hostStats();
    }

    // ---------------- 队列维护 ----------------

    availableFeeds() {
        const disabled = new Set(this.config.sources.disabled);
        const extra = this.config.sources.extraFeeds || [];
        return [...FEEDS, ...extra].filter((f) => !disabled.has(f.id) && isPublicHttpUrl(f.url));
    }

    ensureFrontier(min = 8) {
        if (this.store.frontierStats().new >= min) return false;
        return this.seedFrontier(Math.max(4, Math.ceil(min / 2)));
    }

    seedFrontier(count = 6, forceGroup = '') {
        const feeds = this.availableFeeds();
        const recentHosts = new Set(this.store.recentVisits(10).map((v) => hostOf(v.url)));
        const preferLang = this.config.inject.defaultLang || 'zh';
        const recent = this.store.recentVisits(10);
        const preferCount = recent.filter((v) => v.lang === preferLang).length;
        const langBoost = recent.length >= 6 && preferCount < 2 ? 3 : 1.6;
        const mix = this.settings ? this.settings.mix() : { video: 45, forum: 30, blog: 15, other: 10 };
        // 4.0：中文平台入口作为主粮，RSS 作为补充；按内容配比加权
        const platformRows = PLATFORMS.filter((p) => p.status !== 'down')
            .filter((p) => !forceGroup || p.group === forceGroup)
            .map((p) => ({
                id: `p:${p.id}`, url: p.entry, domain: '未分类', lang: 'zh',
                kind: p.access === 'rss' ? 'rss' : 'html', access: p.access,
                weight: (p.weight || 0.6) * 1.5, group: p.group, platform: p.id,
            }));
        const rssRows = feeds.map((f) => ({
            ...f, group: f.lang === 'zh' ? 'blog' : 'other', platform: 'rss',
        }));
        const weighted = [...platformRows, ...rssRows].map((f) => {
            const groupShare = (mix[f.group] ?? 10) / 100;
            return {
                ...f,
                weight: f.weight
                    * (recentHosts.has(hostOf(f.url)) ? 0.35 : 1)
                    * (f.lang === preferLang ? langBoost : 1)
                    * (0.25 + groupShare * 3),
            };
        });
        const chosen = [];
        const pool = [...weighted];
        while (chosen.length < count && pool.length) {
            const item = weightedPick(pool, Math.random, (x) => x.weight);
            if (!item) break;
            const idx = pool.indexOf(item);
            if (idx >= 0) pool.splice(idx, 1);
            if (chosen.some((c) => c.url === item.url)) continue;
            chosen.push(item);
        }
        let added = 0;
        for (const feed of chosen) {
            if (this.store.pushFrontier({
                url: feed.url,
                host: hostOf(feed.url),
                domain: feed.domain || '未分类',
                priority: feed.access === 'api' ? 1.9 : feed.kind === 'rss' ? 1.5 : 1.25,
                source: `seed:${feed.id}`,
                group: feed.group || 'other',
                platform: feed.platform || 'rss',
            })) added += 1;
        }
        // 评论区模式：优先保证有一个可解析的公开讨论 API 目标（GitHub 议题）
        if (forceGroup === 'forum') {
            const gh = PLATFORMS.find((p) => p.id === 'github-cn');
            if (gh) {
                this.store.pushFrontier({
                    url: gh.entry, host: hostOf(gh.entry), domain: '编程', priority: 2.2,
                    source: 'seed:github-cn', group: 'forum', platform: 'github-cn',
                });
            }
        }
        // 顺带给一条 HN 讨论页：评论区是最接近"自然交流"的语料
        if (Math.random() < 0.5) {
            this.store.pushFrontier({
                url: DISCUSSION_API.hnFront(20),
                host: 'hn.algolia.com',
                domain: '编程',
                priority: 1.35,
                source: 'seed:hn-discussion',
            });
        }
        if (added) this.store.log('info', `补充探索队列 ${added} 条`);
        return added > 0;
    }

    // ---------------- 单页处理 ----------------

    async processPage(target, channel, signal) {
        const started = Date.now();
        const url = target.url;
        this.refreshDomainCache();
        // 用户明确要求：这些平台按游客身份读公开页面（不登录、不碰验证码、低频）
        const guestPlatforms = new Set(['bilibili', 'hupu', 'douban-group', 'manual-url']);
        const res = await this.fetcher.get(url, { signal, purpose: 'page', skipRobots: guestPlatforms.has(target.platform) });
        const base = {
            url, channel, host: hostOf(url), site: hostOf(url),
            domain: target.domain || '未分类', status: 'ok', httpStatus: res.status || 0,
            bytes: res.bytes || 0, ms: res.ms || Date.now() - started,
            title: '', patterns: 0, knowledge: 0, links: 0,
            group: target.group || 'other', platform: target.platform || '',
        };
        if (res.skipped === 'non-text' || (!res.text && /(pdf|image\/|audio\/|video\/|zip|octet-stream)/u.test(String(res.contentType || '')))) {
            const skippedType = {
                ...base, ok: true, status: 'skipped_type', title: '',
                summary: `非文本内容（${res.contentType || 'unknown'}），未解析`,
                error: '',
            };
            this.store.addVisit({ ...base, canonical: canonicalUrl(url), status: 'skipped_type', summary: skippedType.summary, textLen: 0, links: 0 });
            this.store.markFrontier(url, 'skipped');
            return skippedType;
        }
        if (!res.ok) {
            const failed = {
                ...base, ok: false, status: 'fail', error: res.error || `HTTP ${res.status}`,
            };
            this.store.addVisit({ ...base, canonical: canonicalUrl(url), status: 'fail', error: failed.error, textLen: 0, links: 0 });
            this.store.markFrontier(url, 'failed');
            this.store.log('warn', `抓取失败：${base.error}`, url);
            return failed;
        }
        // 0) B站游客态（排行榜 → 视频 → 评论 + 弹幕）
        if (hostOf(url) === 'api.bilibili.com') {
            return this.processBilibili({ base, target, started });
        }
        // 0.1) GitHub 公开讨论 API
        if (hostOf(url) === 'api.github.com') {
            return this.processGithub({ res, base, channel, signal, started, target });
        }
        // 1) 订阅源
        if (looksLikeFeed(res.text, res.contentType)) {
            const feed = parseFeed(res.text, res.url || url);
            const items = feed.items.slice(0, 8);
            const queued = items.map((item) => ({
                url: item.link,
                host: hostOf(item.link),
                domain: target.domain || classifyDomain(`${item.title} ${item.summary}`, '未分类'),
                priority: 1.6,
                source: `feed:${hostOf(url)}`,
            })).filter((x) => !this.tooRecent(x.url));
            this.store.pushFrontierBatch(queued);
            const title = feed.feedTitle || '订阅源';
            this.store.addVisit({ ...base, canonical: canonicalUrl(url), title: truncate(title, 200), status: 'feed', textLen: res.text.length, links: items.length, summary: `订阅源 ${items.length} 条：${items.slice(0, 2).map((i) => i.title).join('｜')}`, group: target.group || 'blog', platform: target.platform || 'rss' });
            this.store.markFrontier(url, 'done');
            this.store.touchInterest({ topic: title, domain: base.domain, delta: 0.05 });
            return { ...base, ok: true, kind: 'feed', title, links: items.length, status: 'feed', feedItems: items.slice(0, 5).map((i) => ({ title: i.title, url: i.link })) };
        }
        // 2) HN 讨论 JSON（评论区语料）
        if (hostOf(url) === 'hn.algolia.com') {
            return this.processDiscussion({ res, base, channel, signal, started });
        }
        // 3) 普通网页
        const page = parseHtml(res.text, res.url || url);
        if (page.text.length < 120) {
            const thin = { ...base, ok: true, status: 'thin', title: page.title, links: page.links.length, summary: '正文过短（可能需 JS 渲染）' };
            this.store.addVisit({ ...base, canonical: canonicalUrl(url), title: page.title, status: 'thin', textLen: page.text.length, links: page.links.length, summary: thin.summary, group: target.group || 'other', platform: target.platform || '' });
            this.store.markFrontier(url, 'skipped');
            this.pushLinks(page.links, base.domain);
            this.lastLinks = page.links.slice(0, MAX_LAST_LINKS);
            this.lastUrl = url;
            this.lastHost = hostOf(url);
            return thin;
        }
        const analysis = analyzePage({
            url, title: page.title, text: page.text, headings: page.headings, links: page.links,
            sourceDomain: target.domain, lang: page.lang,
        });
        // 页面级提示注入拦截：整页隔离
        if (analysis.injection.blocked) {
            const blocked = {
                ...base, ok: false, status: 'injection_blocked', title: page.title,
                error: `检测到提示注入：${analysis.injection.summary}`,
                summary: `已隔离，未入库；命中规则 ${analysis.injection.summary}`,
            };
            this.store.addVisit({ ...base, canonical: canonicalUrl(url), title: page.title, status: 'injection_blocked', textLen: page.text.length, links: page.links.length, summary: blocked.summary, error: blocked.error });
            this.store.markFrontier(url, 'skipped');
            this.store.log('warn', `拦截疑似提示注入页面：${analysis.injection.summary}`, url);
            return blocked;
        }
        // 4.0: 评论区优先学习（任何页面只要服务端渲染了评论，就在这里进入评论学习）
        const discussion = extractCommentBlocks(res.text, { limit: 500 });
        if (discussion.comments.length >= 3) {
            return this.learnCommentCorpus({
                comments: discussion.comments,
                totalHint: discussion.totalHint,
                strategy: discussion.strategy,
                title: page.title,
                url,
                target,
                base,
                domain: analysis.domain,
                textLen: page.text.length,
                links: page.links,
                nextDirections: analysis.nextDirections,
            });
        }
        // 导航/登录/列表型页面：记录但不学习
        if (analysis.boilerplate) {
            this.pushLinks(page.links, analysis.domain);
            this.store.addVisit({ ...base, canonical: canonicalUrl(url), title: page.title, domain: analysis.domain, status: 'boilerplate', textLen: page.text.length, links: page.links.length, summary: '导航/列表型页面，未作为语言样本' });
            this.store.markFrontier(url, 'skipped');
            this.lastLinks = page.links.slice(0, MAX_LAST_LINKS);
            this.lastUrl = url;
            this.lastHost = hostOf(url);
            this.lastGroup = target.group || 'other';
            this.lastPlatform = target.platform || '';
            return { ...base, ok: true, status: 'boilerplate', title: page.title, domain: analysis.domain, patterns: 0, knowledge: 0, links: page.links.length, textLen: page.text.length, sampleable: false, summary: '导航/列表型页面，未学习' };
        }
        // 语言经验
        let patterns = [];
        if (analysis.sampleable) {
            patterns = analyzeLanguage({
                text: page.text,
                features: analysis.language.features,
                meta: {
                    url, site: base.site, domain: analysis.domain,
                    register: analysis.language.register,
                },
            });
            for (const p of patterns) this.store.upsertPattern(p);
        }
        // 知识入库（未验证状态，第二次独立来源才升级）
        let verifiedCount = 0;
        for (const k of analysis.knowledge) {
            const r = this.store.addKnowledge(k);
            if (r.verified) verifiedCount += 1;
            // 只有真正的知识点才沉淀成兴趣；标题太长时用领域+前几个字
            if (r.isNew && k.topic && k.topic.length >= 4 && k.topic.length <= 60) {
                this.store.touchInterest({ topic: k.topic, domain: analysis.domain, delta: 0.14 });
            }
        }
        // 链接入库
        this.pushLinks(page.links, analysis.domain);
        const summary = analysis.summary;
        this.store.addVisit({
            ...base,
            canonical: canonicalUrl(url),
            title: page.title,
            domain: analysis.domain,
            lang: page.lang,
            status: 'ok',
            textLen: page.text.length,
            links: page.links.length,
            summary,
            group: target.group || 'other',
            platform: target.platform || '',
        });
        this.store.markFrontier(url, 'done');
        this.lastLinks = page.links.slice(0, MAX_LAST_LINKS);
        this.lastUrl = url;
        this.lastHost = hostOf(url);
        this.lastGroup = target.group || 'other';
        this.lastPlatform = target.platform || '';
        return {
            ...base,
            ok: true,
            domain: analysis.domain,
            title: page.title,
            register: analysis.language.register,
            siteType: analysis.siteType,
            patterns: patterns.length,
            knowledge: analysis.knowledge.length,
            verified: verifiedCount,
            links: page.links.length,
            textLen: page.text.length,
            summary,
            keyPoints: analysis.keyPoints.slice(0, 3),
            languageNotes: patterns.slice(0, 4).map((p) => p.pattern),
            uncertainty: analysis.uncertainty,
            nextDirections: analysis.nextDirections,
            sampleable: analysis.sampleable,
        };
    }

    /** 把一批评论变成语言经验：评论规律 + 趋势词 + 讨论记录 + 访问记录。 */
    async learnCommentCorpus({ comments, totalHint = 0, strategy = 'generic', title, url, target, base, domain, textLen, links = [], nextDirections = [] }) {
        const perPage = this.settings ? this.settings.get('commentsPerPage', 30) : 30;
        const sampled = sampleComments(comments, Math.max(5, Math.min(80, perPage)));
        const cf = commentFeatures(sampled);
        const learnSettings = this.settings ? this.settings.read() : null;
        const cpatterns = patternsFromComments({
            comments: sampled, features: cf, settings: learnSettings,
            meta: { url, site: base.site, domain },
        });
        for (const pat of cpatterns) this.store.upsertPattern(pat);
        const platform = platformById(target.platform)?.name || target.platform || base.site;
        this.store.addDiscussion({
            url, title, platform, domain,
            groupName: target.group || 'forum', totalHint,
            sampled: sampled.length,
            features: { meanLen: cf.meanLen, shortRatio: cf.shortRatio, types: cf.types, diversity: cf.typeDiversity },
        });
        for (const item of trendCandidates(sampled, { minHits: 3, limit: 8 })) {
            this.store.noteTerm(item.term, '趋势候选', platform);
        }
        const joined = sampled.map((c) => c.text).join('\n');
        const extra = extractPatterns({
            features: cf.features, text: joined,
            meta: { url, site: base.site, domain, register: '评论区' },
        }).slice(0, 4);
        for (const pat of extra) this.store.upsertPattern(pat);
        if (links.length) this.pushLinks(links, domain);
        const summary = `评论区采样 ${sampled.length}/${comments.length} 条（${strategy}）：${Object.entries(cf.types).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k}${n}`).join('、')}`;
        this.store.addVisit({
            ...base, canonical: canonicalUrl(url), title, domain, lang: 'zh', status: 'discussion',
            textLen, links: links.length, summary,
            group: target.group || 'forum', platform,
        });
        this.store.markFrontier(url, 'done');
        this.lastLinks = links.slice(0, MAX_LAST_LINKS);
        this.lastUrl = url;
        this.lastHost = hostOf(url);
        this.lastGroup = target.group || 'forum';
        this.lastPlatform = target.platform || '';
        return {
            ...base, ok: true, status: 'discussion', domain, title,
            patterns: cpatterns.length + extra.length, knowledge: 0, links: links.length,
            textLen, sampleable: true, comments: sampled.length, summary,
            languageNotes: cpatterns.slice(0, 3).map((pat) => pat.pattern),
            nextDirections,
        };
    }

    /** B站游客态：随机挑一个视频，取评论 + 弹幕，进入评论学习。 */
    async processBilibili({ base, target, started }) {
        const settings = this.settings ? this.settings.read() : null;
        if (settings && settings.learn && settings.learn.bilibili === false) {
            this.store.markFrontier(base.url, 'skipped');
            return { ...base, ok: true, status: 'thin', title: 'B站学习已关闭', domain: '视频', patterns: 0, comments: 0, links: 0, textLen: 0, summary: '面板里关闭了 B站学习' };
        }
        let videos = this.biliRankingCache;
        if (!Array.isArray(videos) || videos.length === 0 || Date.now() - this.biliRankingAt > 10 * 60_000) {
            try {
                videos = await this.bili.ranking();
            } catch (error) {
                videos = [];
                this.store.log('warn', 'B站排行榜失败：' + String(error && error.message || error));
            }
            if (!videos.length) {
                // 排行榜偶尔被限流：先歇一下再试一次，还不行就用上次存下来的视频池
                await new Promise((r) => setTimeout(r, 2000));
                try {
                    videos = await this.bili.ranking();
                } catch {
                    videos = [];
                }
            }
            if (!videos.length) {
                try {
                    videos = JSON.parse(this.store.getMeta('bili.pool') || '[]');
                } catch {
                    videos = [];
                }
            } else {
                this.store.setMeta('bili.pool', JSON.stringify(videos.slice(0, 200)));
            }
            this.biliRankingCache = videos;
            this.biliRankingAt = Date.now();
        }
        if (!videos.length) {
            this.store.log('warn', 'B站排行榜为空（三个来源都失败）');
            this.store.addVisit({ ...base, canonical: canonicalUrl(base.url), status: 'fail', title: 'B站排行榜', textLen: 0, links: 0, summary: '排行榜为空', group: 'video', platform: 'bilibili' });
            return { ...base, ok: false, status: 'fail', title: 'B站排行榜', domain: '视频', patterns: 0, comments: 0, links: 0, textLen: 0, error: '排行榜为空' };
        }
        // 随机视频；优先评论/弹幕多的，但不只看头部
        const pool = videos.filter((v) => v.replies + v.danmaku > 50);
        const picked = pool.length ? pool[Math.floor(Math.random() * pool.length)] : videos[Math.floor(Math.random() * videos.length)];
        let bundle;
        try {
            bundle = await this.bili.learnBundle(picked, { danmakuLimit: settings?.learn?.danmaku === false ? 0 : 120 });
        } catch (error) {
            this.store.addVisit({ ...base, canonical: canonicalUrl(base.url), status: 'fail', title: picked.title, textLen: 0, links: 0, summary: String(error?.message || error), group: 'video', platform: 'bilibili' });
            this.store.markFrontier(base.url, 'skipped');
            return { ...base, ok: false, status: 'fail', title: picked.title, domain: '视频', patterns: 0, comments: 0, links: 0, textLen: 0, error: String(error?.message || error) };
        }
        if (bundle.all.length < 5) {
            this.store.markFrontier(base.url, 'skipped');
            return { ...base, ok: true, status: 'thin', title: bundle.title, domain: '视频', patterns: 0, comments: bundle.all.length, links: 0, textLen: 0, summary: '评论与弹幕太少' };
        }
        const result = await this.learnCommentCorpus({
            comments: bundle.all,
            totalHint: picked.replies + picked.danmaku,
            strategy: 'bilibili-guest',
            title: bundle.title,
            url: base.url,
            target: { ...target, group: 'video', platform: 'bilibili' },
            base,
            domain: '视频',
            textLen: bundle.all.reduce((n, c) => n + c.text.length, 0),
            nextDirections: [],
        });
        return { ...result, video: { aid: bundle.aid, bvid: bundle.bvid, title: bundle.title }, danmaku: bundle.danmaku.length };
    }

    /** GitHub 公开议题：搜索 → 取评论 → 进入评论学习。 */
    async processGithub({ res, base, channel, signal, started, target }) {
        let json;
        try {
            json = JSON.parse(res.text);
        } catch {
            return { ...base, ok: false, status: 'fail', error: 'GitHub JSON 解析失败' };
        }
        const issues = Array.isArray(json?.items) ? json.items.filter((i) => Number(i.comments) > 0).slice(0, 2) : [];
        if (!issues.length) {
            this.store.addVisit({ ...base, canonical: canonicalUrl(base.url), status: 'thin', title: 'GitHub 检索', textLen: 0, links: 0, summary: '没有带评论的议题', group: 'forum', platform: 'github-cn' });
            this.store.markFrontier(base.url, 'skipped');
            return { ...base, ok: true, status: 'thin', title: 'GitHub 检索', domain: '编程', patterns: 0, knowledge: 0, links: 0, textLen: 0, summary: '没有带评论的议题' };
        }
        const collected = [];
        for (const issue of issues) {
            try {
                const cres = await this.fetcher.get(issue.comments_url + '?per_page=50', { signal, purpose: 'comments' });
                if (!cres.ok) continue;
                const list = JSON.parse(cres.text);
                for (const c of Array.isArray(list) ? list : []) {
                    if (typeof c?.body === 'string' && c.body.trim()) collected.push({ text: oneLine(c.body.replace(/`{3}[sS]*?`{3}/gu, ' ')).slice(0, 600), pos: collected.length });
                }
            } catch {
                /* 单个议题失败不影响整体 */
            }
        }
        if (collected.length < 3) {
            this.store.markFrontier(base.url, 'skipped');
            return { ...base, ok: true, status: 'thin', title: issues[0]?.title || 'GitHub', domain: '编程', patterns: 0, knowledge: 0, links: 0, textLen: 0, summary: '评论不足' };
        }
        return this.learnCommentCorpus({
            comments: collected,
            totalHint: collected.length,
            strategy: 'github-api',
            title: issues[0]?.title || 'GitHub 议题',
            url: base.url,
            target: { ...target, group: 'forum', platform: 'github-cn' },
            base,
            domain: '编程',
            textLen: collected.join('').length,
        });
    }

    async processDiscussion({ res, base, channel, signal, started }) {
        let json;
        try {
            json = JSON.parse(res.text);
        } catch {
            this.store.addVisit({ ...base, canonical: canonicalUrl(base.url), status: 'fail', error: '讨论 JSON 解析失败', textLen: res.text.length, links: 0 });
            this.store.markFrontier(base.url, 'failed');
            return { ...base, ok: false, status: 'fail', error: '讨论 JSON 解析失败' };
        }
        const items = parseHnDiscussion(json);
        const body = items.filter((i) => !i.title).map((i) => i.text).join('\n');
        const patterns = body.length >= 300 ? analyzeLanguage({
            text: body,
            features: extractFeatures(body),
            meta: { url: base.url, site: 'news.ycombinator.com', domain: '社会文化', register: '网络社交' },
        }) : [];
        for (const p of patterns) this.store.upsertPattern(p);
        const title = items.find((i) => i.title)?.text || '讨论区';
        this.store.addDiscussion({
            url: base.url, title, platform: 'Hacker News', domain: '社会文化', groupName: 'forum',
            totalHint: items.length, sampled: items.length,
            features: { meanLen: 0, shortRatio: 0, types: {}, diversity: 0 },
        });
        this.store.addVisit({ ...base, canonical: canonicalUrl(base.url), title: truncate(title, 160), domain: '社会文化', status: 'discussion', textLen: body.length, links: 0, summary: `讨论区 ${items.length} 条发言：${truncate(body, 120)}`, group: 'forum', platform: 'Hacker News' });
        this.store.markFrontier(base.url, 'done');
        return { ...base, ok: true, status: 'discussion', title, domain: '社会文化', patterns: patterns.length, knowledge: 0, links: 0, textLen: body.length, sampleable: body.length >= 300, languageNotes: patterns.slice(0, 4).map((p) => p.pattern) };
    }

    pushLinks(links, domain) {
        const recentHosts = new Set(this.store.recentVisits(8).map((v) => hostOf(v.url)));
        const items = links
            .filter((l) => l.anchor && l.anchor.length >= 4 && l.anchor.length <= 80)
            .filter((l) => !isJunkLink(l.url))
            .filter((l) => !this.tooRecent(l.url))
            .slice(0, 12)
            .map((l) => ({
                url: l.url,
                host: hostOf(l.url),
                domain: classifyDomain(`${l.anchor} ${domain}`, domain || '未分类'),
                priority: recentHosts.has(hostOf(l.url)) ? 0.9 : 1.15,
                source: `link:${hostOf(this.lastUrl || '')}`,
                group: this.lastGroup || 'other',
                platform: this.lastPlatform || '',
            }));
        if (items.length) this.store.pushFrontierBatch(items);
        return items.length;
    }

    // ---------------- 日记 ----------------

    buildDiary({ cycleId, results, stoppedReason }) {
        const ok = results.filter((r) => r.ok);
        const domains = {};
        for (const r of results) domains[r.domain || '未分类'] = (domains[r.domain || '未分类'] || 0) + 1;
        const domainList = Object.entries(domains).sort((a, b) => b[1] - a[1]);
        const lines = [];
        lines.push(`### 探索日记 ${new Date().toLocaleString('zh-CN', { hour12: false })}（${cycleId}）`);
        lines.push(`本次 ${results.length} 页，成功 ${ok.length} 页，${domainList.length} 个领域：${domainList.map(([d, n]) => `${d} ${n}`).join('、') || '无'}。${stoppedReason !== 'done' ? `（提前结束：${stoppedReason}）` : ''}`);
        const know = ok.flatMap((r) => (r.knowledge ? [`${r.title || r.url}：${r.summary || ''}`] : [])).slice(0, 3);
        if (know.length) {
            lines.push('读到的东西：');
            for (const k of know) lines.push(`· ${truncate(k, 140)}`);
        }
        const patterns = ok.flatMap((r) => r.languageNotes || []).slice(0, 3);
        if (patterns.length) {
            lines.push('语言观察：');
            for (const p of patterns) lines.push(`· ${truncate(p, 140)}`);
        }
        const next = ok.flatMap((r) => (r.nextDirections || []).map((d) => d.anchor)).filter(Boolean).slice(0, 3);
        if (next.length) {
            lines.push('想继续看：');
            for (const n of next) lines.push(`· ${truncate(n, 80)}`);
        }
        const doubt = ok.flatMap((r) => (r.uncertainty || []).map((u) => u.claim)).slice(0, 2);
        if (doubt.length) {
            lines.push('存疑：');
            for (const d of doubt) lines.push(`· ${truncate(d, 120)}`);
        }
        const newDomain = domainList.filter(([d]) => !(this.domainCache?.has(d))).map(([d]) => d);
        if (newDomain.length) lines.push(`新领域：${newDomain.join('、')}`);
        if (results.length === 0) lines.push('这轮没抓到页面，队列和网络状态需要检查。');
        return { text: lines.join('\n'), domains: domainList.map(([d, n]) => ({ domain: d, n })) };
    }
}

function summarizeResult(r) {
    return {
        url: r.url, title: r.title, domain: r.domain, status: r.status, ok: r.ok,
        patterns: r.patterns, knowledge: r.knowledge, ms: r.ms,
    };
}

export { CHANNELS };

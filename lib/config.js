/**
 * HLES 3.0 配置：默认值 + 归一化 + 校验。
 *
 * 插件行里的 config 是用户可改的；这里对每个字段做类型收敛，未知字段忽略，
 * 越界值夹到安全区间，避免一个手写配置把长期运行的任务拖死（例如 0 间隔抓取）。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function num(value, fallback, min, max) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function bool(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
}

function str(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** 默认数据目录：$DSH_HOME/hles（沙箱内可写，重启后仍在）。 */
export function defaultDataDir() {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    return join(home, 'hles');
}

export const DEFAULT_CONFIG = Object.freeze({
    dataDir: '',
    explore: {
        enabled: true,
        pagesPerCycle: 5,
        maxPagesPerCycle: 20,
        minHostIntervalMs: 2500,
        pageGapMs: 1200,
        timeoutMs: 20000,
        maxBytes: 1_572_864,
        channelMix: { random: 0.5, extension: 0.3, interest: 0.2 },
        maxVisitsPerDay: 400,
        revisitCooldownDays: 3,
        followSameHost: true,
    },
    safety: {
        respectRobots: true,
        userAgent: 'DSH-HLES/3.0 (local autonomous reading agent; text-only)',
        maxRedirects: 4,
        allowPrivateHosts: false,
    },
    sources: {
        disabled: [],
        extraFeeds: [],
    },
    inject: {
        enabled: true,
        maxChars: 600,
        maxPatterns: 6,
        maxPrefs: 3,
        minConfidence: 0.45,
        minHits: 2,
        defaultLang: 'zh',
        ttlSeconds: 600,
    },
    learn: {
        feedback: true,
        evaluateTurns: true,
        keepSamples: true,
        maxSampleChars: 160,
    },
    schedule: {
        enabled: true,
        intervalMinutes: 360,
    },
    db: {
        maxVisits: 5000,
        maxFrontier: 2000,
        maxLogs: 2000,
    },
    memory: {
        maxHeapMB: 260,
    },
});

/** 深合并 + 逐字段收敛。返回全新对象，不修改入参。 */
export function normalizeConfig(raw) {
    const input = isObj(raw) ? raw : {};
    const base = DEFAULT_CONFIG;
    const cfg = {
        dataDir: str(input.dataDir, defaultDataDir()),
        explore: {
            enabled: bool(input.explore?.enabled, base.explore.enabled),
            pagesPerCycle: Math.round(num(input.explore?.pagesPerCycle, base.explore.pagesPerCycle, 1, 40)),
            maxPagesPerCycle: Math.round(num(input.explore?.maxPagesPerCycle, base.explore.maxPagesPerCycle, 1, 200)),
            minHostIntervalMs: Math.round(num(input.explore?.minHostIntervalMs, base.explore.minHostIntervalMs, 800, 60_000)),
            pageGapMs: Math.round(num(input.explore?.pageGapMs, base.explore.pageGapMs, 200, 120_000)),
            timeoutMs: Math.round(num(input.explore?.timeoutMs, base.explore.timeoutMs, 3000, 90_000)),
            maxBytes: Math.round(num(input.explore?.maxBytes, base.explore.maxBytes, 64 * 1024, 8 * 1024 * 1024)),
            channelMix: normalizeMix(input.explore?.channelMix),
            maxVisitsPerDay: Math.round(num(input.explore?.maxVisitsPerDay, base.explore.maxVisitsPerDay, 1, 5000)),
            revisitCooldownDays: num(input.explore?.revisitCooldownDays, base.explore.revisitCooldownDays, 0, 90),
            followSameHost: bool(input.explore?.followSameHost, base.explore.followSameHost),
        },
        safety: {
            respectRobots: bool(input.safety?.respectRobots, base.safety.respectRobots),
            userAgent: str(input.safety?.userAgent, base.safety.userAgent),
            maxRedirects: Math.round(num(input.safety?.maxRedirects, base.safety.maxRedirects, 0, 10)),
            allowPrivateHosts: bool(input.safety?.allowPrivateHosts, base.safety.allowPrivateHosts),
        },
        sources: {
            disabled: Array.isArray(input.sources?.disabled)
                ? input.sources.disabled.filter((x) => typeof x === 'string')
                : [],
            extraFeeds: Array.isArray(input.sources?.extraFeeds)
                ? input.sources.extraFeeds
                    .filter(isObj)
                    .filter((f) => typeof f.url === 'string' && /^https?:\/\//i.test(f.url))
                    .map((f) => ({
                        id: str(f.id, `extra:${new URL(f.url).hostname}`),
                        url: f.url,
                        domain: str(f.domain, '未分类'),
                        lang: f.lang === 'en' ? 'en' : 'zh',
                        kind: f.kind === 'html' ? 'html' : 'rss',
                    }))
                : [],
        },
        inject: {
            enabled: bool(input.inject?.enabled, base.inject.enabled),
            maxChars: Math.round(num(input.inject?.maxChars, base.inject.maxChars, 120, 4000)),
            maxPatterns: Math.round(num(input.inject?.maxPatterns, base.inject.maxPatterns, 1, 20)),
            maxPrefs: Math.round(num(input.inject?.maxPrefs, base.inject.maxPrefs, 0, 10)),
            minConfidence: num(input.inject?.minConfidence, base.inject.minConfidence, 0, 1),
            minHits: Math.round(num(input.inject?.minHits, base.inject.minHits, 1, 20)),
            defaultLang: input.inject?.defaultLang === 'en' ? 'en' : 'zh',
            ttlSeconds: Math.round(num(input.inject?.ttlSeconds, base.inject.ttlSeconds, 30, 86_400)),
        },
        learn: {
            feedback: bool(input.learn?.feedback, base.learn.feedback),
            evaluateTurns: bool(input.learn?.evaluateTurns, base.learn.evaluateTurns),
            keepSamples: bool(input.learn?.keepSamples, base.learn.keepSamples),
            maxSampleChars: Math.round(num(input.learn?.maxSampleChars, base.learn.maxSampleChars, 40, 2000)),
        },
        schedule: {
            enabled: bool(input.schedule?.enabled, base.schedule.enabled),
            intervalMinutes: Math.round(num(input.schedule?.intervalMinutes, base.schedule.intervalMinutes, 5, 1440)),
        },
        db: {
            maxVisits: Math.round(num(input.db?.maxVisits, base.db.maxVisits, 200, 100_000)),
            maxFrontier: Math.round(num(input.db?.maxFrontier, base.db.maxFrontier, 100, 50_000)),
            maxLogs: Math.round(num(input.db?.maxLogs, base.db.maxLogs, 100, 20_000)),
        },
        memory: {
            maxHeapMB: Math.round(num(input.memory?.maxHeapMB, base.memory.maxHeapMB, 80, 4096)),
        },
    };
    if (cfg.explore.pagesPerCycle > cfg.explore.maxPagesPerCycle) {
        cfg.explore.pagesPerCycle = cfg.explore.maxPagesPerCycle;
    }
    return cfg;
}

function normalizeMix(mix) {
    const d = DEFAULT_CONFIG.explore.channelMix;
    const parsed = isObj(mix) ? mix : {};
    let random = num(parsed.random, d.random, 0, 1);
    let extension = num(parsed.extension, d.extension, 0, 1);
    let interest = num(parsed.interest, d.interest, 0, 1);
    const sum = random + extension + interest;
    if (sum <= 0) return { ...d };
    random /= sum;
    extension /= sum;
    interest /= sum;
    return { random, extension, interest };
}

/**
 * 运行期设置（4.0）：存在 SQLite meta 表里，侧边栏面板可改，探索器即时读取。
 * 与 cordis 安装行 config 的关系：安装行给默认值，这里保存用户覆盖值。
 */

export const SETTING_DEFAULTS = {
    // 探索
    chinesePriority: true,
    mix: { video: 45, forum: 30, blog: 15, other: 10 },
    pagesPerCycle: 6,
    commentsPerPage: 30,
    intervalMinutes: 360,
    revisitCooldownDays: 3,
    // 语言学习开关
    learn: {
        colloquial: true,
        internet: true,
        humor: true,
        emotion: true,
        dialogue: true,
        narrative: true,
        antiAi: true,
        bilibili: true,
        danmaku: true,
    },
    studyMinutes: 10,
    baseUnrestricted: true,
    // 学习时的平台占比（0 = 这次不学这个平台；不需要凑满 100，按权重分配）
    platformWeights: { bilibili: 30, 'douban-group': 25, 'github-cn': 20, hupu: 15, douban: 10 },
    // 注入
    inject: {
        global: true,
        maxChars: 700,
        minHits: 2,
        order: 9500,
    },
    // 调度
    schedule: { enabled: true, intervalMinutes: 360 },
};

const KEY = 'settings4';

function merge(base, patch) {
    if (!patch || typeof patch !== 'object') return base;
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
            out[k] = merge(base[k], v);
        } else if (v !== undefined) {
            out[k] = v;
        }
    }
    return out;
}

export class Settings {
    constructor(store) {
        this.store = store;
        this.cache = null;
    }

    read() {
        if (this.cache) return this.cache;
        let saved = {};
        try {
            saved = JSON.parse(this.store.getMeta(KEY) || '{}');
        } catch {
            saved = {};
        }
        this.cache = merge(SETTING_DEFAULTS, saved);
        return this.cache;
    }

    write(patch) {
        const next = merge(this.read(), patch);
        this.store.setMeta(KEY, JSON.stringify(next));
        this.cache = next;
        return next;
    }

    get(path, fallback) {
        const parts = String(path).split('.');
        let cur = this.read();
        for (const p of parts) {
            if (cur == null || typeof cur !== 'object') return fallback;
            cur = cur[p];
        }
        return cur === undefined ? fallback : cur;
    }

    /** 归一化内容配比（总和 100，缺省补到 other）。 */
    mix() {
        const raw = this.read().mix || SETTING_DEFAULTS.mix;
        const out = { video: 0, forum: 0, blog: 0, other: 0 };
        let total = 0;
        for (const k of Object.keys(out)) {
            const v = Number(raw[k]);
            out[k] = Number.isFinite(v) && v >= 0 ? v : 0;
            total += out[k];
        }
        if (total <= 0) return { ...SETTING_DEFAULTS.mix };
        for (const k of Object.keys(out)) out[k] = Math.round((out[k] / total) * 1000) / 10;
        return out;
    }
}

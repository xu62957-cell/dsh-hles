/**
 * 经验注入：把长期积累的语言经验做成一小段运行时上下文，参与每次回答生成。
 *
 * 约束：
 *   - 只注入"相对基线显著的倾向"，不注入词表；
 *   - 总量默认 600 字，随经验变化每 10 分钟最多重建一次，避免打断提示缓存；
 *   - 明确写出"这些是倾向不是模板"，防止把经验变成新的八股；
 *   - 用户偏好单独成段，且只对明确说过它的会话生效（除非标记为全局）。
 */

import { truncate } from './util.js';

const KIND_LABEL = {
    rhythm: '节奏',
    particle: '口头语',
    connective: '转折',
    hedge: '限定',
    dialogue: '对话',
    emotion: '情绪',
    slang: '社群用语',
    forum: '互动',
    rhetoric: '反问',
    address: '称呼',
    punctuation: '标点',
    explain: '讲解',
    register: '文体',
    opening: '开场',
};

const HEADER = '【HLES 语言经验｜从真实网页文本归纳的倾向，不是规则】';
const FOOTER = '用法：这些只说明"人通常怎么说"，与当前语境冲突时以语境为准，不要逐字套用。';

export class ExperienceInjector {
    constructor({ store, config, getSessionHint, settings = null, agents = null }) {
        this.store = store;
        this.config = config;
        this.getSessionHint = getSessionHint;
        this.settings = settings;
        this.agents = agents;
        this.cache = { key: '', text: '', at: 0 };
    }

    /** 4.0：用户设置优先于安装行配置。 */
    effective() {
        const s = this.settings ? this.settings.read().inject : {};
        return {
            enabled: s.global !== false && this.config.inject.enabled,
            maxChars: Number(s.maxChars) || this.config.inject.maxChars,
            maxPatterns: this.config.inject.maxPatterns,
            maxPrefs: this.config.inject.maxPrefs,
            minConfidence: this.config.inject.minConfidence,
            minHits: Number(s.minHits) || this.config.inject.minHits || 2,
            defaultLang: this.config.inject.defaultLang || 'zh',
            ttlSeconds: this.config.inject.ttlSeconds,
        };
    }

    /** 生成注入文本；经验不足时返回空串（不注入）。 */
    build({ sessionId = '', lang = '', force = false } = {}) {
        const cfg = this.effective();
        if (!cfg.enabled) return '';
        // 会话级开关：面板里单独关掉某个 Agent 时这里直接返回空
        if (sessionId && this.agents && !this.agents.enabledFor(sessionId)) return '';
        // 只注入与会话语言一致的规律；会话语言未知时用配置的默认语言（默认 zh）
        const desired = lang || cfg.defaultLang || 'zh';
        const candidate = this.store.topPatterns({ limit: cfg.maxPatterns * 6, minConfidence: cfg.minConfidence, minHits: cfg.minHits ?? 1 })
            .filter((p) => p.lang === desired);
        // 4.0：按经验分类分散取样，避免整段都来自同一类
        const patterns = [];
        const perCategory = {};
        for (const p of candidate) {
            const cat = p.category || '通用';
            if ((perCategory[cat] || 0) >= 2) continue;
            perCategory[cat] = (perCategory[cat] || 0) + 1;
            patterns.push(p);
            if (patterns.length >= cfg.maxPatterns) break;
        }
        const prefs = this.store.activePrefs({ sessionId, limit: cfg.maxPrefs });
        if (patterns.length === 0 && prefs.length === 0) return '';
        const maxSeen = Math.max(0, ...patterns.map((p) => p.lastSeen));
        const maxPref = Math.max(0, ...prefs.map((p) => p.at));
        const key = `${patterns.length}:${maxSeen}:${prefs.length}:${maxPref}:${sessionId}:${lang}:${this.config.inject.defaultLang}`;
        if (!force && this.cache.key === key && Date.now() - this.cache.at < cfg.ttlSeconds * 1000) {
            return this.cache.text;
        }
        const lines = [];
        let withExample = 0;
        for (const p of patterns) {
            const label = p.category || KIND_LABEL[p.kind] || p.kind;
            const example = p.example && withExample < 2 ? `（例：${truncate(p.example, 36)}）` : '';
            if (p.example) withExample += 1;
            lines.push(`· [${label}] ${truncate(p.pattern, 110)}${example}`);
        }
        if (prefs.length) {
            lines.push('【用户明确表达过的偏好】');
            for (const pref of prefs) {
                const verb = pref.kind === 'like' ? '可以多用' : pref.kind === 'preference' ? '希望' : '避免';
                const times = pref.hits > 1 ? `（明确说过 ${pref.hits} 次）` : '';
                lines.push(`· ${verb}：${truncate(pref.subject, 80)}${times}`);
            }
        }
        let body = [HEADER, ...lines, FOOTER].join('\n');
        if (body.length > cfg.maxChars) {
            // 从尾部丢条目，保留头尾原则
            const kept = [];
            let len = HEADER.length + FOOTER.length + 2;
            for (const line of lines) {
                if (len + line.length + 1 > cfg.maxChars) break;
                kept.push(line);
                len += line.length + 1;
            }
            body = [HEADER, ...kept, FOOTER].join('\n');
        }
        this.cache = { key, text: body, at: Date.now() };
        return body;
    }

    preview({ sessionId = '', lang = '' } = {}) {
        const cfg = this.effective();
        const text = this.build({ sessionId, lang, force: true });
        return {
            text,
            chars: text.length,
            patterns: this.store.topPatterns({ limit: this.config.inject.maxPatterns, minConfidence: cfg.minConfidence, minHits: cfg.minHits ?? 1 }).length,
            prefs: this.store.activePrefs({ sessionId, limit: cfg.maxPrefs }).length,
            enabled: cfg.enabled,
            global: this.agents ? this.agents.globalEnabled() : true,
        };
    }

    /** 注册到 systemPrompt 的运行时上下文；没有经验时返回空串，被宿主自动过滤。 */
    register(systemPrompt) {
        return systemPrompt.context({
            name: 'hles:language-experience',
            // 放在运行时上下文的末尾：所有内置策略之后，仍然是附加而非覆盖
            order: 9500,
            text: () => {
                try {
                    const hint = this.getSessionHint ? this.getSessionHint() : {};
                    return this.build({ sessionId: hint?.sessionId || '', lang: hint?.lang || '' });
                } catch {
                    return '';
                }
            },
        });
    }
}

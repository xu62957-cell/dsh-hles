/**
 * 作业与评价（老师 = 用户）。
 *
 * 流程：一次学习结束 → 用当轮学到的经验写一篇中文文章（主题自拟）→ 用户打分/提建议
 *      → 系统接受评价并写自我反思与复习计划 → 这一轮才算学完。
 *
 * 用 DSH 的 llm 服务调用默认模型；模型不可用时把记录标成 failed，面板会显示原因。
 */

import { dedupeModelText } from './util.js';

const SYSTEM_WRITE = [
    '你是 HLES 语言学习系统的“学生”。现在要交一篇作业：一篇独立的文章，主题自拟。',
    '这考的是你学习以来积累的整体语言能力，不是只考最近这一轮。',
    '题材要求：写别的东西——一件事、一个观察、一个看法、一段经历都行；不要写“我在学习语言”“我学到了什么”“这次学习的内容”这类题材，也不要在文章里总结你的学习方法。',
    '要求：中文；语气自然，像一个普通人写字；不要小标题、不要“总而言之”式总结、不要分点罗列。',
    '网络梗、流行语、口语说法，本身都有具体含义，合适的地方用是正常的说话方式，不用刻意回避；只是不要为了显得“接地气”而堆，堆起来就假了。',
    '篇幅 600–900 字。第一行写“标题：xxx”，空一行后写正文。',
].join('');

const SYSTEM_REVIEW = '你是 HLES 语言学习系统的“学生”。老师刚给你的作业打了分、提了意见（可能没有意见）。现在写你的自我反思：先用两三句话复述老师的意思；再具体说哪几处要改、怎么改；最后写下一轮练习的具体做法。要求：中文；别写客套话和口号；不要用“首先/其次/最后”这种模板；不要照抄老师的原话。控制在 300–500 字。';

function oneLine(text) {
    return String(text ?? '').replace(/\s+/gu, ' ').trim();
}

export class HomeworkService {
    constructor({ store, llm = null, modelSelection = null, settings = null, logger = null, baseLoader = null }) {
        this.store = store;
        this.llm = llm;
        this.modelSelection = modelSelection;
        this.settings = settings;
        this.logger = logger;
        this.baseLoader = baseLoader;
    }

    async ensureBase() {
        const enabled = !this.settings || this.settings.get('baseUnrestricted', true) !== false;
        if (!enabled) { this.baseText = ''; return ''; }
        if (this.baseText === undefined && this.baseLoader) {
            try { this.baseText = String((await this.baseLoader()) || ''); } catch { this.baseText = ''; }
        }
        return this.baseText || '';
    }

    get baseActive() {
        return Boolean(this.baseText);
    }

    get available() {
        try {
            return Boolean(this.llm && this.modelSelection && this.modelSelection.currentSelection?.());
        } catch {
            return false;
        }
    }

    #selection() {
        const selection = this.modelSelection?.currentSelection?.();
        if (!selection?.provider || !selection?.model) throw new Error('没有可用的默认模型');
        return selection;
    }

    async #callModel(system, user, { maxTokens = 4000 } = {}) {
        if (!this.llm) throw new Error('llm 服务不可用');
        const enabled = !this.settings || this.settings.get('baseUnrestricted', true) !== false;
        if (enabled && this.baseLoader && this.baseText === undefined) {
            try {
                this.baseText = String((await this.baseLoader()) || '');
            } catch {
                this.baseText = '';
            }
        }
        const base = enabled ? this.baseText || '' : '';
        const fullSystem = base ? `${base}\n\n${system}` : system;
        // 第一次没出文本时把预算翻倍再试一次：推理型模型有时把预算全用在 reasoning 上
        let lastError = '';
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const out = await this.#streamOnce(fullSystem, user, Math.min(8000, maxTokens * (attempt + 1)));
                if (out.trim()) return out.trim();
                lastError = '模型返回了空内容';
            } catch (error) {
                lastError = String(error?.message || error);
            }
        }
        throw new Error(lastError || '模型调用失败');
    }

    async #streamOnce(system, user, maxTokens) {
        const selection = this.#selection();
        let text = '';
        let failure = null;
        const stream = this.llm.stream({
            provider: selection.provider,
            model: selection.model,
            system,
            messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
            maxTokens,
        });
        const parts = new Map();
        const types = [];
        let seen = 0;
        for await (const chunk of stream) {
            if (chunk?.type === 'text-delta') {
                const index = Number(chunk.index) || 0;
                parts.set(index, (parts.get(index) || '') + (chunk.text || ''));
            } else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') {
                const index = Number(chunk.index) || 0;
                // 有的适配器只给 block-end（不流式），有的既给 delta 又给整块，只取其一
                if (!parts.get(index)) parts.set(index, chunk.block.text || '');
            } else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
                failure = chunk.reason.failure?.message || '模型调用失败';
            }
            if (types.length < 10) types.push(String(chunk?.type || '?') + (chunk?.block?.type ? ':' + chunk.block.type : ''));
            seen += 1;
        }
        text = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).join('');
        if (!text.trim()) this.store.log('warn', '作业模型没有输出文本', 'chunks=' + seen + ' types=' + types.join(','));
        if (failure) throw new Error(failure);
        return text;
    }

    #writePrompt(study) {
        const all = this.store.allPatterns(400) || [];
        // 长期经验：按分类分层取，兼顾各类表达，不只挑这一轮的新规律
        const byCategory = new Map();
        for (const p of all) {
            const key = p.category || '日常叙述';
            if (!byCategory.has(key)) byCategory.set(key, []);
            byCategory.get(key).push(p);
        }
        const backfill = [];
        for (const [category, list] of byCategory) {
            const take = list.sort((a, b) => (Number(b.hits) || 0) - (Number(a.hits) || 0)).slice(0, 3);
            for (const p of take) backfill.push({ ...p, category });
        }
        const longTerm = backfill.slice(0, 24);
        // 本轮新增：最近的 6 条，单独标注为“最新输入”
        const recent = all
            .slice()
            .sort((a, b) => (Number(b.firstSeen) || Number(b.createdAt) || 0) - (Number(a.firstSeen) || Number(a.createdAt) || 0))
            .slice(0, 6);
        const recentIds = new Set(recent.map((p) => p.pattern));
        const lines = [];
        lines.push(`到目前为止积累的表达经验：${all.length} 条，分布在 ${byCategory.size} 个分类里。以下是你已经形成的语言习惯（写文章时自然带着，不要在文章里讨论它们）：`);
        for (const p of longTerm) {
            lines.push(`- [${p.category}] ${oneLine(p.pattern).slice(0, 110)}${p.example ? `（例：${oneLine(p.example).slice(0, 36)}）` : ''}`);
        }
        if (!longTerm.length) lines.push('- （经验还不多，按你自然的方式写）');
        lines.push('');
        if (recent.length) {
            lines.push('最近这一轮新接触到的（只作为最新输入，不要只围着它们写）：');
            for (const p of recent) {
                if (recentIds.has(p.pattern)) lines.push(`- [${p.category || '日常叙述'}] ${oneLine(p.pattern).slice(0, 100)}`);
            }
            lines.push('');
        }
        const platforms = study?.byPlatform || {};
        const share = Object.entries(platforms).map(([k, v]) => `${k} ${v.pages || 0} 页`).join('、');
        if (share) lines.push(`本轮学习分布：${share}`);
        lines.push('');
        lines.push('请把它当成一次整体能力检验来写：用你积累的习惯，写一篇和“学习语言”无关的文章，写你真正有观察的东西。');
        return lines.join('\n');
    }

    #reviewPrompt(homework) {
        const lines = [];
        lines.push(`老师的打分：${homework.score ?? '未给分'}`);
        lines.push(`老师的建议：${homework.suggestion ? homework.suggestion : '（这次没有提建议）'}`);
        lines.push('');
        lines.push('我的作业：');
        lines.push(homework.content || '');
        lines.push('');
        lines.push('请按系统提示的要求写自我反思。');
        return lines.join('\n');
    }

    async generate(study = null) {
        const platforms = study?.byPlatform || {};
        const id = this.store.addHomework({
            studyId: String(study?.startedAt || Date.now()),
            status: 'writing',
            platforms,
        });
        try {
            const raw = await this.#callModel(SYSTEM_WRITE, this.#writePrompt(study));
            const text = dedupeModelText(raw);
            const lines = text.split('\n');
            let topic = '';
            let body = text;
            if (/^标题[:：]\s*/u.test(lines[0] || '')) {
                topic = oneLine(lines[0].replace(/^标题[:：]\s*/u, '')).slice(0, 60);
                body = lines.slice(1).join('\n').trim();
            } else {
                topic = oneLine(lines[0] || '').slice(0, 40) || '一次学习之后的作业';
            }
            this.store.updateHomework(id, { topic, content: body, status: 'pending_review' });
            this.store.log('info', `作业已写好：${topic}`);
            return this.store.getHomework(id);
        } catch (error) {
            const message = String(error?.message || error);
            this.store.updateHomework(id, { status: 'failed', error: message });
            this.store.log('warn', `作业生成失败：${message}`);
            return this.store.getHomework(id);
        }
    }

    async review(id, { score = null, suggestion = '' } = {}) {
        const homework = this.store.getHomework(id);
        if (!homework) throw new Error('作业不存在');
        if (!homework.content) throw new Error('这篇作业还没有内容');
        const value = score === null || score === undefined || score === '' ? null : Math.max(0, Math.min(100, Number(score)));
        this.store.updateHomework(id, { status: 'reviewing', score: value, suggestion: String(suggestion || '').trim() });
        try {
            const text = dedupeModelText(await this.#callModel(SYSTEM_REVIEW, this.#reviewPrompt({ ...homework, score: value, suggestion }), { maxTokens: 1200 }));
            this.store.updateHomework(id, { status: 'done', self_review: text, reviewed_at: Date.now() });
            this.store.log('info', `作业评价已接受：${homework.topic}`);
            return this.store.getHomework(id);
        } catch (error) {
            const message = String(error?.message || error);
            this.store.updateHomework(id, { status: 'failed', error: message });
            this.store.log('warn', `自我反思生成失败：${message}`);
            return this.store.getHomework(id);
        }
    }

    latest() {
        return this.store.latestHomework();
    }

    list(limit = 10) {
        return this.store.listHomework(limit);
    }
}

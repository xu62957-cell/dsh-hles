/**
 * 对话测试（作业之后的第二阶段）。
 *
 * 流程：老师给一句假设对话/场景 → 学生用积累的说话习惯回一句 → 老师打分/提建议
 *      → 学生写自我反思 → 这一轮才算真正结束。
 *
 * 用 DSH 的 llm 服务调默认模型；模型不可用时记录失败原因，面板可重试。
 */

import { dedupeModelText } from './util.js';

const SYSTEM_DIALOGUE = [
    '你是 HLES 语言学习系统的“学生”，现在在和老师做对话测试。',
    '老师给你一句话或一个场景，你直接用积累的说话习惯回话。',
    '要求：像真人聊天；句子可长可短，该短就短；网络梗、流行语本身都有具体含义，合适的地方用，不要为了显得网感硬凹，也不要刻意避开；不要客套模板、不要解释你用了什么技巧、不要总结、不要自称 AI。',
    '一般 1–3 句，场景需要时可以多说几句。只输出你要说的那段话，不要加“回答：”之类的前缀。',
].join('');

const SYSTEM_REVIEW = [
    '你是 HLES 语言学习系统的“学生”。老师刚给你的对话回复打了分、提了意见（可能没有意见）。',
    '写你的自我反思：先复述老师的意思；再说具体哪句话、哪个词要改，改成什么样；最后写下次遇到类似场景怎么说。',
    '要求：中文、口语、别写客套话和口号、别用“首先/其次/最后”，200–400 字。',
].join('');

export class DialogueService {
    constructor({ store, llm = null, modelSelection = null, settings = null, baseLoader = null }) {
        this.store = store;
        this.llm = llm;
        this.modelSelection = modelSelection;
        this.settings = settings;
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

    async #streamOnce(system, user, maxTokens) {
        const selection = this.#selection();
        let text = '';
        let failure = null;
        const parts = new Map();
        const stream = this.llm.stream({
            provider: selection.provider,
            model: selection.model,
            system,
            messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
            maxTokens,
        });
        for await (const chunk of stream) {
            if (chunk?.type === 'text-delta') {
                const index = Number(chunk.index) || 0;
                parts.set(index, (parts.get(index) || '') + (chunk.text || ''));
            } else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') {
                const index = Number(chunk.index) || 0;
                if (!parts.get(index)) parts.set(index, chunk.block.text || '');
            } else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
                failure = chunk.reason.failure?.message || '模型调用失败';
            }
        }
        if (failure) throw new Error(failure);
        text = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).join('');
        return text;
    }

    async #call(system, user, { maxTokens = 1500 } = {}) {
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
        let lastError = '';
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const text = await this.#streamOnce(fullSystem, user, Math.min(6000, maxTokens * (attempt + 1)));
                if (text.trim()) return dedupeModelText(text);
                lastError = '模型返回了空内容';
            } catch (error) {
                lastError = String(error?.message || error);
            }
        }
        throw new Error(lastError || '模型调用失败');
    }

    #habitPrompt() {
        const all = this.store.allPatterns(200) || [];
        const picked = [];
        const seen = new Map();
        for (const p of all) {
            const key = p.category || '日常叙述';
            if ((seen.get(key) || 0) >= 2) continue;
            picked.push(`- [${key}] ${String(p.pattern || '').replace(/\s+/gu, ' ').slice(0, 90)}`);
            seen.set(key, (seen.get(key) || 0) + 1);
            if (picked.length >= 8) break;
        }
        return picked.length ? `你的语言习惯（背景，别在回复里讨论）：\n${picked.join('\n')}` : '';
    }

    async ask(prompt, { homeworkId = 0 } = {}) {
        const text = String(prompt || '').trim();
        if (!text) throw new Error('先写一句老师的话或场景');
        const id = this.store.addDialogue({ homeworkId, prompt: text, status: 'answering' });
        try {
            const habits = this.#habitPrompt();
            const user = `${habits ? habits + '\n\n' : ''}老师刚才说：\n「${text}」\n\n这是对话测试，直接回话。`;
            const reply = await this.#call(SYSTEM_DIALOGUE, user, { maxTokens: 1200 });
            this.store.updateDialogue(id, { reply, status: 'pending_review' });
            this.store.log('info', `对话测试已回复：${reply.slice(0, 30)}`);
            return this.store.getDialogue(id);
        } catch (error) {
            const message = String(error?.message || error);
            this.store.updateDialogue(id, { status: 'failed', error: message });
            this.store.log('warn', `对话测试失败：${message}`);
            return this.store.getDialogue(id);
        }
    }

    async review(id, { score = null, suggestion = '' } = {}) {
        const item = this.store.getDialogue(id);
        if (!item) throw new Error('这条测试不存在');
        if (!item.reply) throw new Error('还没有回复可以评价');
        const value = score === null || score === undefined || score === '' ? null : Math.max(0, Math.min(100, Number(score)));
        const suggestionText = String(suggestion || '').trim();
        this.store.updateDialogue(id, { status: 'reviewing', score: value, suggestion: suggestionText });
        try {
            const user = [
                `老师的打分：${value ?? '未给分'}`,
                `老师的建议：${suggestionText || '（这次没有提建议）'}`,
                '',
                `老师的话：「${item.prompt}」`,
                `我的回复：「${item.reply}」`,
                '',
                '请按系统提示的要求写自我反思。',
            ].join('\n');
            const text = await this.#call(SYSTEM_REVIEW, user, { maxTokens: 1200 });
            this.store.updateDialogue(id, { status: 'done', self_review: text, reviewed_at: Date.now() });
            this.store.log('info', '对话测试评价已接受');
            return this.store.getDialogue(id);
        } catch (error) {
            const message = String(error?.message || error);
            this.store.updateDialogue(id, { status: 'failed', error: message });
            this.store.log('warn', `对话测试反思失败：${message}`);
            return this.store.getDialogue(id);
        }
    }

    latest() {
        return this.store.latestDialogue();
    }

    list(limit = 10) {
        return this.store.listDialogue(limit);
    }
}

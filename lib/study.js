/**
 * 「学习一次」会话：给定分钟数，跑一轮探索并报告进度。
 * 面板轮询 view() 渲染进度条；结束后把结果写进 meta，重开面板还能看到上次结果。
 */
export class StudySession {
    constructor({ store, explorer, settings, onFinish = null, logger = null }) {
        this.store = store;
        this.explorer = explorer;
        this.settings = settings;
        this.onFinish = onFinish;
        this.logger = logger;
        this.state = this.#load();
        this.promise = null;
    }

    #idle() {
        return {
            running: false, startedAt: 0, minutes: 0, pages: 0, comments: 0, patterns: 0,
            stoppedReason: '', error: '', elapsedMs: 0, byPlatform: {},
        };
    }

    #load() {
        try {
            const saved = JSON.parse(this.store.getMeta('study.last') || 'null');
            return saved && typeof saved === 'object' ? { ...this.#idle(), ...saved, running: false } : this.#idle();
        } catch {
            return this.#idle();
        }
    }

    view() {
        const state = this.state;
        const elapsedMs = state.running && state.startedAt ? Date.now() - state.startedAt : Number(state.elapsedMs) || 0;
        const total = (Number(state.minutes) || 0) * 60_000;
        const progress = total > 0 ? Math.max(0, Math.min(1, elapsedMs / total)) : 0;
        return {
            running: Boolean(state.running),
            startedAt: state.startedAt || 0,
            minutes: state.minutes || 0,
            pages: state.pages || 0,
            comments: state.comments || 0,
            byPlatform: state.byPlatform || {},
            patterns: state.patterns || 0,
            stoppedReason: state.stoppedReason || '',
            error: state.error || '',
            elapsedMs,
            remainingMs: Math.max(0, total - elapsedMs),
            progress,
        };
    }

    start(minutes) {
        if (this.state.running) return { ok: false, error: '已有学习在进行中' };
        const value = Math.max(1, Math.min(120, Number(minutes) || 10));
        if (this.settings) this.settings.write({ studyMinutes: value });
        this.state = {
            running: true, startedAt: Date.now(), minutes: value, pages: 0,
            comments: 0, patterns: 0, stoppedReason: '', error: '', elapsedMs: 0, byPlatform: {},
        };
        this.store.log('info', `开始学习：${value} 分钟`);
        this.promise = this.explorer.runCycle({
            pages: 9999,
            minutes: value,
            mixed: true,
            onProgress: (result) => {
                this.state.pages += 1;
                this.state.comments += Number(result?.comments) || 0;
                this.state.patterns += Number(result?.patterns) || 0;
                const key = String(result?.platform || 'other');
                const slot = this.state.byPlatform[key] || (this.state.byPlatform[key] = { pages: 0, comments: 0 });
                slot.pages += 1;
                slot.comments += Number(result?.comments) || 0;
            },
        }).then((result) => {
            this.state.running = false;
            this.state.stoppedReason = result?.stoppedReason || 'done';
            this.state.pages = result?.pages ?? this.state.pages;
            this.state.comments = (result?.results || []).reduce((n, r) => n + (Number(r.comments) || 0), 0) || this.state.comments;
            this.state.patterns = (result?.results || []).reduce((n, r) => n + (Number(r.patterns) || 0), 0) || this.state.patterns;
            this.state.elapsedMs = Date.now() - this.state.startedAt;
            this.#save();
            this.store.log('info', `学习结束：${this.state.pages} 页 / ${this.state.comments} 条评论 / ${this.state.patterns} 条规律`);
            try {
                this.onFinish?.(this.view());
            } catch (error) {
                this.store.log('warn', `学习结束回调失败：${String(error?.message || error)}`);
            }
            return this.view();
        }).catch((error) => {
            this.state.running = false;
            this.state.error = String(error?.message || error);
            this.state.elapsedMs = Date.now() - this.state.startedAt;
            this.#save();
            this.store.log('warn', `学习失败：${this.state.error}`);
            return this.view();
        });
        return { ok: true, study: this.view() };
    }

    stop() {
        this.explorer.stop();
        if (this.state.running) {
            this.state.running = false;
            this.state.stoppedReason = 'stopped-by-user';
            this.state.elapsedMs = Date.now() - this.state.startedAt;
            this.#save();
        }
        return { ok: true, study: this.view() };
    }

    #save() {
        this.store.setMeta('study.last', JSON.stringify({
            running: false, startedAt: this.state.startedAt, minutes: this.state.minutes,
            pages: this.state.pages, comments: this.state.comments, patterns: this.state.patterns,
            stoppedReason: this.state.stoppedReason, error: this.state.error, elapsedMs: this.state.elapsedMs,
            byPlatform: this.state.byPlatform,
        }));
        this.store.setMeta('last_learn_at', String(Date.now()));
    }
}

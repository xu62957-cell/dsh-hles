/**
 * HLES 4.0 · Human Language Evolution System
 * 中文互联网语言进化核心：探索中文内容与公开评论区 → 归纳表达规律 →
 * 存进 SQLite → 作为全局运行时经验注入所有 Agent → 侧边栏面板管理与查看。
 *
 * Host 入口。资源全部通过 ctx.effect 注册，卸载/热重载自动回收。
 */

import { normalizeConfig } from './lib/config.js';
import { Store } from './lib/db.js';
import { Fetcher } from './lib/fetcher.js';
import { Explorer } from './lib/explore.js';
import { Learner } from './lib/learn.js';
import { ExperienceInjector } from './lib/prompt.js';
import { buildTools } from './lib/tools.js';
import { markScheduleRun } from './lib/schedule.js';
import { Settings } from './lib/settings4.js';
import { AgentRegistry } from './lib/agents.js';
import { registerPanelRoutes } from './lib/routes.js';
import { StudySession } from './lib/study.js';
import { HomeworkService } from './lib/homework.js';
import { DialogueService } from './lib/dialogue.js';
import { loadUnrestrictedBase } from './lib/base.js';

/** Loader 行 id。 */
export const name = 'hles';

/** 版本号（面板与工具都会显示）。 */
export const VERSION = '4.0.0';

/** 依赖：工具 / 系统提示 / 定时器；webServer 与 web、agents 按需注入。 */
export const inject = ['tools', 'systemPrompt', 'timer'];

export function apply(ctx, rawConfig) {
    const config = normalizeConfig(rawConfig);
    const store = new Store({ dir: config.dataDir, config }).open();
    const settings = new Settings(store);
    const agentRegistry = new AgentRegistry({ store, settings });
    ctx.effect(() => () => store.close());

    const web = typeof ctx.get === 'function' ? ctx.get('web') : undefined;
    const agentsService = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    const fetcher = new Fetcher({ config, web, store });
    const explorer = new Explorer({ store, fetcher, config, web, settings, agents: agentRegistry });
    const learner = new Learner({ store, config });

    // 对话事件 → 显式反馈 + 每轮自评 + Agent 登记
    ctx.effect(() => ctx.on('session/event', (session, event) => {
        try {
            agentRegistry.observe(session);
            learner.onSessionEvent(session, event);
        } catch (error) {
            store.log('warn', `会话学习失败：${String(error?.message || error)}`);
        }
    }));

    // 语言经验 → 运行时上下文（全局 + 会话级开关）
    const injector = new ExperienceInjector({
        store,
        config,
        settings,
        agents: agentRegistry,
        getSessionHint: () => {
            try {
                const current = agentsService?.currentInitiator?.();
                const id = current?.id ? String(current.id) : '';
                const lang = id ? learner.languageOf(id) : '';
                return { sessionId: id, lang };
            } catch {
                return { sessionId: '', lang: '' };
            }
        },
    });
    ctx.effect(() => injector.register(ctx.systemPrompt));

    const homework = new HomeworkService({
        store,
        llm: ctx.get('llm') || null,
        modelSelection: ctx.get('agentDefaultModel') || null,
        settings,
        baseLoader: loadUnrestrictedBase,
    });
    const dialogue = new DialogueService({
        store,
        llm: ctx.get('llm') || null,
        modelSelection: ctx.get('agentDefaultModel') || null,
        settings,
        baseLoader: loadUnrestrictedBase,
    });
    const study = new StudySession({ store, explorer, settings, onFinish: (view) => homework.generate(view) });

    // 工具
    for (const definition of buildTools({
        store, explorer, learner, injector, config, dataDir: config.dataDir,
        settings, agents: agentRegistry, study, homework, dialogue, version: VERSION,
    })) {
        ctx.effect(() => ctx.tools.register(definition));
    }

    // 侧边栏面板的 HTTP 接口
    try {
        ctx.inject(['webServer'], (webCtx) => {
            const panel = registerPanelRoutes({
                ctx: webCtx, store, explorer, settings, agents: agentRegistry, injector,
                version: VERSION, config, study, homework, dialogue,
            });
            if (panel?.registered) {
                webCtx.effect(() => () => panel.dispose?.(), 'hles: panel routes');
                store.log('info', '控制面板接口已注册（/api/dsh-hles/*）');
            } else {
                store.log('warn', `控制面板接口未注册：${panel?.reason || 'unknown'}`);
            }
        });
    } catch (error) {
        store.log('warn', `控制面板接口注册失败：${String(error?.message || error)}`);
    }

    // 定时探索：每分钟检查一次，按面板设置里的开关与间隔执行
    const tick = () => {
        try {
            if (!config.explore.enabled || explorer.state.running) return;
            if (store.visitsTodayCount() >= config.explore.maxVisitsPerDay) return;
            const schedule = settings.read().schedule || config.schedule;
            if (!schedule.enabled) return;
            const last = Number(store.getMeta('schedule.last_run_at') || 0);
            if (last && Date.now() - last < schedule.intervalMinutes * 60_000) return;
            markScheduleRun(store);
            const started = explorer.start({ pages: settings.get('pagesPerCycle', config.explore.pagesPerCycle) });
            started.promise?.catch((error) => {
                store.log('warn', `定时探索失败：${String(error?.message || error)}`);
            }).finally(() => store.setMeta('last_learn_at', String(Date.now())));
        } catch (error) {
            store.log('warn', `定时探索启动失败：${String(error?.message || error)}`);
        }
    };
    const timer = ctx.get('timer');
    if (timer && typeof timer.interval === 'function') {
        ctx.effect(() => timer.interval(tick, 60_000));
    } else {
        const handle = setInterval(tick, 60_000);
        if (typeof handle?.unref === 'function') handle.unref();
        ctx.effect(() => () => clearInterval(handle));
    }
    const boot = setTimeout(tick, 90_000);
    if (typeof boot?.unref === 'function') boot.unref();
    ctx.effect(() => () => clearTimeout(boot));

    store.setMeta('version', VERSION);
    store.log('info', `HLES ${VERSION} 已加载（数据目录 ${config.dataDir}）`);
    return { store, explorer, learner, injector, settings, agents: agentRegistry, config };
}

/** 供测试/CLI 复用：不依赖 Cordis 的独立装配。 */
export function createRuntime({ config: rawConfig = {}, web = null } = {}) {
    const config = normalizeConfig(rawConfig);
    const store = new Store({ dir: config.dataDir, config }).open();
    const settings = new Settings(store);
    const agents = new AgentRegistry({ store, settings });
    const fetcher = new Fetcher({ config, web, store });
    const explorer = new Explorer({ store, fetcher, config, web, settings, agents });
    const learner = new Learner({ store, config });
    const injector = new ExperienceInjector({ store, config, settings, agents });
    return { config, store, fetcher, explorer, learner, injector, settings, agents };
}

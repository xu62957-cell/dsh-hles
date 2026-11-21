/**
 * Agent 接入注册表（4.0 §6）。
 *
 * 全局注入不需要每个 Agent 单独配置：所有 agent 默认接入。这里记录"见过哪些
 * Agent、它们用的是哪个预设、是否被单独关掉"，供侧边栏展示与开关。
 * 人格本身完全不动：HLES 只往运行上下文里加一段语言倾向，不写任何预设文件。
 */

export class AgentRegistry {
    constructor({ store, settings }) {
        this.store = store;
        this.settings = settings;
    }

    /** 从 session 事件侧登记（header.agentPreset 是当前预设名）。 */
    observe(session) {
        if (!session?.id) return;
        const preset = String(session.header?.agentPreset || '');
        this.store.registerAgent({ id: String(session.id), preset, title: preset });
    }

    /** 从 live agent 列表登记（agents.list() 返回的 Agent 只有 id）。 */
    syncLive(list) {
        for (const agent of list || []) {
            if (agent?.id) this.store.registerAgent({ id: String(agent.id), preset: '', title: '' });
        }
    }

    list() {
        return this.store.listAgents(100);
    }

    stats() {
        return this.store.agentStats();
    }

    setEnabled(id, enabled) {
        return this.store.setAgentEnabled(id, enabled);
    }

    /** 注入层用：这个会话是否允许注入。 */
    enabledFor(sessionId) {
        if (!sessionId) return true;
        return this.store.agentEnabled(sessionId);
    }

    /** 全局开关（设置项 inject.global）。 */
    globalEnabled() {
        return this.settings ? this.settings.get('inject.global', true) !== false : true;
    }
}

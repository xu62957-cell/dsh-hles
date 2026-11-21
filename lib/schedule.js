/**
 * 运行调度：定时探索的开关与间隔支持运行期修改（存在 SQLite meta 里）。
 * 这样用户用一句工具调用就能开/关自动探索，不必改配置文件、不必重装插件。
 */

import { clamp } from './util.js';

const META_ENABLED = 'schedule.enabled';
const META_INTERVAL = 'schedule.interval_minutes';
const META_LAST_RUN = 'schedule.last_run_at';

export function readSchedule(store, config) {
    const enabledRaw = store.getMeta(META_ENABLED);
    const intervalRaw = store.getMeta(META_INTERVAL);
    const lastRunAt = Number(store.getMeta(META_LAST_RUN) || 0);
    return {
        enabled: enabledRaw === null ? Boolean(config.schedule.enabled) : enabledRaw === '1',
        intervalMinutes: intervalRaw === null
            ? config.schedule.intervalMinutes
            : clamp(Number(intervalRaw) || config.schedule.intervalMinutes, 5, 1440),
        lastRunAt,
        nextRunAt: lastRunAt ? lastRunAt + clamp(Number(intervalRaw) || config.schedule.intervalMinutes, 5, 1440) * 60_000 : 0,
    };
}

export function setSchedule(store, { enabled, intervalMinutes }) {
    if (typeof enabled === 'boolean') store.setMeta(META_ENABLED, enabled ? '1' : '0');
    if (intervalMinutes !== undefined && intervalMinutes !== null) {
        store.setMeta(META_INTERVAL, String(clamp(Math.round(Number(intervalMinutes)), 5, 1440)));
    }
    return readSchedule(store, { schedule: { enabled: false, intervalMinutes: 360 } });
}

export function markScheduleRun(store, ts = Date.now()) {
    store.setMeta(META_LAST_RUN, String(ts));
}

/** 到了该跑的时间吗。 */
export function scheduleDue(store, config, now = Date.now()) {
    const s = readSchedule(store, config);
    if (!s.enabled) return { due: false, reason: 'disabled', schedule: s };
    if (!s.lastRunAt) return { due: true, reason: 'first-run', schedule: s };
    if (now - s.lastRunAt >= s.intervalMinutes * 60_000) return { due: true, reason: 'interval', schedule: s };
    return { due: false, reason: 'not-yet', schedule: s };
}

#!/usr/bin/env node
/**
 * 长跑测试：连续访问 N 个页面，检查领域分布、重复率、失败率、内存与数据库增长，
 * 以及语言经验/知识的沉淀情况。用于验收清单里的"连续访问 100 个页面"。
 *
 *   node test/long-run.mjs --pages 100 --batch 10 --data-dir /tmp/hles-long
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRuntime } from '../index.js';
import { FEEDS, domainNames } from '../lib/sources.js';
import { round } from '../lib/util.js';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const pages = Number(arg('pages', 100));
const batch = Number(arg('batch', 10));
const dataDir = resolve(arg('data-dir', join(process.cwd(), '..', 'hles-dev', 'long-run')));
const reset = process.argv.includes('--reset');

if (reset) rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const started = Date.now();
const { store, explorer, config, injector } = createRuntime({ config: { dataDir, explore: { pageGapMs: 900 } } });
const heaps = [];
const results = [];
let cycles = 0;

console.log(`长跑测试：${pages} 页，每批 ${batch} 页，数据目录 ${dataDir}`);
while (results.length < pages) {
    const target = Math.min(batch, pages - results.length);
    cycles += 1;
    const cycle = await explorer.runCycle({ pages: target });
    results.push(...cycle.results);
    const heap = Math.round(process.memoryUsage().heapUsed / 1_048_576);
    heaps.push(heap);
    const domains = new Set(store.domainCounts(50).map((d) => d.domain)).size;
    console.log(`  批次 ${cycles}：${cycle.ok}/${cycle.pages} 成功 · 累计 ${results.length} 页 · 领域 ${domains} · 堆 ${heap}MB · 规律 ${store.patternCount()} · 知识 ${store.stats().knowledge}`);
    if (cycle.stoppedReason !== 'done') {
        console.log(`  批次提前结束：${cycle.stoppedReason}`);
        if (cycle.stoppedReason === 'no-target' || cycle.stoppedReason === 'too-many-failures') break;
    }
}

const visits = store.recentVisits(1000);
const canonical = visits.map((v) => v.url);
const dupes = canonical.length - new Set(canonical).size;
const domainCounts = store.domainCounts(200);
const maxShare = domainCounts.length ? round(domainCounts[0].n / visits.length, 3) : 1;
const statusCounts = {};
for (const r of results) statusCounts[r.status || 'unknown'] = (statusCounts[r.status || 'unknown'] || 0) + 1;
const covered = domainCounts.filter((d) => domainNames().includes(d.domain)).length;
const report = {
    pagesRequested: pages,
    pagesDone: results.length,
    ok: results.filter((r) => r.ok).length,
    elapsedSeconds: round((Date.now() - started) / 1000, 1),
    domainCounts,
    distinctDomains: domainCounts.length,
    taxonomyCovered: covered,
    taxonomyTotal: domainNames().length,
    maxSingleDomainShare: maxShare,
    duplicateVisits: dupes,
    statusCounts,
    memory: { samples: heaps, first: heaps[0], last: heaps[heaps.length - 1], peak: Math.max(...heaps) },
    dbSizeMB: store.stats().sizeMB,
    patterns: store.patternCount(),
    patternKinds: store.patternKinds(),
    knowledge: store.stats(),
    topPatterns: store.topPatterns({ limit: 12, minHits: 2 }),
    injectionPreview: injector.preview().chars,
    feedCount: FEEDS.length,
    frontier: store.frontierStats(),
    failures: [...new Map(results.filter((r) => !r.ok).map((r) => [r.url, { url: r.url, status: r.status, error: r.error }])).values()].slice(0, 10),
    config: { channelMix: config.explore.channelMix },
};
store.close();

const outFile = join(dataDir, `long-run-${pages}.json`);
writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`\n完成 ${report.pagesDone} 页（成功 ${report.ok}），用时 ${report.elapsedSeconds}s`);
console.log(`领域：${report.distinctDomains} 个（领域表覆盖 ${report.taxonomyCovered}/${report.taxonomyTotal}），最大单领域占比 ${(maxShare * 100).toFixed(0)}%`);
console.log(`分布：${domainCounts.slice(0, 12).map((d) => `${d.domain}×${d.n}`).join('、')}`);
console.log(`状态：${Object.entries(statusCounts).map(([k, v]) => `${k}×${v}`).join('、')}`);
console.log(`重复访问：${dupes}；内存：首 ${heaps[0]}MB / 峰 ${report.memory.peak}MB / 末 ${heaps[heaps.length - 1]}MB；数据库 ${report.dbSizeMB}MB`);
console.log(`语言规律 ${report.patterns} 条，知识 ${report.knowledge.knowledge} 条（已验证 ${report.knowledge.verified}）`);
console.log(`报告写入 ${outFile}`);

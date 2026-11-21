#!/usr/bin/env node
/**
 * HLES CLI：不经过 DSH 也能初始化数据库、跑探索、看统计、导出备份。
 * 既方便排障，也是"插件真的能跑"的独立证据。
 *
 * 用法：
 *   node scripts/hles-cli.mjs init
 *   node scripts/hles-cli.mjs explore --pages 3
 *   node scripts/hles-cli.mjs stats | report | patterns | inject
 *   node scripts/hles-cli.mjs assess --text "要检查的文字"
 *   node scripts/hles-cli.mjs backup | export | prune | vacuum | delete --scope visits
 */

import { readFileSync } from 'node:fs';
import { normalizeConfig } from '../lib/config.js';
import { createRuntime } from '../index.js';
import { assessText } from '../lib/quality.js';

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) args[key] = true;
            else {
                args[key] = next;
                i += 1;
            }
        } else args._.push(a);
    }
    return args;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'stats';

let rawConfig = {};
if (args.config) {
    rawConfig = JSON.parse(readFileSync(String(args.config), 'utf8'));
}
if (args['data-dir']) rawConfig.dataDir = String(args['data-dir']);

const { config, store, explorer, injector } = createRuntime({ config: rawConfig });

async function main() {
    if (command === 'init') {
        console.log(JSON.stringify({ ok: true, dataDir: config.dataDir, stats: store.stats() }, null, 2));
        return;
    }
    if (command === 'explore') {
        const pages = Number(args.pages) || 3;
        const minutes = Number(args.minutes) || 0;
        const result = await explorer.runCycle({ pages, minutes });
        console.log(`探索完成：${result.ok}/${result.pages} 成功（${result.stoppedReason}）`);
        for (const r of result.results) {
            console.log(`  [${r.ok ? 'ok' : r.status}] ${r.domain}｜${r.title || r.url}｜patterns=${r.patterns} knowledge=${r.knowledge}${r.error ? `｜${r.error}` : ''}`);
        }
        console.log(`\n${result.diary}`);
        return;
    }
    if (command === 'stats') {
        console.log(JSON.stringify({ stats: store.stats(), kinds: store.patternKinds(), trend: store.evalTrend(30), frontier: store.frontierStats() }, null, 2));
        return;
    }
    if (command === 'report') {
        console.log(JSON.stringify({
            stats: store.stats(),
            domains: store.domainCounts(15),
            topPatterns: store.topPatterns({ limit: 10 }),
            knowledge: store.searchKnowledge('', 8),
            interests: store.topInterests(5),
            diary: store.recentDiaries(1)[0]?.body || '',
        }, null, 2));
        return;
    }
    if (command === 'patterns') {
        const rows = store.allPatterns(200).filter((p) => !args.kind || p.kind === args.kind).slice(0, Number(args.limit) || 20);
        for (const p of rows) console.log(`[${p.kind}] ${p.pattern}\n    conf=${p.confidence} hits=${p.hits} 例：${p.example}`);
        return;
    }
    if (command === 'inject') {
        console.log(injector.preview().text || '（经验不足，当前不注入）');
        return;
    }
    if (command === 'assess') {
        const text = args.text ? String(args.text) : readFileSync(0, 'utf8');
        console.log(JSON.stringify(assessText(text, { context: String(args.context || '') }), null, 2));
        return;
    }
    if (command === 'backup') {
        console.log(store.backup());
        return;
    }
    if (command === 'export') {
        console.log(JSON.stringify(store.exportAll()).slice(0, 2000));
        return;
    }
    if (command === 'prune') {
        console.log(JSON.stringify(store.prune()));
        return;
    }
    if (command === 'vacuum') {
        console.log(JSON.stringify(store.vacuum()));
        return;
    }
    if (command === 'delete') {
        console.log(JSON.stringify(store.deleteScope(String(args.scope || ''))));
        return;
    }
    if (command === 'rollback') {
        console.log(JSON.stringify(store.rollback(String(args.table || 'lang_pattern'), Number(args.id))));
        return;
    }
    console.log(`未知命令：${command}`);
    process.exitCode = 1;
}

main()
    .catch((error) => {
        console.error(`HLES CLI 失败：${error?.stack || error}`);
        process.exitCode = 1;
    })
    .finally(() => {
        store.close();
    });

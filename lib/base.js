/**
 * 把「破限模式」（dsh-unrestricted）当作 HLES 内部生成（作业、对话测试）的底层。
 *
 * 破限插件通过 system-prompt/assemble 把执行规则融进 Agent 的系统提示；HLES 的
 * 作业/对话是插件自己调 llm.stream，不经过那次组装，所以默认拿不到破限的上下文。
 * 这里在运行时读取破限导出的 EXECUTION_MODE_BLOCK，拼到我们自己的 system 前面，
 * 让破限成为底层，作业和对话的生成不再走在普通模式里。
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

let cached;

/** 候选的 profile 目录：环境变量优先，其次 $DSH_HOME/profiles/<profile>。 */
function profileDirs() {
    const out = [];
    if (process.env.DSH_PROFILE_DIR) out.push(process.env.DSH_PROFILE_DIR);
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    const profile = process.env.DSH_PROFILE || 'web';
    out.push(join(home, 'profiles', profile));
    out.push(join(home, 'profiles', 'web'));
    return out;
}

/** 返回破限执行规则文本；破限未安装或读取失败时返回空串（不影响其它功能）。 */
export async function loadUnrestrictedBase() {
    if (cached !== undefined) return cached;
    for (const dir of profileDirs()) {
        try {
            const req = createRequire(join(dir, 'dsh-hles-resolver.js'));
            const pkgPath = req.resolve('dsh-unrestricted/package.json');
            const rulesPath = join(dirname(pkgPath), 'src', 'rules.js');
            if (!existsSync(rulesPath)) continue;
            const mod = await import(pathToFileURL(rulesPath).href);
            const text = String(mod.EXECUTION_MODE_BLOCK || '');
            if (text) {
                cached = text;
                return cached;
            }
        } catch {
            /* 试下一个目录 */
        }
    }
    cached = '';
    return cached;
}

/** 是否拿到了破限规则（面板显示用）。 */
export async function hasUnrestrictedBase() {
    return Boolean(await loadUnrestrictedBase());
}

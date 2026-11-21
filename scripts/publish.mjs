#!/usr/bin/env node
/**
 * 把当前目录发布到 GitHub。
 *
 *   GITHUB_TOKEN=ghp_xxx node scripts/publish.mjs --repo dsh-hles [--owner someone] [--private]
 *
 * 需要 classic PAT（repo 权限）或 fine-grained PAT（Administration: Read/Write + Contents: Read/Write）。
 * 已存在同名仓库时直接推送；否则先创建再推送。
 */
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
}, []));

const token = process.env.GITHUB_TOKEN || '';
if (!token) {
    console.error('缺少 GITHUB_TOKEN');
    process.exit(1);
}
const repo = String(args.repo || 'dsh-hles');
const priv = Boolean(args.private);

const api = async (path, init = {}) => {
    const res = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'hles-publish',
            ...(init.headers || {}),
        },
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!res.ok) throw new Error(`${res.status} ${path}: ${json?.message || text.slice(0, 200)}`);
    return json;
};

const me = await api('/user');
const owner = String(args.owner || me.login);
console.log(`账号：${owner}`);

try {
    await api(`/repos/${owner}/${repo}`);
    console.log(`仓库已存在：https://github.com/${owner}/${repo}`);
} catch (error) {
    if (!String(error.message).startsWith('404')) throw error;
    await api('/user/repos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            name: repo,
            description: 'HLES — 中文互联网语言进化插件（DSH）：探索评论区、积累语言经验、全局注入，带作业与对话测试',
            private: priv,
            has_issues: true,
            has_wiki: false,
            auto_init: false,
        }),
    });
    console.log(`仓库已创建：https://github.com/${owner}/${repo}`);
}

const git = (...a) => execFileSync('git', a, { stdio: 'inherit' });
git('add', '-A');
try { git('commit', '-m', 'HLES 4.0.0'); } catch { /* 无改动 */ }
try { git('remote', 'remove', 'origin'); } catch { /* 没有 origin */ }
git('remote', 'add', 'origin', `https://x-access-token:${token}@github.com/${owner}/${repo}.git`);
git('branch', '-M', 'main');
git('push', '-u', 'origin', 'main', '--force');
console.log(`完成：https://github.com/${owner}/${repo}`);

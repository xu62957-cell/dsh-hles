#!/usr/bin/env node
/**
 * 部署辅助：把当前源码打包成一份"可装入 profile 的运行时副本"。
 *
 * 为什么需要它：DSH 的 Host 进程对已加载的 ESM 模块做进程级缓存，
 * 同一条 realpath 上的代码改动要等宿主重启才会生效。要在不重启的情况下
 * 让新代码真正跑起来，只能换一个包名 + 换一个真实目录（新的模块 URL）。
 *
 * 用法：
 *   node scripts/deploy.mjs                       # 生成 ./hles-runtime（包名 dsh-hles）
 *   node scripts/deploy.mjs --name dsh-hles-r2 --out ./hles-runtime
 * 然后把输出里打印的路径交给 plugin_manager install_bundle。
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const outName = arg('out', 'hles-runtime');
const pkgName = arg('name', 'dsh-hles');
const rowId = arg('id', 'hles');
const outDir = resolve(root, '..', outName);
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

if (existsSync(outDir)) {
    for (const entry of readdirSync(outDir)) {
        if (entry === 'node_modules') continue;
        rmSync(join(outDir, entry), { recursive: true, force: true });
    }
}
mkdirSync(outDir, { recursive: true });

const targets = ['index.js', 'client.js', 'lib', 'package.json', 'cordis.patch.yml', 'README.md', 'docs', 'scripts'];
for (const target of targets) {
    const src = join(root, target);
    if (!existsSync(src)) continue;
    cpSync(src, join(outDir, target), { recursive: true });
}

// 客户端模块 id 必须等于安装后的包名，否则页面加载时对不上号
const clientPath = join(outDir, 'client.js');
if (existsSync(clientPath)) {
    const text = readFileSync(clientPath, 'utf8').replace(/id: '@local\/dsh-hles'/u, `id: '${pkgName}'`);
    writeFileSync(clientPath, text);
}

// 补丁里的 name 必须指向部署后的包名，否则 Loader 会去解析旧包
const patchPath = join(outDir, 'cordis.patch.yml');
if (existsSync(patchPath)) {
    const patchText = readFileSync(patchPath, 'utf8')
        .replace(/name:\s*'[^']*'/u, `name: '${pkgName}'`)
        .replace(/^\s*- id: hles\s*$/mu, `    - id: ${rowId}`);
    writeFileSync(patchPath, patchText);
}

const manifestPath = join(outDir, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.name = pkgName;
manifest.version = version;
manifest.private = true;
manifest.meta = { ...(manifest.meta || {}), title: 'HLES 3.0 语言进化' };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const missing = ['index.js', 'lib/db.js', 'cordis.patch.yml'].filter((f) => !existsSync(join(outDir, f)));
if (missing.length) {
    console.error(`部署副本缺少文件：${missing.join(', ')}`);
    process.exitCode = 1;
} else {
    const size = totalSize(outDir);
    console.log(`已生成运行时副本：${outDir}`);
    console.log(`包名：${pkgName}@${version}，约 ${(size / 1024).toFixed(0)}KB`);
    console.log(`安装：plugin_manager install_bundle，target = ${outDir}`);
}

function totalSize(dir) {
    let sum = 0;
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        const st = statSync(path);
        sum += st.isDirectory() ? totalSize(path) : st.size;
    }
    return sum;
}

/**
 * 一次性修复脚本：为缺少默认内容（settings.json 等）的现有用户补种内容。
 *
 * 用法:
 *   node seed-user.js <handle>     # 为指定用户补种
 *   node seed-user.js --all        # 为所有缺少 settings.json 的用户补种
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import storage from 'node-persist';
import yaml from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ST_DIR = path.join(__dirname, '..', 'SillyTavern');
const CONFIG_PATH = path.join(ST_DIR, 'config.yaml');

const config = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const DATA_ROOT = path.resolve(ST_DIR, config.dataRoot || './data');
const STORAGE_DIR = path.join(DATA_ROOT, '_storage');
const CONTENT_DIR = path.join(ST_DIR, 'default', 'content');
const CONTENT_INDEX_PATH = path.join(CONTENT_DIR, 'index.json');
const KEY_PREFIX = 'user:';

const USER_DIRECTORY_TEMPLATE = {
    root: '',
    thumbnails: 'thumbnails',
    thumbnailsBg: 'thumbnails/bg',
    thumbnailsAvatar: 'thumbnails/avatar',
    thumbnailsPersona: 'thumbnails/persona',
    worlds: 'worlds',
    user: 'user',
    avatars: 'User Avatars',
    userImages: 'user/images',
    groups: 'groups',
    groupChats: 'group chats',
    chats: 'chats',
    characters: 'characters',
    backgrounds: 'backgrounds',
    novelAI_Settings: 'NovelAI Settings',
    koboldAI_Settings: 'KoboldAI Settings',
    openAI_Settings: 'OpenAI Settings',
    textGen_Settings: 'TextGen Settings',
    themes: 'themes',
    movingUI: 'movingUI',
    extensions: 'extensions',
    instruct: 'instruct',
    context: 'context',
    quickreplies: 'QuickReplies',
    assets: 'assets',
    comfyWorkflows: 'user/workflows',
    files: 'user/files',
    vectors: 'vectors',
    backups: 'backups',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
};

const CONTENT_TYPE_TO_DIR_KEY = {
    settings: 'root',
    character: 'characters',
    sprites: 'characters',
    background: 'backgrounds',
    world: 'worlds',
    avatar: 'avatars',
    theme: 'themes',
    workflow: 'comfyWorkflows',
    kobold_preset: 'koboldAI_Settings',
    openai_preset: 'openAI_Settings',
    novel_preset: 'novelAI_Settings',
    textgen_preset: 'textGen_Settings',
    instruct: 'instruct',
    context: 'context',
    moving_ui: 'movingUI',
    quick_replies: 'quickreplies',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
};

function getUserDirectories(handle) {
    const dirs = {};
    for (const key of Object.keys(USER_DIRECTORY_TEMPLATE)) {
        dirs[key] = path.join(DATA_ROOT, handle, USER_DIRECTORY_TEMPLATE[key]);
    }
    return dirs;
}

function getContentIndex() {
    if (!fs.existsSync(CONTENT_INDEX_PATH)) return [];
    try {
        const index = JSON.parse(fs.readFileSync(CONTENT_INDEX_PATH, 'utf8'));
        return Array.isArray(index) ? index : [];
    } catch {
        return [];
    }
}

function seedDefaultContent(handle) {
    const directories = getUserDirectories(handle);

    // 确保所有目录存在
    for (const dir of Object.values(directories)) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    const contentIndex = getContentIndex();
    const contentLogPath = path.join(directories.root, 'content.log');
    const contentLog = fs.existsSync(contentLogPath)
        ? fs.readFileSync(contentLogPath, 'utf8').split('\n')
        : [];

    let copied = 0;
    for (const item of contentIndex) {
        if (!item || !item.filename || !item.type) continue;
        if (contentLog.includes(item.filename)) continue;

        const dirKey = CONTENT_TYPE_TO_DIR_KEY[item.type];
        if (!dirKey) continue;

        const sourcePath = path.join(CONTENT_DIR, item.filename);
        if (!fs.existsSync(sourcePath)) continue;

        const targetDir = directories[dirKey];
        const baseName = path.parse(item.filename).base;
        const targetPath = path.join(targetDir, baseName);

        contentLog.push(item.filename);
        if (fs.existsSync(targetPath)) continue;

        fs.mkdirSync(targetDir, { recursive: true });
        fs.cpSync(sourcePath, targetPath, { recursive: true, force: false });
        copied++;
    }

    fs.writeFileSync(contentLogPath, contentLog.join('\n'));
    return copied;
}

async function main() {
    await storage.init({ dir: STORAGE_DIR, ttl: false, expiredInterval: 0 });

    const arg = process.argv[2];
    if (!arg) {
        console.error('用法: node seed-user.js <handle> | --all');
        process.exit(1);
    }

    let handles = [];
    if (arg === '--all') {
        const keys = await storage.keys(x => x.key.startsWith(KEY_PREFIX));
        const allHandles = keys.map(k => k.replace(KEY_PREFIX, ''));
        // 只处理缺少 settings.json 的用户
        handles = allHandles.filter(h => !fs.existsSync(path.join(DATA_ROOT, h, 'settings.json')));
        console.log(`缺少默认内容的用户 (${handles.length}): ${handles.join(', ') || '(无)'}`);
    } else {
        handles = [arg];
    }

    for (const handle of handles) {
        const user = await storage.getItem(KEY_PREFIX + handle);
        if (!user) {
            console.warn(`跳过 ${handle}: 用户不存在`);
            continue;
        }
        const copied = seedDefaultContent(handle);
        console.log(`✓ ${handle}: 植入 ${copied} 个文件`);
    }

    console.log('完成。');
}

main().catch(err => {
    console.error('修复失败:', err);
    process.exit(1);
});

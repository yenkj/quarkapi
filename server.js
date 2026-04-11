const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const QuarkDirectLink = require('./quark');

const QUARK_SHARE_API_BASE = 'https://drive-h.quark.cn/1/clouddrive';
const QUARK_DRIVE_API_BASE = 'https://drive-pc.quark.cn/1/clouddrive';
const QUARK_QUERY = 'pr=ucpro&fr=pc';

const VIDEO_EXTENSIONS = [
  '.mp4',
  '.mkv',
  '.avi',
  '.m3u8',
  '.flv',
  '.ts',
  '.mov',
  '.wmv',
  '.webm',
  '.rmvb',
  '.rm',
  '.mpg',
  '.mpeg',
  '.3gp',
  '.f4v',
  '.m4v',
  '.vob',
];

const tokenCache = new Map();

const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('加载配置失败:', e.message);
  }
  return { quarkCookie: '', pansouHost: '' };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (e) {
    console.error('保存配置失败:', e.message);
    return false;
  }
}

let config = loadConfig();

function getPansouHost() {
  return process.env.PANSOU_HOST || config.pansouHost || '';
}

function getQuarkCookie() {
  return process.env.QUARK_COOKIE || config.quarkCookie || '';
}

const PANSOU_API = getPansouHost() ? `${getPansouHost()}/api/search` : '';

console.log('QuarkAPI 配置:');
console.log('  盘搜地址:', getPansouHost() || '(未配置)');
console.log('  夸克Cookie:', getQuarkCookie() ? '(已配置)' : '(未配置)');

function getQuarkInstance() {
  const cookie = getQuarkCookie();
  if (!cookie) return null;
  return new QuarkDirectLink(cookie);
}

function getOpenlistUrl() {
  return process.env.OPENLIST_URL || config.openlistUrl || '';
}

function getOpenlistUsername() {
  return process.env.OPENLIST_USERNAME || config.openlistUsername || '';
}

function getOpenlistPassword() {
  return process.env.OPENLIST_PASSWORD || config.openlistPassword || '';
}

function getQuarkPlayTempSavePath() {
  return process.env.QUARK_PLAY_TEMP_SAVE_PATH || config.quarkPlayTempSavePath || '';
}

function getOpenlistTempPath() {
  return process.env.OPENLIST_TEMP_PATH || config.openlistTempPath || '';
}

class OpenListClient {
  constructor(baseURL, username, password) {
    this.baseURL = baseURL;
    this.username = username;
    this.password = password;
    this.token = '';
  }

  static async login(baseURL, username, password) {
    const response = await fetch(`${baseURL}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username,
        password,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenList 登录失败: ${response.status}`);
    }

    const data = await response.json();
    if (data.code !== 200 || !data.data?.token) {
      throw new Error('OpenList 登录失败: 未获取到Token');
    }

    return data.data.token;
  }

  async getToken() {
    const cacheKey = `${this.baseURL}:${this.username}`;
    const cached = tokenCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      this.token = cached.token;
      return this.token;
    }

    console.log('[OpenListClient] Token 不存在或已过期，重新登录');
    this.token = await OpenListClient.login(this.baseURL, this.username, this.password);

    tokenCache.set(cacheKey, {
      token: this.token,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });

    console.log('[OpenListClient] 登录成功，Token 已缓存');
    return this.token;
  }

  async fetchWithRetry(url, options, retried = false) {
    const token = await this.getToken();
    const requestOptions = {
      ...options,
      headers: {
        ...options.headers,
        Authorization: token,
      },
    };

    const response = await fetch(url, requestOptions);

    if (response.status === 401 && !retried) {
      console.log('[OpenListClient] 收到 HTTP 401，清除 Token 缓存并重试');
      tokenCache.delete(`${this.baseURL}:${this.username}`);
      return this.fetchWithRetry(url, options, true);
    }

    if (response.ok && !retried) {
      try {
        const clonedResponse = response.clone();
        const data = await clonedResponse.json();

        if (data.code === 401) {
          console.log('[OpenListClient] 响应体 code 为 401，Token 已过期，清除缓存并重试');
          tokenCache.delete(`${this.baseURL}:${this.username}`);
          return this.fetchWithRetry(url, options, true);
        }
      } catch (error) {
        console.warn('[OpenListClient] 解析响应 JSON 失败:', error);
      }
    }
    return response;
  }

  async refreshDirectory(path) {
    try {
      const response = await this.fetchWithRetry(`${this.baseURL}/api/fs/list`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path,
          password: '',
          refresh: true,
          page: 1,
          per_page: 1,
        }),
      });

      if (!response.ok) {
        console.warn(`刷新目录缓存失败: ${response.status}`);
      }
    } catch (error) {
      console.warn('刷新目录缓存失败:', error);
    }
  }

  async listDirectory(path, page = 1, perPage = 100) {
    try {
      const response = await this.fetchWithRetry(`${this.baseURL}/api/fs/list`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path,
          password: '',
          refresh: false,
          page,
          per_page: perPage,
        }),
      });

      if (!response.ok) {
        console.warn(`列出目录失败: ${response.status}`);
        return [];
      }

      const data = await response.json();
      if (data.code === 200 && data.data?.content) {
        return data.data.content;
      }
      return [];
    } catch (error) {
      console.warn('列出目录失败:', error);
      return [];
    }
  }

  async getVideoPreview(path) {
    try {
      const response = await this.fetchWithRetry(`${this.baseURL}/api/fs/get`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path,
          password: '',
          with_video_preview: true
        }),
      });

      if (!response.ok) {
        throw new Error(`获取视频预览失败: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.warn('获取视频预览失败:', error);
      throw error;
    }
  }

  async getFile(path) {
    try {
      const response = await this.fetchWithRetry(`${this.baseURL}/api/fs/get`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path,
          password: ''
        }),
      });

      if (!response.ok) {
        throw new Error(`获取文件信息失败: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.warn('获取文件信息失败:', error);
      throw error;
    }
  }
}

function buildApiUrl(base, path, query = '') {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}?${QUARK_QUERY}${query ? `&${query}` : ''}`;
}

function getQuarkHeaders(cookie) {
  return {
    'content-type': 'application/json',
    cookie,
    origin: 'https://pan.quark.cn',
    referer: 'https://pan.quark.cn/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  };
}

function normalizeQuarkCookie(cookie) {
  return cookie
    .replace(/；/g, ';')
    .replace(/：/g, ':')
    .replace(/，/g, ',')
    .trim();
}

function normalizePath(path) {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

function joinPath(...parts) {
  const joined = parts
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/');
  return normalizePath(joined);
}

function sanitizeFolderName(name) {
  return (name || 'quark-temp')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

async function parseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`夸克接口返回异常：${text.slice(0, 200)}`);
  }
}

function ensureOk(data, fallbackMessage) {
  if (data?.code === 0 || data?.code === 200 || data?.status === 200) {
    return;
  }
  throw new Error(data?.message || data?.msg || fallbackMessage);
}

function parseQuarkShareUrl(url, passcode = '') {
  const parsed = new URL(url);
  const pwdId =
    parsed.pathname.match(/\/s\/([A-Za-z0-9_-]+)/)?.[1] ||
    parsed.searchParams.get('pwd_id') ||
    '';

  if (!pwdId) {
    throw new Error('无法解析夸克分享链接');
  }

  return {
    pwdId,
    passcode:
      passcode ||
      parsed.searchParams.get('pwd') ||
      parsed.searchParams.get('passcode') ||
      '',
  };
}

async function fetchShareToken(cookie, share) {
  const response = await fetch(
    buildApiUrl(QUARK_SHARE_API_BASE, '/share/sharepage/token'),
    {
      method: 'POST',
      headers: getQuarkHeaders(cookie),
      body: JSON.stringify({
        pwd_id: share.pwdId,
        passcode: share.passcode,
      }),
    }
  );

  const data = await parseJson(response);
  ensureOk(data, '获取夸克分享 token 失败');

  const stoken =
    data?.data?.stoken ||
    data?.data?.share_token ||
    data?.data?.token;

  if (!stoken) {
    throw new Error('夸克分享 token 缺失');
  }

  return {
    stoken,
    shareTitle: data?.data?.title || '',
  };
}

async function fetchShareFolderItems(
  cookie,
  pwdId,
  stoken,
  pdirFid = '0'
) {
  const query = new URLSearchParams({
    pwd_id: pwdId,
    stoken,
    pdir_fid: pdirFid,
    _page: '1',
    _size: '200',
    _fetch_banner: '0',
  });

  const response = await fetch(
    buildApiUrl(QUARK_SHARE_API_BASE, '/share/sharepage/detail', query.toString()),
    {
      method: 'GET',
      headers: getQuarkHeaders(cookie),
    }
  );

  const data = await parseJson(response);
  ensureOk(data, '获取夸克分享详情失败');

  const list = data?.data?.list || [];
  return list.map((item) => ({
    fid: String(item.fid || item.file_id || ''),
    fileName: String(item.file_name || item.name || ''),
    dir: Boolean(item.dir || item.is_dir || item.file_type === 0),
    shareFidToken:
      item.share_fid_token || item.fid_token || item.share_token || undefined,
    pdirFid: String(item.pdir_fid || pdirFid || '0'),
  }));
}

async function fetchDriveFolderItems(
  cookie,
  pdirFid = '0',
  page = 1,
  size = 200
) {
  const query = new URLSearchParams({
    pdir_fid: pdirFid,
    _page: String(page),
    _size: String(size),
    _sort: 'file_type:asc,file_name:asc',
  });

  const response = await fetch(
    buildApiUrl(QUARK_DRIVE_API_BASE, '/file/sort', query.toString()),
    {
      method: 'GET',
      headers: getQuarkHeaders(cookie),
    }
  );

  const data = await parseJson(response);
  ensureOk(data, '获取夸克目录列表失败');
  return data?.data?.list || [];
}

async function fetchAllDriveFolderItems(
  cookie,
  pdirFid = '0'
) {
  const allItems = [];
  const pageSize = 200;

  for (let page = 1; page < 100; page += 1) {
    const items = await fetchDriveFolderItems(cookie, pdirFid, page, pageSize);
    allItems.push(...items);

    if (items.length < pageSize) {
      break;
    }
  }

  return allItems;
}

function getDriveItemName(item) {
  return String(item?.file_name || item?.name || '');
}

function buildInstantPlayFolderName(pwdId, title) {
  const baseName = sanitizeFolderName(title || 'quark-temp') || 'quark-temp';
  return `${baseName}_${pwdId}`.slice(0, 120);
}

async function findDirectoryByName(
  cookie,
  parentFid,
  folderName
) {
  const items = await fetchAllDriveFolderItems(cookie, parentFid);
  return items.find(
    (item) => Boolean(item.dir || item.is_dir) && getDriveItemName(item) === folderName
  ) || null;
}

async function createDriveFolder(
  cookie,
  parentFid,
  folderName
) {
  const response = await fetch(buildApiUrl(QUARK_DRIVE_API_BASE, '/file'), {
    method: 'POST',
    headers: getQuarkHeaders(cookie),
    body: JSON.stringify({
      pdir_fid: parentFid,
      file_name: folderName,
      dir_path: '',
      dir_init_lock: false,
    }),
  });

  const data = await parseJson(response);
  ensureOk(data, `创建夸克目录失败：${folderName}`);

  const fid =
    data?.data?.fid ||
    data?.data?.file_id ||
    data?.metadata?.fid;

  if (!fid) {
    throw new Error(`夸克目录创建成功但未返回 fid：${folderName}`);
  }

  return String(fid);
}

async function ensureQuarkDrivePath(
  cookie,
  inputPath
) {
  const normalized = normalizePath(inputPath);
  if (normalized === '/') {
    return { fid: '0', path: normalized };
  }

  const segments = normalized.split('/').filter(Boolean);
  let currentFid = '0';
  let currentPath = '';

  for (const segment of segments) {
    const items = await fetchDriveFolderItems(cookie, currentFid);
    const existed = items.find(
      (item) =>
        Boolean(item.dir || item.is_dir) &&
        String(item.file_name || item.name || '') === segment
    );

    currentPath = joinPath(currentPath, segment);

    if (existed) {
      currentFid = String(existed.fid || existed.file_id);
      continue;
    }

    currentFid = await createDriveFolder(cookie, currentFid, segment);
  }

  return {
    fid: currentFid,
    path: currentPath || '/',
  };
}

async function collectShareItemsRecursive(
  cookie,
  pwdId,
  stoken,
  pdirFid = '0'
) {
  const items = await fetchShareFolderItems(cookie, pwdId, stoken, pdirFid);
  const result = [];

  for (const item of items) {
    if (item.dir) {
      const children = await collectShareItemsRecursive(
        cookie,
        pwdId,
        stoken,
        item.fid
      );
      result.push(...children);
    } else {
      result.push(item);
    }
  }

  return result;
}

function isVideoFile(fileName) {
  const lower = fileName.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function submitSaveTask(
  cookie,
  share,
  stoken,
  toPdirFid,
  items
) {
  if (items.length === 0) {
    throw new Error('没有可保存的文件');
  }

  const response = await fetch(
    buildApiUrl(QUARK_SHARE_API_BASE, '/share/sharepage/save'),
    {
      method: 'POST',
      headers: getQuarkHeaders(cookie),
      body: JSON.stringify({
        pwd_id: share.pwdId,
        stoken,
        pdir_fid: '0',
        to_pdir_fid: toPdirFid,
        scene: 'link',
        filelist: items.map((item) => item.fid),
        fid_list: items.map((item) => item.fid),
        fid_token_list: items.map((item) => item.shareFidToken || ''),
        share_fid_token_list: items.map((item) => item.shareFidToken || ''),
      }),
    }
  );

  const data = await parseJson(response);
  ensureOk(data, '提交夸克转存任务失败');
  return data?.data?.task_id ? String(data.data.task_id) : undefined;
}

async function pollTask(cookie, taskId) {
  for (let i = 0; i < 25; i += 1) {
    const query = new URLSearchParams({
      task_id: taskId,
      retry_index: String(i),
    });

    const response = await fetch(buildApiUrl(QUARK_SHARE_API_BASE, '/task', query.toString()), {
      method: 'GET',
      headers: getQuarkHeaders(cookie),
    });

    const data = await parseJson(response);
    ensureOk(data, '查询夸克任务状态失败');

    const task = data?.data || {};
    if (
      task?.status === 2 ||
      task?.status === 'finished' ||
      task?.status === 'success' ||
      task?.finished_at
    ) {
      return;
    }

    if (
      task?.status === -1 ||
      task?.status === 'failed' ||
      task?.err_code
    ) {
      throw new Error(task?.message || task?.err_msg || '夸克任务执行失败');
    }

    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  throw new Error('夸克任务处理超时');
}

async function createQuarkInstantPlayFolder(
  cookie,
  input
) {
  const safeCookie = normalizeQuarkCookie(cookie);
  const share = parseQuarkShareUrl(input.shareUrl, input.passcode);
  const { stoken, shareTitle } = await fetchShareToken(safeCookie, share);
  const allItems = await collectShareItemsRecursive(safeCookie, share.pwdId, stoken, '0');
  const videoItems = allItems.filter((item) => !item.dir && isVideoFile(item.fileName));

  if (videoItems.length === 0) {
    throw new Error('分享中没有可播放的视频文件');
  }

  const tempRoot = await ensureQuarkDrivePath(safeCookie, input.playTempSavePath);
  const folderName = buildInstantPlayFolderName(share.pwdId, input.title || shareTitle);
  const existedFolder = await findDirectoryByName(safeCookie, tempRoot.fid, folderName);

  if (existedFolder) {
    return {
      fileCount: videoItems.length,
      targetPath: joinPath(tempRoot.path, folderName),
      folderName,
      reused: true,
    };
  }

  const folderFid = await createDriveFolder(safeCookie, tempRoot.fid, folderName);
  const taskId = await submitSaveTask(safeCookie, share, stoken, folderFid, videoItems);

  if (taskId) {
    await pollTask(safeCookie, taskId);
  }

  const targetPath = joinPath(tempRoot.path, folderName);

  return {
    taskId,
    fileCount: videoItems.length,
    targetPath,
    folderName,
  };
}

function getBaseUrl(req) {
  const host = req.get('host') || 'localhost:7024';
  return `http://${host}`;
}

const logsDir = path.join(__dirname, 'logs');

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const cacheFile = path.join(logsDir, 'cache.json');
const invalidLinksFile = path.join(logsDir, 'invalid-links.json');

let cache = {};
let invalidLinks = {};

try {
  if (fs.existsSync(cacheFile)) {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
} catch (error) {
  console.error('加载缓存失败:', error.message);
}

try {
  if (fs.existsSync(invalidLinksFile)) {
    invalidLinks = JSON.parse(fs.readFileSync(invalidLinksFile, 'utf8'));
  }
} catch (error) {
  console.error('加载失效链接失败:', error.message);
}

function saveCache() {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.error('保存缓存失败:', error.message);
  }
}

function saveInvalidLinks() {
  try {
    fs.writeFileSync(invalidLinksFile, JSON.stringify(invalidLinks, null, 2));
  } catch (error) {
    console.error('保存失效链接失败:', error.message);
  }
}

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  console.log(message);
  
  const logFile = path.join(logsDir, 'app.log');
  fs.appendFileSync(logFile, logMessage);
  
  try {
    const stats = fs.statSync(logFile);
    if (stats.size > 10 * 1024 * 1024) {
      const backupFile = path.join(logsDir, `app-${Date.now()}.log`);
      fs.renameSync(logFile, backupFile);
    }
  } catch (error) {
    console.error('日志文件检查失败:', error.message);
  }
}

setInterval(async () => {
  const cookie = getQuarkCookie();
  if (!cookie) return;
  
  try {
    const quark = new QuarkDirectLink(cookie);
    const result = await quark.cleanSaveFolder();
    if (result.deleted > 0) {
      log(`定时清理: ${result.message}`);
    }
  } catch (error) {
    log(`定时清理失败: ${error.message}`);
  }
}, 24 * 60 * 60 * 1000);

const CHINESE_NUM_MAP = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10
};

function extractEpisodeNumber(filename) {
  if (!filename) return null;
  
  const name = filename.toLowerCase();
  
  const patterns = [
    /s\d+e(\d+)/i,
    /ep(\d+)/i,
    /第([一二三四五六七八九十\d]+)集/,
    /^(\d+)[\s\-_]/,
    /^(\d+)\./,
    /(\d+)\.(mp4|mkv|avi|wmv|flv|mov|m4v)$/,
    /ep(\d+)/i
  ];
  
  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (match) {
      const numStr = match[1];
      const num = CHINESE_NUM_MAP[numStr] || parseInt(numStr);
      if (!isNaN(num) && num > 0) {
        return num;
      }
    }
  }
  
  return null;
}

function extractEpisodeNumberDetail(filename) {
  if (!filename) return null;
  
  const name = filename.toLowerCase();
  
  const patterns = [
    /s\d+e(\d+)/i,
    /ep(\d+)/i,
    /第([一二三四五六七八九十\d]+)集/,
    /^\[.*?\]\s*(\d+)[\s\-_]/,
    /^(\d+)[\s\-_]/,
    /^(\d+)\./,
    /ep(\d+)/i
  ];
  
  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (match) {
      const numStr = match[1];
      const num = CHINESE_NUM_MAP[numStr] || parseInt(numStr);
      if (!isNaN(num) && num > 0) {
        return num;
      }
    }
  }
  
  return null;
}

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QuarkAPI 配置</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; min-height: 100vh; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; }
    h1 { text-align: center; color: #333; margin-bottom: 30px; }
    .card { background: white; border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .card h2 { font-size: 18px; color: #333; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #eee; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 14px; color: #666; margin-bottom: 8px; }
    .form-group input { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
    .form-group input:focus { outline: none; border-color: #1890ff; }
    .btn { display: inline-block; padding: 12px 24px; background: #1890ff; color: white; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; margin-right: 10px; }
    .btn:hover { background: #40a9ff; }
    .btn-secondary { background: #52c41a; }
    .btn-secondary:hover { background: #73d13d; }
    .btn-danger { background: #ff4d4f; }
    .btn-danger:hover { background: #ff7875; }
    .qr-container { text-align: center; padding: 20px; }
    .qr-container img { max-width: 200px; margin: 10px 0; }
    .status { padding: 12px; border-radius: 8px; margin-top: 16px; text-align: center; }
    .status.waiting { background: #fff7e6; color: #fa8c16; }
    .status.success { background: #f6ffed; color: #52c41a; }
    .status.error { background: #fff2f0; color: #ff4d4f; }
    .config-status { font-size: 12px; color: #999; margin-top: 8px; }
    .api-list { margin-top: 20px; }
    .api-item { padding: 12px; background: #fafafa; border-radius: 8px; margin-bottom: 10px; }
    .api-item code { color: #1890ff; font-size: 13px; }
    .api-item p { font-size: 12px; color: #666; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 QuarkAPI 配置</h1>
    
    <div class="card">
      <h2>📋 基础配置</h2>
      <div class="form-group">
        <label>盘搜地址</label>
        <input type="text" id="pansouHost" placeholder="https://pansou.example.com">
        <div class="config-status" id="pansouStatus"></div>
      </div>
      <button class="btn" onclick="saveConfig()">保存配置</button>
    </div>
    
    <div class="card">
      <h2>🔐 夸克登录</h2>
      <div class="form-group">
        <label>夸克Cookie (扫码自动获取)</label>
        <input type="text" id="quarkCookie" placeholder="扫码登录后自动填充">
        <div class="config-status" id="cookieStatus"></div>
      </div>
      <button class="btn btn-secondary" onclick="getQrCode()">扫二维码登录</button>
      <button class="btn btn-danger" onclick="clearCookie()">清除Cookie</button>
      
      <div class="qr-container" id="qrContainer" style="display:none;">
        <img id="qrImage" src="" alt="二维码">
        <div class="status waiting" id="qrStatus">等待扫码...</div>
      </div>
    </div>
    
    <div class="card">
      <h2>� OpenList 配置</h2>
      <div class="form-group">
        <label>OpenList地址</label>
        <input type="text" id="openlistUrl" placeholder="https://openlist.example.com">
        <div class="config-status" id="openlistUrlStatus"></div>
      </div>
      <div class="form-group">
        <label>OpenList用户名</label>
        <input type="text" id="openlistUsername" placeholder="admin">
        <div class="config-status" id="openlistUsernameStatus"></div>
      </div>
      <div class="form-group">
        <label>OpenList密码</label>
        <input type="password" id="openlistPassword" placeholder="********">
        <div class="config-status" id="openlistPasswordStatus"></div>
      </div>
    </div>
    
    <div class="card">
      <h2>📂 转存目录配置</h2>
      <div class="form-group">
        <label>夸克转存目录</label>
        <input type="text" id="quarkPlayTempSavePath" placeholder="请输入转存目录">
        <div class="config-status" id="quarkPlayTempSavePathStatus"></div>
      </div>
      <div class="form-group">
        <label>OpenList临时目录</label>
        <input type="text" id="openlistTempPath" placeholder="请输入临时目录">
        <div class="config-status" id="openlistTempPathStatus"></div>
      </div>
      <button class="btn" onclick="saveConfig()">保存配置</button>
    </div>
    
    <div class="card">
      <h2>� API 说明</h2>
      <div class="api-list">
        <div class="api-item">
          <code>GET /api/tvbox/drive/quark?ac=detail&amp;ids=分享链接</code>
          <p>获取分享链接详情</p>
        </div>
        <div class="api-item">
          <code>GET /api/quark/direct-link?url=分享链接</code>
          <p>获取直链列表</p>
        </div>
        <div class="api-item">
          <code>GET /api/quark/qrcode</code>
          <p>获取登录二维码</p>
        </div>
        <div class="api-item">
          <code>GET /api/quark/check-login?token=xxx</code>
          <p>检查登录状态</p>
        </div>
        <div class="api-item">
          <code>POST /api/quark/instant-play</code>
          <p>即时播放（转存到OpenList）</p>
        </div>
      </div>
    </div>
  </div>
  
  <script>
    let currentToken = null;
    let checkInterval = null;
    
    async function loadConfig() {
      try {
        const res = await fetch('/api/config');
        const data = await res.json();
        document.getElementById('pansouHost').value = data.pansouHost || '';
        document.getElementById('quarkCookie').value = data.quarkCookie || '';
        document.getElementById('openlistUrl').value = data.openlistUrl || '';
        document.getElementById('openlistUsername').value = data.openlistUsername || '';
        document.getElementById('openlistPassword').value = data.openlistPassword ? '' : '';
        document.getElementById('quarkPlayTempSavePath').value = data.quarkPlayTempSavePath || '';
        document.getElementById('openlistTempPath').value = data.openlistTempPath || '';
        
        if (data.pansouHost) document.getElementById('pansouStatus').textContent = '✓ 已配置';
        if (data.quarkCookie) document.getElementById('cookieStatus').textContent = '✓ 已配置';
        if (data.openlistUrl) document.getElementById('openlistUrlStatus').textContent = '✓ 已配置';
        if (data.openlistUsername) document.getElementById('openlistUsernameStatus').textContent = '✓ 已配置';
        if (data.openlistPassword) document.getElementById('openlistPasswordStatus').textContent = '✓ 已配置';
        if (data.quarkPlayTempSavePath) document.getElementById('quarkPlayTempSavePathStatus').textContent = '✓ 已配置';
        if (data.openlistTempPath) document.getElementById('openlistTempPathStatus').textContent = '✓ 已配置';
      } catch (e) {
        console.error('加载配置失败:', e);
      }
    }
    
    async function saveConfig() {
      const pansouHost = document.getElementById('pansouHost').value.trim();
      const quarkCookie = document.getElementById('quarkCookie').value.trim();
      const openlistUrl = document.getElementById('openlistUrl').value.trim();
      const openlistUsername = document.getElementById('openlistUsername').value.trim();
      const openlistPassword = document.getElementById('openlistPassword').value.trim();
      const quarkPlayTempSavePath = document.getElementById('quarkPlayTempSavePath').value.trim();
      const openlistTempPath = document.getElementById('openlistTempPath').value.trim();
      
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            pansouHost, 
            quarkCookie, 
            openlistUrl, 
            openlistUsername, 
            openlistPassword, 
            quarkPlayTempSavePath, 
            openlistTempPath 
          })
        });
        const data = await res.json();
        if (data.success) {
          alert('配置已保存！');
          location.reload();
        } else {
          alert('保存失败: ' + data.message);
        }
      } catch (e) {
        alert('保存失败: ' + e.message);
      }
    }
    
    async function getQrCode() {
      try {
        const res = await fetch('/api/quark/qrcode');
        const data = await res.json();
        
        if (data.success) {
          currentToken = data.token;
          document.getElementById('qrContainer').style.display = 'block';
          document.getElementById('qrImage').src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(data.qrUrl);
          document.getElementById('qrStatus').className = 'status waiting';
          document.getElementById('qrStatus').textContent = '请用夸克APP扫码...';
          
          if (checkInterval) clearInterval(checkInterval);
          checkInterval = setInterval(checkLogin, 2000);
        } else {
          alert('获取二维码失败: ' + data.message);
        }
      } catch (e) {
        alert('获取二维码失败: ' + e.message);
      }
    }
    
    async function checkLogin() {
      if (!currentToken) return;
      
      try {
        const res = await fetch('/api/quark/check-login?token=' + currentToken);
        const data = await res.json();
        
        if (data.status === 'success') {
          clearInterval(checkInterval);
          document.getElementById('qrStatus').className = 'status success';
          document.getElementById('qrStatus').textContent = '登录成功！';
          document.getElementById('quarkCookie').value = data.cookie;
          document.getElementById('cookieStatus').textContent = '✓ 已配置 - ' + data.nickname;
          
          setTimeout(() => {
            document.getElementById('qrContainer').style.display = 'none';
          }, 2000);
        } else if (data.status === 'expired') {
          clearInterval(checkInterval);
          document.getElementById('qrStatus').className = 'status error';
          document.getElementById('qrStatus').textContent = '二维码已过期，请重新获取';
        }
      } catch (e) {
        console.error('检查登录状态失败:', e);
      }
    }
    
    function clearCookie() {
      document.getElementById('quarkCookie').value = '';
      document.getElementById('cookieStatus').textContent = '';
      saveConfig();
    }
    
    loadConfig();
  </script>
</body>
</html>
  `);
});

app.get('/api/config', (req, res) => {
  res.json({
    pansouHost: getPansouHost(),
    quarkCookie: getQuarkCookie() ? '(已配置)' : '',
    openlistUrl: getOpenlistUrl(),
    openlistUsername: getOpenlistUsername(),
    openlistPassword: getOpenlistPassword() ? '(已配置)' : '',
    quarkPlayTempSavePath: getQuarkPlayTempSavePath(),
    openlistTempPath: getOpenlistTempPath()
  });
});

app.post('/api/config', (req, res) => {
  const { pansouHost, quarkCookie, openlistUrl, openlistUsername, openlistPassword, quarkPlayTempSavePath, openlistTempPath } = req.body;
  
  if (pansouHost !== undefined) config.pansouHost = pansouHost;
  if (quarkCookie !== undefined && quarkCookie !== '(已配置)') config.quarkCookie = quarkCookie;
  if (openlistUrl !== undefined) config.openlistUrl = openlistUrl;
  if (openlistUsername !== undefined) config.openlistUsername = openlistUsername;
  if (openlistPassword !== undefined && openlistPassword !== '(已配置)') config.openlistPassword = openlistPassword;
  if (quarkPlayTempSavePath !== undefined) config.quarkPlayTempSavePath = quarkPlayTempSavePath;
  if (openlistTempPath !== undefined) config.openlistTempPath = openlistTempPath;
  
  if (saveConfig(config)) {
    console.log('\n配置已更新:');
    console.log('  盘搜地址:', config.pansouHost || '(未配置)');
    console.log('  夸克Cookie:', config.quarkCookie ? '(已配置)' : '(未配置)');
    console.log('  OpenList地址:', config.openlistUrl || '(未配置)');
    console.log('  OpenList用户名:', config.openlistUsername || '(未配置)');
    console.log('  OpenList密码:', config.openlistPassword ? '(已配置)' : '(未配置)');
    console.log('  夸克转存目录:', config.quarkPlayTempSavePath || '/quark-temp');
    console.log('  OpenList临时目录:', config.openlistTempPath || '/quark-temp');
    res.json({ success: true, message: '配置已保存' });
  } else {
    res.status(500).json({ success: false, message: '保存配置失败' });
  }
});

app.post('/api/quark/instant-play', async (req, res) => {
  try {
    const { shareUrl, passcode, title } = req.body;
    
    if (!shareUrl) {
      return res.status(400).json({ error: '分享链接不能为空' });
    }

    const cookie = getQuarkCookie();
    if (!cookie) {
      return res.status(400).json({ error: '夸克网盘未配置，请先配置夸克Cookie' });
    }

    const openlistUrl = getOpenlistUrl();
    const openlistUsername = getOpenlistUsername();
    const openlistPassword = getOpenlistPassword();
    const quarkPlayTempSavePath = getQuarkPlayTempSavePath();
    const openlistTempPath = getOpenlistTempPath();

    if (!openlistUrl || !openlistUsername || !openlistPassword) {
      return res.status(400).json({ error: 'OpenList未配置，请先配置OpenList相关参数' });
    }

    if (!quarkPlayTempSavePath) {
      return res.status(400).json({ error: '夸克转存目录未配置，请先配置夸克转存目录' });
    }

    if (!openlistTempPath) {
      return res.status(400).json({ error: 'OpenList临时目录未配置，请先配置OpenList临时目录' });
    }

    const result = await createQuarkInstantPlayFolder(cookie, {
      shareUrl,
      passcode,
      playTempSavePath: quarkPlayTempSavePath,
      title,
    });

    if (!result.folderName) {
      throw new Error('未生成临时播放目录');
    }

    const openlistFolderPath = joinPath(
      openlistTempPath,
      result.folderName
    );

    try {
      const openListClient = new OpenListClient(openlistUrl, openlistUsername, openlistPassword);
      await openListClient.refreshDirectory(openlistTempPath);
      await openListClient.refreshDirectory(openlistFolderPath);
    } catch (refreshError) {
      console.warn('[quark instant-play] 刷新 OpenList 临时目录失败:', refreshError);
    }

    res.json({
      success: true,
      source: 'quark-temp',
      title: title || result.folderName,
      openlistFolderPath,
      ...result,
    });
  } catch (error) {
    console.error('[quark instant-play] 错误:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : '立即播放失败'
    });
  }
});

function combineCookies(...cookieStrings) {
  const cookieMap = new Map();
  
  cookieStrings.forEach(cookieStr => {
    if (!cookieStr) return;
    cookieStr.split(',').forEach(cookie => {
      const parts = cookie.split(';')[0].trim();
      const [name, ...valueParts] = parts.split('=');
      if (name && valueParts.length > 0) {
        cookieMap.set(name.trim(), valueParts.join('=').trim());
      }
    });
  });
  
  return Array.from(cookieMap.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

app.get('/api/quark/qrcode', async (req, res) => {
  try {
    const t = Date.now();
    const response = await fetch(`https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2&request_id=${t}`);
    const data = await response.json();
    
    if (data.data && data.data.members && data.data.members.token) {
      const token = data.data.members.token;
      const qrUrl = `https://su.quark.cn/4_eMHBJ?token=${token}&client_id=532&ssb=weblogin&uc_param_str=&uc_biz_str=S%3Acustom%7COPT%3ASAREA%400%7COPT%3AIMMERSIVE%401%7COPT%3ABACK_BTN_STYLE%400`;
      
      res.json({
        success: true,
        token: token,
        qrUrl: qrUrl,
        message: '请使用夸克APP扫码登录'
      });
    } else {
      res.status(500).json({ success: false, message: '获取二维码失败' });
    }
  } catch (error) {
    log(`获取二维码失败: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/quark/check-login', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.status(400).json({ success: false, message: '缺少token参数' });
    }
    
    const t = Date.now();
    const response = await fetch(
      `https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=532&v=1.2&token=${token}&request_id=${t}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
          'Referer': 'https://pan.quark.cn/'
        }
      }
    );
    
    const data = await response.json();
    const status = data.status;
    const message = data.message || '';
    
    if (status === 2000000) {
      const serviceTicket = data.data.members.service_ticket;
      
      const accountResponse = await fetch(`https://pan.quark.cn/account/info?st=${serviceTicket}&lw=scan`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch',
          'Referer': 'https://pan.quark.cn/'
        }
      });
      
      const cookies = accountResponse.headers.get('set-cookie') || '';
      const accountData = await accountResponse.json();
      
      const configResponse = await fetch('https://drive-pc.quark.cn/1/clouddrive/config?pr=ucpro&fr=pc&uc_param_str=', {
        headers: {
          'Cookie': cookies,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch',
          'Referer': 'https://pan.quark.cn/'
        }
      });
      
      const configCookies = configResponse.headers.get('set-cookie') || '';
      const allCookies = combineCookies(cookies, configCookies);
      
      config.quarkCookie = allCookies;
      saveConfig(config);
      console.log('\n夸克Cookie已自动保存');
      
      res.json({
        success: true,
        status: 'success',
        cookie: allCookies,
        nickname: accountData.data?.nickname || '',
        message: '登录成功'
      });
    } else if (status === 50004001) {
      res.json({
        success: false,
        status: 'waiting',
        message: '等待用户扫码...'
      });
    } else if (status === 50004002) {
      res.json({
        success: false,
        status: 'expired',
        message: '二维码已过期，请重新获取'
      });
    } else {
      res.json({
        success: false,
        status: 'error',
        message: message || '未知错误'
      });
    }
  } catch (error) {
    log(`检查登录状态失败: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/quark/direct-link', async (req, res) => {
  try {
    const { url, index, passcode } = req.query;
    
    if (!url) {
      return res.status(400).json({ success: false, message: '缺少分享链接' });
    }
    
    const cookie = getQuarkCookie();
    if (!cookie) {
      return res.status(400).json({ success: false, message: '未配置夸克Cookie，请先扫码登录' });
    }
    
    const quark = new QuarkDirectLink(cookie);
    
    if (index !== undefined) {
      const link = await quark.getSingleDirectLink(url, parseInt(index), passcode || '');
      res.json({
        success: true,
        data: link
      });
    } else {
      const links = await quark.getDirectLinks(url, passcode || '');
      res.json({
        success: true,
        data: links,
        total: links.length
      });
    }
  } catch (error) {
    log(`获取直链失败: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/quark/clean', async (req, res) => {
  try {
    const cookie = getQuarkCookie();
    if (!cookie) {
      return res.status(400).json({ success: false, message: '未配置夸克Cookie，请先扫码登录' });
    }
    
    const quark = new QuarkDirectLink(cookie);
    
    log('开始清理转存文件夹...');
    
    const result = await quark.cleanSaveFolder();
    
    log(`清理完成: ${result.message}`);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    log(`清理失败: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/tvbox/drive/quark', async (req, res) => {
  try {
    const { ac, ids } = req.query;
    
    if (ac === 'detail' && ids) {
      const cookie = getQuarkCookie();
      if (!cookie) {
        return res.json({
          code: 0,
          msg: '未配置夸克Cookie，请先扫码登录',
          list: []
        });
      }
      
      const quark = new QuarkDirectLink(cookie);
      const shareUrl = decodeURIComponent(ids);
      
      log(`获取分享详情: ${shareUrl}`);
      
      try {
        const shareInfo = await quark.getShareInfo(shareUrl);
        
        res.json({
          list: [shareInfo]
        });
      } catch (error) {
        log(`获取分享详情失败: ${error.message}`);
        res.json({
          code: 0,
          msg: error.message,
          list: []
        });
      }
    } else {
      res.json({
        code: 0,
        msg: '缺少参数',
        list: []
      });
    }
  } catch (error) {
    log(`tvbox接口错误: ${error.message}`);
    res.status(500).json({ code: 0, msg: error.message, list: [] });
  }
});

app.get('/play/:quarkUrl/:index', async (req, res) => {
  try {
    const { quarkUrl, index } = req.params;
    const decodedUrl = decodeURIComponent(quarkUrl);
    
    log(`收到播放请求: ${decodedUrl.substring(0, 50)}... 索引: ${index}`);
    
    const cookie = getQuarkCookie();
    if (!cookie) {
      return res.status(400).json({ error: '夸克网盘未配置，请先配置夸克Cookie' });
    }
    
    const openlistUrl = getOpenlistUrl();
    const openlistUsername = getOpenlistUsername();
    const openlistPassword = getOpenlistPassword();
    const quarkPlayTempSavePath = getQuarkPlayTempSavePath();
    const openlistTempPath = getOpenlistTempPath();
    
    if (!openlistUrl || !openlistUsername || !openlistPassword) {
      return res.status(400).json({ error: 'OpenList未配置，请先配置OpenList相关参数' });
    }
    
    if (!quarkPlayTempSavePath) {
      return res.status(400).json({ error: '夸克转存目录未配置，请先配置夸克转存目录' });
    }
    
    if (!openlistTempPath) {
      return res.status(400).json({ error: 'OpenList临时目录未配置，请先配置OpenList临时目录' });
    }
    
    const result = await createQuarkInstantPlayFolder(cookie, {
      shareUrl: decodedUrl,
      passcode: '',
      playTempSavePath: getQuarkPlayTempSavePath(),
      title: '',
    });
    
    if (!result.folderName) {
      throw new Error('未生成临时播放目录');
    }
    
    const openlistFolderPath = joinPath(
      getOpenlistTempPath(),
      result.folderName
    );
    
    const openListClient = new OpenListClient(openlistUrl, openlistUsername, openlistPassword);
    await openListClient.refreshDirectory(getOpenlistTempPath() || '/');
    await openListClient.refreshDirectory(openlistFolderPath);
    
    const files = await openListClient.listDirectory(openlistFolderPath);
    const videoFiles = files.filter(f => !f.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    
    if (videoFiles.length > 0 && videoFiles[index]) {
      const targetFile = videoFiles[index];
      const filePath = `${openlistFolderPath}/${targetFile.name}`;
      
      log(`获取播放地址: ${filePath.substring(0, 100)}...`);
      
      // 直接使用OpenList的直链
      const fileResponse = await openListClient.getFile(filePath);
      if (fileResponse.code === 200 && fileResponse.data?.raw_url) {
        log(`使用OpenList直链: ${fileResponse.data.raw_url.substring(0, 100)}...`);
        return res.redirect(fileResponse.data.raw_url);
      }
      
      throw new Error('未获取到有效的播放地址');
    } else {
      throw new Error('未在OpenList中找到对应的视频文件');
    }
  } catch (error) {
    log(`播放请求处理失败: ${error.message}`);
    return res.status(500).json({
      error: error.message
    });
  }
});

app.get('/api.php/provide/vod', async (req, res) => {
  try {
    const { ac, wd, ids } = req.query;
    
    if (ac === 'search') {
      if (!wd) {
        return res.json({
          code: 0,
          msg: '缺少搜索关键词',
          list: []
        });
      }
      
      const cacheKey = `search:${wd}`;
      const cachedResult = cache[cacheKey];
      
      if (cachedResult && Date.now() - cachedResult.timestamp < 3600000) {
        log(`使用搜索缓存: ${wd}`);
        return res.json(cachedResult.data);
      }
      
      const searchResponse = await fetch(PANSOU_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kw: wd,
          res: 'merge',
          limit: 10
        })
      });
      
      const searchData = await searchResponse.json();
      const vodList = [];
      
      if (searchData.data && searchData.data.merged_by_type && searchData.data.merged_by_type.quark) {
        const allItems = searchData.data.merged_by_type.quark;
        const maxValidItems = 5;
        const checkConcurrency = 10;
        
        log(`搜索到 ${allItems.length} 个结果，开始并行验证（并发数: ${checkConcurrency}）...`);
        
        const quark = getQuarkInstance();
        if (!quark) {
          return res.json({
            code: 0,
            msg: '未配置夸克Cookie，请先在首页扫码登录',
            list: []
          });
        }
        
        const checkItem = async (item, index) => {
          const cleanUrl = (item.url || '').trim().replace(/^`|`$/g, '');
          
          if (invalidLinks[cleanUrl]) {
            log(`跳过失效链接: ${cleanUrl.substring(0, 40)}...`);
            return null;
          }
          
          try {
            const shareInfo = await quark.getShareInfo(cleanUrl);
            const playUrl = shareInfo.vod_play_url || '';
            
            if (playUrl) {
              const videos = playUrl.split('#').filter(v => v.trim());
              if (videos.length > 0) {
                log(`有效[${index}]: ${cleanUrl.substring(0, 40)}... (${videos.length}个视频)`);
                return { item, videoCount: videos.length, playUrl };
              } else {
                invalidLinks[cleanUrl] = Date.now();
                log(`失效[${index}]: ${cleanUrl.substring(0, 40)}... (无视频)`);
                return null;
              }
            } else {
              invalidLinks[cleanUrl] = Date.now();
              log(`失效[${index}]: ${cleanUrl.substring(0, 40)}... (无播放地址)`);
              return null;
            }
          } catch (error) {
            invalidLinks[cleanUrl] = Date.now();
            log(`失效[${index}]: ${cleanUrl.substring(0, 40)}... (${error.message})`);
            return null;
          }
        };
        
        const validItems = [];
        const validPlayUrls = [];
        const itemsToCheck = allItems.slice(0, Math.min(allItems.length, checkConcurrency * 2));
        
        const checkPromises = itemsToCheck.map((item, index) => checkItem(item, index));
        const results = await Promise.all(checkPromises);
        
        for (const result of results) {
          if (result && validItems.length < maxValidItems) {
            validItems.push(result.item);
            validPlayUrls.push(result.playUrl);
          }
        }
        
        saveInvalidLinks();
        log(`验证完成，找到 ${validItems.length} 个有效网盘`);
        
        const firstPlayUrl = validPlayUrls[0] || '';
        
        let isMovie = true;
        
        if (firstPlayUrl) {
          const videos = firstPlayUrl.split('#').filter(v => v.trim());
          log(`识别检查: 共 ${videos.length} 个视频`);
          for (const video of videos) {
            const [name] = video.split('$');
            const cleanName = name.replace(/^\[.*?\]\s*/, '');
            const episodeNum = extractEpisodeNumberDetail(cleanName);
            log(`识别检查: ${cleanName.substring(0, 50)}... 集数: ${episodeNum}`);
            if (episodeNum !== null) {
              isMovie = false;
              break;
            }
          }
        }
        
        log(`识别为${isMovie ? '电影' : '剧集'}`);
        
        const quarkPlayUrls = [];
        
        log(`开始获取 ${validItems.length} 个网盘的详情`);
        
        for (let i = 0; i < validItems.length; i++) {
          const item = validItems[i];
          const cleanUrl = (item.url || '').trim().replace(/^`|`$/g, '');
          
          log(`处理第 ${i + 1}/${validItems.length} 个网盘: ${cleanUrl.substring(0, 40)}...`);
          
          try {
            const shareInfo = await quark.getShareInfo(cleanUrl);
            const playUrl = shareInfo.vod_play_url || '';
            log(`获取到播放地址，长度: ${playUrl.length}`);
            quarkPlayUrls.push({
              quarkUrl: cleanUrl,
              playUrl: playUrl
            });
          } catch (error) {
            log(`获取详情失败: ${error.message}`);
            quarkPlayUrls.push({
              quarkUrl: cleanUrl,
              playUrl: ''
            });
          }
        }
        
        log(`网盘详情获取完成，共 ${quarkPlayUrls.length} 个有效网盘`);
        
        const allUrls = validItems.map(item => (item.url || '').trim().replace(/^`|`$/g, ''));
        
        cache[`${cacheKey}:all`] = {
          timestamp: Date.now(),
          data: allUrls,
          isMovie: isMovie,
          quarkPlayUrls: quarkPlayUrls
        };
        
        log(`保存缓存: ${cacheKey}:all, isMovie: ${isMovie}`);
        saveCache();
        
        for (let i = 0; i < validItems.length; i++) {
          const item = validItems[i];
          const cleanUrl = (item.url || '').trim().replace(/^`|`$/g, '');
          
          const baseItem = {
            vod_id: cleanUrl,
            vod_name: (item.note || wd).trim(),
            vod_pic: (item.images?.[0] || '').trim().replace(/^`|`$/g, ''),
            vod_remarks: item.datetime || '',
            vod_play_from: 'quark',
            vod_password: (item.password || '').trim()
          };
          
          try {
            const shareInfo = await quark.getShareInfo(cleanUrl);
            const playUrl = shareInfo.vod_play_url || '';
            
            if (playUrl) {
              const videos = playUrl.split('#').filter(v => v.trim());
              const videoCount = videos.length;
              
              const baseUrl = getBaseUrl(req);
              const fakePlayUrls = videos.map((v, idx) => {
                const parts = v.split('$');
                const name = parts[0] || `视频${idx + 1}`;
                return `${name}$${baseUrl}/play/${encodeURIComponent(cleanUrl)}/${idx}`;
              }).join('#');
              
              const resultItem = {
                ...baseItem,
                vod_play_url: fakePlayUrls,
                vod_remarks: `${item.datetime || ''} (${videoCount}个视频)`
              };
              vodList.push(resultItem);
            }
          } catch (error) {
            log(`获取详情失败: ${error.message}`);
          }
        }
        
        const baseUrl = getBaseUrl(req);
        const allItem = {
          vod_id: `all:${wd}`,
          vod_name: `${wd}`,
          vod_pic: '',
          vod_remarks: `共${validItems.length}个网盘`,
          vod_play_from: 'quark',
          vod_password: '',
          vod_play_url: `${wd}.1080p.mp4$${baseUrl}/api.php/provide/vod?ac=detail&ids=all:${wd}`
        };
        
        vodList.unshift(allItem);
      }
      
      const result = {
        code: 1,
        msg: '数据列表',
        page: 1,
        pagecount: 1,
        limit: 10,
        total: vodList.length,
        list: vodList
      };
      
      cache[cacheKey] = {
        timestamp: Date.now(),
        data: result
      };
      saveCache();
      
      return res.json(result);
      
    } else if (ac === 'detail') {
      if (!ids) {
        return res.json({
          code: 0,
          msg: '缺少ID',
          list: []
        });
      }
      
      if (ids.startsWith('all:')) {
        const searchKeyword = ids.substring(4);
        const cacheKey = `search:${searchKeyword}`;
        const cachedResult = cache[`${cacheKey}:all`];
        
        log(`读取缓存: ${cacheKey}:all, isMovie: ${cachedResult?.isMovie}`);
        
        if (!cachedResult) {
          return res.json({
            code: 0,
            msg: '未找到搜索结果',
            list: []
          });
        }
        
        const allUrls = cachedResult.data;
        const isMovie = cachedResult.isMovie !== undefined ? cachedResult.isMovie : true;
        const quarkPlayUrls = cachedResult.quarkPlayUrls || [];
        
        log(`获取所有网盘直链，共 ${allUrls.length} 个网盘，类型: ${isMovie ? '电影' : '剧集'}`);
        log(`quarkPlayUrls 数量: ${quarkPlayUrls.length}`);
        
        let sortedEpisodes;
        const allMovieLinks = [];
        
        if (isMovie) {
          log(`进入电影分支`);
          
          // 不再获取原始直链，全部使用构造的OpenList播放地址
          log(`跳过所有直链获取，全部使用构造的播放地址`);
          
          const baseUrl = getBaseUrl(req);
          const allPlayUrls = [];
          
          for (let i = 0; i < allUrls.length; i++) {
            const cleanUrl = allUrls[i];
            log(`处理第 ${i + 1}/${allUrls.length} 个网盘: ${cleanUrl.substring(0, 40)}...`);
            
            try {
              const quark = getQuarkInstance();
              if (!quark) continue;
              
              const shareInfo = await quark.getShareInfo(cleanUrl);
              const playUrl = shareInfo.vod_play_url || '';
              
              if (playUrl) {
                const videos = playUrl.split('#').filter(v => v.trim());
                if (videos.length > 0) {
                  const moviePlayUrls = videos.map((v, idx) => {
                    const parts = v.split('
          log(`进入剧集分支`);
          let episodeMap = new Map();
          
          log(`开始遍历 quarkPlayUrls`);
          for (const quarkPlay of quarkPlayUrls) {
            const { quarkUrl, playUrl } = quarkPlay;
            
            log(`处理网盘: ${quarkUrl.substring(0, 40)}..., playUrl 长度: ${playUrl ? playUrl.length : 0}`);
            
            if (!playUrl) {
              log(`跳过空 playUrl`);
              continue;
            }
            
            const videos = playUrl.split('#').filter(v => v.trim());
            log(`找到 ${videos.length} 个视频`);
            
            // 为每个视频创建独立条目，同一集的后续版本自动添加编号
            for (const video of videos) {
              const [name] = video.split('$');
              const episodeNum = extractEpisodeNumberDetail(name);
              
              if (episodeNum !== null) {
                // 只统计当前网盘下的该集数条目
                const existingEntries = Array.from(episodeMap.entries())
                  .filter(([key, data]) => data.quarkUrl === quarkUrl && data.episodeNum === episodeNum);
                
                const version = existingEntries.length + 1;
                const key = `${quarkUrl}:${name}`;
                if (!episodeMap.has(key)) {
                  episodeMap.set(key, {
                    firstEpisodeUrl: null,
                    quarkUrl: quarkUrl,
                    episodeNum: episodeNum,
                    version: version
                  });
                  log(`添加集数: ${episodeNum} 版本${version} (网盘: ${quarkUrl.substring(0, 40)}...)`);
                }
              }
            }
          }
          
          log(`episodeMap 大小: ${episodeMap.size}`);
          
          // 不再获取任何直链，全部使用构造的播放地址
          log(`跳过所有直链获取，全部使用构造的播放地址`);
          
          log(`开始构建播放地址`);
          const baseUrl = getBaseUrl(req);
          // 为每个网盘构建独立的播放地址
          const uniqueQuarkUrls = new Set();
          episodeMap.forEach(data => uniqueQuarkUrls.add(data.quarkUrl));
          
          const allPlayUrls = [];
          
          for (const quarkUrl of uniqueQuarkUrls) {
            const episodesForQuark = Array.from(episodeMap.entries())
              .filter(([_, data]) => data.quarkUrl === quarkUrl)
              .sort((a, b) => a[1].episodeNum - b[1].episodeNum)
              .map(([_, data]) => {
                  const paddedNum = data.episodeNum.toString().padStart(2, '0');
                  // 保留原始集名，不修改
                if (data.version === 1) {
                  return `第${paddedNum}集$${baseUrl}/api.php/provide/vod/play?quarkUrl=${encodeURIComponent(data.quarkUrl)}&episode=${data.episodeNum}`;
                } else {
                  return `第${paddedNum}集$${baseUrl}/api.php/provide/vod/play?quarkUrl=${encodeURIComponent(data.quarkUrl)}&episode=${data.episodeNum}&version=${data.version}`;
                }
                });
            
            allPlayUrls.push(episodesForQuark.join('#'));
          }
          
          sortedEpisodes = allPlayUrls.join('$$$');
          log(`构建播放地址完成，共 ${uniqueQuarkUrls.size} 个网盘，${episodeMap.size} 个集数`);
          log(`共获取 ${uniqueQuarkUrls.size} 个网盘资源`);
        }
        
        if (isMovie) {
          log(`共获取 ${allMovieLinks?.length || 0} 个电影资源`);
        }
        
        return res.json({
          code: 1,
          msg: '数据详情',
          list: [{
            vod_id: ids,
            vod_play_from: 'quark',
            vod_play_url: sortedEpisodes
          }]
        });
      }
      
      let quarkUrl = ids;
      
      if (ids.includes('/play/')) {
        quarkUrl = ids.split('/play/')[1].split('/')[0];
        quarkUrl = decodeURIComponent(quarkUrl);
      }
      
      const directLinks = await getDirectLink(quarkUrl, false);
      
      const episodeMap = new Map();
      let hasVideoCodec = false;
      
      directLinks.forEach(item => {
        const name = item.name.toLowerCase();
        if (name.includes('264') || name.includes('265') || name.includes('hevc') || name.includes('avc')) {
          hasVideoCodec = true;
        }
        const episodeNum = extractEpisodeNumberDetail(item.name);
        if (episodeNum !== null) {
          if (!episodeMap.has(episodeNum)) {
            episodeMap.set(episodeNum, item.url);
          }
        }
      });
      
      let playUrls;
      
      if (hasVideoCodec || episodeMap.size <= 1) {
        playUrls = directLinks.map(item => `${item.name}$${item.url}`).join('#');
      } else {
        playUrls = Array.from(episodeMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([episodeNum, url]) => {
            const paddedNum = episodeNum.toString().padStart(2, '0');
            return `第${paddedNum}集$${url}`;
          })
          .join('#');
      }
      
      return res.json({
        code: 1,
        msg: '数据详情',
        list: [{
          vod_id: ids,
          vod_play_from: 'quark',
          vod_play_url: playUrls
        }]
      });
    }
    
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: '缺少ac参数',
        list: []
      });
    }
    
  } catch (error) {
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        list: []
      });
    }
  }
});

app.get('/api.php/provide/vod/play', async (req, res) => {
  try {
    const { quarkUrl, episode, version = 1 } = req.query;
    
    if (!quarkUrl || !episode) {
      return res.status(400).send('缺少参数');
    }
    
    log(`收到播放请求: ${quarkUrl.substring(0, 40)}... 集数: ${episode} 版本: ${version}`);
    
    const cookie = getQuarkCookie();
    if (!cookie) {
      return res.status(400).send('夸克网盘未配置，请先配置夸克Cookie');
    }
    
    const openlistUrl = getOpenlistUrl();
    const openlistUsername = getOpenlistUsername();
    const openlistPassword = getOpenlistPassword();
    const quarkPlayTempSavePath = getQuarkPlayTempSavePath();
    const openlistTempPath = getOpenlistTempPath();
    
    if (!openlistUrl || !openlistUsername || !openlistPassword) {
      return res.status(400).send('OpenList未配置，请先配置OpenList相关参数');
    }
    
    if (!quarkPlayTempSavePath) {
      return res.status(400).send('夸克转存目录未配置，请先配置夸克转存目录');
    }
    
    if (!openlistTempPath) {
      return res.status(400).send('OpenList临时目录未配置，请先配置OpenList临时目录');
    }
    
    const result = await createQuarkInstantPlayFolder(cookie, {
      shareUrl: quarkUrl,
      passcode: '',
      playTempSavePath: getQuarkPlayTempSavePath(),
      title: '',
    });
    
    if (!result.folderName) {
      throw new Error('未生成临时播放目录');
    }
    
    const openlistFolderPath = joinPath(
      getOpenlistTempPath(),
      result.folderName
    );
    
    const openListClient = new OpenListClient(openlistUrl, openlistUsername, openlistPassword);
    await openListClient.refreshDirectory(getOpenlistTempPath() || '/');
    await openListClient.refreshDirectory(openlistFolderPath);
    
    const files = await openListClient.listDirectory(openlistFolderPath);
    const videoFiles = files.filter(f => !f.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    
    const targetEpisodeNum = parseInt(episode);
    const matchedFile = videoFiles.find(f => {
      const epNum = extractEpisodeNumberDetail(f.name);
      return epNum === targetEpisodeNum;
    });
    
    if (matchedFile) {
      const filePath = `${openlistFolderPath}/${matchedFile.name}`;
      
      log(`获取播放地址: ${filePath.substring(0, 100)}...`);
      
      // 直接使用OpenList的直链
      const fileResponse = await openListClient.getFile(filePath);
      if (fileResponse.code === 200 && fileResponse.data?.raw_url) {
        log(`使用OpenList直链: ${fileResponse.data.raw_url.substring(0, 100)}...`);
        return res.redirect(fileResponse.data.raw_url);
      }
      
      throw new Error('未获取到有效的播放地址');
    } else {
      throw new Error('未在OpenList中找到对应的视频文件');
    }
  } catch (error) {
    log(`播放请求失败: ${error.message}`);
    if (!res.headersSent) {
      return res.status(500).send(error.message);
    }
  }
});

app.post('/api.php/provide/vod/play', async (req, res) => {
  try {
    const { quarkUrl, episode, version = 1 } = req.body;
    
    if (!quarkUrl || !episode) {
      return res.json({
        code: 0,
        msg: '缺少参数',
        url: ''
      });
    }
    
    log(`收到播放请求: ${quarkUrl.substring(0, 40)}... 集数: ${episode} 版本: ${version}`);
    
    const cookie = getQuarkCookie();
    if (!cookie) {
      return res.json({
        code: 0,
        msg: '夸克网盘未配置，请先配置夸克Cookie',
        url: ''
      });
    }
    
    const openlistUrl = getOpenlistUrl();
    const openlistUsername = getOpenlistUsername();
    const openlistPassword = getOpenlistPassword();
    const quarkPlayTempSavePath = getQuarkPlayTempSavePath();
    const openlistTempPath = getOpenlistTempPath();
    
    if (!openlistUrl || !openlistUsername || !openlistPassword) {
      return res.json({
        code: 0,
        msg: 'OpenList未配置，请先配置OpenList相关参数',
        url: ''
      });
    }
    
    if (!quarkPlayTempSavePath) {
      return res.json({
        code: 0,
        msg: '夸克转存目录未配置，请先配置夸克转存目录',
        url: ''
      });
    }
    
    if (!openlistTempPath) {
      return res.json({
        code: 0,
        msg: 'OpenList临时目录未配置，请先配置OpenList临时目录',
        url: ''
      });
    }
    
    const result = await createQuarkInstantPlayFolder(cookie, {
      shareUrl: quarkUrl,
      passcode: '',
      playTempSavePath: getQuarkPlayTempSavePath(),
      title: '',
    });
    
    if (!result.folderName) {
      throw new Error('未生成临时播放目录');
    }
    
    const openlistFolderPath = joinPath(
      getOpenlistTempPath(),
      result.folderName
    );
    
    const openListClient = new OpenListClient(openlistUrl, openlistUsername, openlistPassword);
    await openListClient.refreshDirectory(getOpenlistTempPath() || '/');
    await openListClient.refreshDirectory(openlistFolderPath);
    
    const files = await openListClient.listDirectory(openlistFolderPath);
    const videoFiles = files.filter(f => !f.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    
    const targetEpisodeNum = parseInt(episode);
    const matchedFile = videoFiles.find(f => {
      const epNum = extractEpisodeNumberDetail(f.name);
      return epNum === targetEpisodeNum;
    });
    
    if (matchedFile) {
      const filePath = `${openlistFolderPath}/${matchedFile.name}`;
      
      log(`获取播放地址: ${filePath.substring(0, 100)}...`);
      
      // 直接使用OpenList的直链
      const fileResponse = await openListClient.getFile(filePath);
      let playUrl = '';
      if (fileResponse.code === 200 && fileResponse.data?.raw_url) {
        log(`使用OpenList直链: ${fileResponse.data.raw_url.substring(0, 100)}...`);
        playUrl = fileResponse.data.raw_url;
      }
      
      if (!playUrl) {
        throw new Error('未获取到有效的播放地址');
      }
      
      log(`返回播放地址: ${playUrl.substring(0, 100)}...`);
      return res.json({
        code: 1,
        msg: '播放地址',
        url: playUrl
      });
    } else {
      throw new Error('未在OpenList中找到对应的视频文件');
    }
  } catch (error) {
    log(`播放请求失败: ${error.message}`);
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        url: ''
      });
    }
  }
});

app.post('/vod/search', async (req, res) => {
  const vodList = [];
  
  try {
    const { wd } = req.body;
    
    if (!wd) {
      return res.json({
        code: 0,
        msg: '缺少搜索关键词',
        list: []
      });
    }
    
    const cacheKey = `search:${wd}`;
    const cachedResult = cache[cacheKey];
    
    if (cachedResult && Date.now() - cachedResult.timestamp < 3600000) {
      log(`使用搜索缓存: ${wd}`);
      return res.json(cachedResult.data);
    }
    
    const searchResponse = await fetch(PANSOU_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kw: wd,
        res: 'merge',
        limit: 10
      })
    });
    
    const searchData = await searchResponse.json();
    
    if (searchData.data && searchData.data.merged_by_type && searchData.data.merged_by_type.quark) {
      const allItems = searchData.data.merged_by_type.quark;
      const maxValidItems = 5;
      const checkConcurrency = 10;
      
      log(`搜索到 ${allItems.length} 个结果，开始并行验证（并发数: ${checkConcurrency}）...`);
      
      const quark = getQuarkInstance();
      if (!quark) {
        return res.json({
          code: 0,
          msg: '未配置夸克Cookie，请先在首页扫码登录',
          list: []
        });
      }
      
      const checkItem = async (item, index) => {
        const cleanUrl = (item.url || '').trim().replace(/^`|`$/g, '');
        
        if (invalidLinks[cleanUrl]) {
          log(`跳过失效链接: ${cleanUrl.substring(0, 40)}...`);
          return null;
        }
        
        try {
          const shareInfo = await quark.getShareInfo(cleanUrl);
          const playUrl = shareInfo.vod_play_url || '';
          
          if (playUrl) {
            const videos = playUrl.split('#').filter(v => v.trim());
            if (videos.length > 0) {
              log(`有效[${index}]: ${cleanUrl.substring(0, 40)}... (${videos.length}个视频)`);
              return { item, videoCount: videos.length, playUrl };
            } else {
              invalidLinks[cleanUrl] = Date.now();
              log(`失效[${index}]: ${cleanUrl.substring(0, 40)}... (无视频)`);
              return null;
            }
          } else {
            invalidLinks[cleanUrl] = Date.now();
            log(`失效[${index}]: ${cleanUrl.substring(0, 40)}... (无播放地址)`);
            return null;
          }
        } catch (error) {
          invalidLinks[cleanUrl] = Date.now();
          log(`失效[${index}]: ${cleanUrl.substring(0, 40)}... (${error.message})`);
          return null;
        }
      };
      
      const validItems = [];
      const validPlayUrls = [];
      const itemsToCheck = allItems.slice(0, Math.min(allItems.length, checkConcurrency * 2));
      
      const checkPromises = itemsToCheck.map((item, index) => checkItem(item, index));
      const results = await Promise.all(checkPromises);
      
      for (const result of results) {
        if (result && validItems.length < maxValidItems) {
          validItems.push(result.item);
          validPlayUrls.push(result.playUrl);
        }
      }
      
      saveInvalidLinks();
      log(`验证完成，找到 ${validItems.length} 个有效网盘`);
      
      for (let i = 0; i < validItems.length; i++) {
        const item = validItems[i];
        const cleanUrl = (item.url || '').trim().replace(/^`|`$/g, '');
        const playUrl = validPlayUrls[i] || '';
        
        const baseItem = {
          vod_id: cleanUrl,
          vod_name: (item.note || wd).trim(),
          vod_pic: (item.images?.[0] || '').trim().replace(/^`|`$/g, ''),
          vod_remarks: item.datetime || '',
          vod_play_from: 'quark',
          vod_password: (item.password || '').trim()
        };
        
        if (playUrl) {
          const videos = playUrl.split('#').filter(v => v.trim());
          const videoCount = videos.length;
          
          const baseUrl = getBaseUrl(req);
          const fakePlayUrls = videos.map((v, idx) => {
            const parts = v.split('$');
            const name = parts[0] || `视频${idx + 1}`;
            return `${name}$${baseUrl}/play/${encodeURIComponent(cleanUrl)}/${idx}`;
          }).join('#');
          
          const resultItem = {
            ...baseItem,
            vod_play_url: fakePlayUrls,
            vod_remarks: `${item.datetime || ''} (${videoCount}个视频)`
          };
          vodList.push(resultItem);
        }
      }
      
      const allUrls = validItems.map(item => (item.url || '').trim().replace(/^`|`$/g, ''));
      
      const baseUrl = getBaseUrl(req);
      const allItem = {
        vod_id: `all:${wd}`,
        vod_name: `${wd}`,
        vod_pic: '',
        vod_remarks: `共${validItems.length}个网盘`,
        vod_play_from: 'quark',
        vod_password: '',
        vod_play_url: `${wd}.1080p.mp4$${baseUrl}/api.php/provide/vod?ac=detail&ids=all:${wd}`
      };
      
      vodList.unshift(allItem);
      
      cache[`${cacheKey}:all`] = {
        timestamp: Date.now(),
        data: allUrls
      };
      saveCache();
    }
    
    const result = {
      code: 1,
      msg: '数据列表',
      page: 1,
      pagecount: 1,
      limit: 10,
      total: vodList.length,
      list: vodList
    };
    
    cache[cacheKey] = {
      timestamp: Date.now(),
      data: result
    };
    saveCache();
    
    return res.json(result);
    
  } catch (error) {
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        list: []
      });
    }
  }
});

app.post('/vod/detail', async (req, res) => {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.json({
        code: 0,
        msg: '缺少ID',
        list: []
      });
    }
    
    const directLinks = await getDirectLink(id, true, true, req);
    
    return res.json({
      code: 1,
      msg: '数据详情',
      list: [{
        vod_id: id,
        vod_play_from: 'quark',
        vod_play_url: `播放$${directLinks}`
      }]
    });
    
  } catch (error) {
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        list: []
      });
    }
  }
});

app.post('/vod/play', async (req, res) => {
  try {
    const { id } = req.body;
    
    log('收到播放请求，ID:', id);
    
    if (!id) {
      return res.json({
        code: 0,
        msg: '缺少ID',
        url: '',
        parse: 0
      });
    }
    
    log('开始获取直链...');
    const directUrl = await getDirectLink(id, true, true, req);
    log('获取到的直链:', directUrl);
    
    res.json({
      code: 1,
      msg: '播放地址',
      url: directUrl,
      parse: 0
    });
    
  } catch (error) {
    log('播放请求处理失败:', error);
    res.json({
      code: 0,
      msg: error.message,
      url: '',
      parse: 0
    });
  }
});

app.post('/vod/playpage', async (req, res) => {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.json({
        code: 0,
        msg: '缺少ID',
        playPage: ''
      });
    }
    
    const quarkUrl = id.replace('quark_', '');
    const directLinks = await getDirectLink(quarkUrl, false, true, req);
    
    if (directLinks && directLinks.length > 0) {
      res.json({
        code: 1,
        msg: '播放页面',
        playPage: directLinks[0].url,
        parse: 1
      });
    } else {
      res.json({
        code: 0,
        msg: '未找到直链',
        playPage: ''
      });
    }
    
  } catch (error) {
    res.json({
      code: 0,
      msg: error.message,
      playPage: ''
    });
  }
});

async function getDirectLink(id, limit = true, useProxy = false, req = null) {
  try {
    const quarkUrl = id.startsWith('http') ? id : id.replace('quark_', '');
    
    const cacheKey = `direct:${quarkUrl}`;
    const cachedResult = cache[cacheKey];
    
    if (cachedResult && Date.now() - cachedResult.timestamp < 3600000) {
      log(`使用缓存直链: ${quarkUrl.substring(0, 40)}...`);
      if (useProxy && req) {
        const baseUrl = getBaseUrl(req);
        return cachedResult.data.map(link => ({
          ...link,
          url: `${baseUrl}/proxy/play?url=${encodeURIComponent(link.url)}`
        }));
      }
      return cachedResult.data;
    }
    
    log(`获取直链: ${quarkUrl.substring(0, 40)}...`);
    
    const quark = getQuarkInstance();
    if (!quark) {
      log(`未配置夸克Cookie`);
      return [];
    }
    
    try {
      const links = await quark.getDirectLinks(quarkUrl);
      
      if (!links || links.length === 0) {
        log(`未找到视频文件: ${quarkUrl.substring(0, 40)}...`);
        return [];
      }
      
      const maxVideos = limit ? 10 : links.length;
      const limitedLinks = links.slice(0, maxVideos);
      
      log(`找到 ${links.length} 个视频，限制为前 ${limitedLinks.length} 个`);
      
      const directLinks = limitedLinks.map((link, idx) => ({
        url: link.downloadUrl,
        name: link.fileName,
        fid: link.fid
      }));
      
      cache[cacheKey] = {
        timestamp: Date.now(),
        data: directLinks,
        rawLinks: limitedLinks
      };
      saveCache();
      
      log(`成功获取 ${directLinks.length} 个直链`);
      
      if (useProxy && req) {
        const baseUrl = getBaseUrl(req);
        return directLinks.map(link => ({
          ...link,
          url: `${baseUrl}/proxy/play?url=${encodeURIComponent(link.url)}`
        }));
      }
      
      return directLinks;
      
    } catch (error) {
      log(`获取直链失败: ${error.message}`);
      return [];
    }
    
  } catch (error) {
    log(`获取直链异常: ${error.message}`);
    return [];
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/proxy/play', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).send('缺少 url 参数');
    }
    
    const decodedUrl = decodeURIComponent(url);
    log(`代理播放请求: ${decodedUrl.substring(0, 80)}...`);
    
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    };
    
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
      log(`转发Range请求: ${req.headers.range}`);
    }
    
    const response = await fetch(decodedUrl, {
      headers: headers
    });
    
    log(`响应状态: ${response.status}`);
    
    if (!response.ok && response.status !== 206) {
      log(`代理请求失败: ${response.status}`);
      return res.status(response.status).send('请求失败');
    }
    
    const ignoreResponseHeaders = ['set-cookie', 'transfer-encoding'];
    for (const [key, value] of response.headers.entries()) {
      if (!ignoreResponseHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }
    
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (response.status === 206) {
      res.status(206);
    }
    
    response.body.pipe(res);
    
  } catch (error) {
    log(`代理播放失败: ${error.message}`);
    res.status(500).send(error.message);
  }
});

app.listen(PORT, () => {
  console.log(`VOD API Server running on port ${PORT}`);
}););
                    const name = parts[0] || `电影${i + 1}-${idx + 1}`;
                    return `${name}${baseUrl}/play/${encodeURIComponent(cleanUrl)}/${idx}`;
                  }).join('#');
                  allPlayUrls.push(moviePlayUrls);
                }
              }
            } catch (error) {
              log(`处理网盘失败: ${error.message}`);
            }
          }
          
          sortedEpisodes = allPlayUrls.join('$
          log(`进入剧集分支`);
          let episodeMap = new Map();
          
          log(`开始遍历 quarkPlayUrls`);
          for (const quarkPlay of quarkPlayUrls) {
            const { quarkUrl, playUrl } = quarkPlay;
            
            log(`处理网盘: ${quarkUrl.substring(0, 40)}..., playUrl 长度: ${playUrl ? playUrl.length : 0}`);
            
            if (!playUrl) {
              log(`跳过空 playUrl`);
              continue;
            }
            
            const videos = playUrl.split('#').filter(v => v.trim());
            log(`找到 ${videos.length} 个视频`);
            
            // 为每个视频创建独立条目，同一集的后续版本自动添加编号
            for (const video of videos) {
              const [name] = video.split('$');
              const episodeNum = extractEpisodeNumberDetail(name);
              
              if (episodeNum !== null) {
                // 只统计当前网盘下的该集数条目
                const existingEntries = Array.from(episodeMap.entries())
                  .filter(([key, data]) => data.quarkUrl === quarkUrl && data.episodeNum === episodeNum);
                
                const version = existingEntries.length + 1;
                const key = `${quarkUrl}:${name}`;
                if (!episodeMap.has(key)) {
                  episodeMap.set(key, {
                    firstEpisodeUrl: null,
                    quarkUrl: quarkUrl,
                    episodeNum: episodeNum,
                    version: version
                  });
                  log(`添加集数: ${episodeNum} 版本${version} (网盘: ${quarkUrl.substring(0, 40)}...)`);
                }
              }
            }
          }
          
          log(`episodeMap 大小: ${episodeMap.size}`);
          
          // 不再获取任何直链，全部使用构造的播放地址
          log(`跳过所有直链获取，全部使用构造的播放地址`);
          
          log(`开始构建播放地址`);
          const baseUrl = getBaseUrl(req);
          // 为每个网盘构建独立的播放地址
          const uniqueQuarkUrls = new Set();
          episodeMap.forEach(data => uniqueQuarkUrls.add(data.quarkUrl));
          
          const allPlayUrls = [];
          
          for (const quarkUrl of uniqueQuarkUrls) {
            const episodesForQuark = Array.from(episodeMap.entries())
              .filter(([_, data]) => data.quarkUrl === quarkUrl)
              .sort((a, b) => a[1].episodeNum - b[1].episodeNum)
              .map(([_, data]) => {
                  const paddedNum = data.episodeNum.toString().padStart(2, '0');
                  // 保留原始集名，不修改
                if (data.version === 1) {
                  return `第${paddedNum}集$${baseUrl}/api.php/provide/vod/play?quarkUrl=${encodeURIComponent(data.quarkUrl)}&episode=${data.episodeNum}`;
                } else {
                  return `第${paddedNum}集$${baseUrl}/api.php/provide/vod/play?quarkUrl=${encodeURIComponent(data.quarkUrl)}&episode=${data.episodeNum}&version=${data.version}`;
                }
                });
            
            allPlayUrls.push(episodesForQuark.join('#'));
          }
          
          sortedEpisodes = allPlayUrls.join('$$$');
          log(`构建播放地址完成，共 ${uniqueQuarkUrls.size} 个网盘，${episodeMap.size} 个集数`);
          log(`共获取 ${uniqueQuarkUrls.size} 个网盘资源`);
        }
        
        if (isMovie) {
          log(`共获取 ${allMovieLinks?.length || 0} 个电影资源`);
        }
        
        return res.json({
          code: 1,
          msg: '数据详情',
          list: [{
            vod_id: ids,
            vod_play_from: 'quark',
            vod_play_url: sortedEpisodes
          }]
        });
      }
      
      let quarkUrl = ids;
      
      if (ids.includes('/play/')) {
        quarkUrl = ids.split('/play/')[1].split('/')[0];
        quarkUrl = decodeURIComponent(quarkUrl);
      }
      
      const directLinks = await getDirectLink(quarkUrl, false);
      
      const episodeMap = new Map();
      let hasVideoCodec = false;
      
      directLinks.forEach(item => {
        const name = item.name.toLowerCase();
        if (name.includes('264') || name.includes('265') || name.includes('hevc') || name.includes('avc')) {
          hasVideoCodec = true;
        }
        const episodeNum = extractEpisodeNumberDetail(item.name);
        if (episodeNum !== null) {
          if (!episodeMap.has(episodeNum)) {
            episodeMap.set(episodeNum, item.url);
          }
        }
      });
      
      let playUrls;
      
      if (hasVideoCodec || episodeMap.size <= 1) {
        playUrls = directLinks.map(item => `${item.name}$${item.url}`).join('#');
      } else {
        playUrls = Array.from(episodeMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([episodeNum, url]) => {
            const paddedNum = episodeNum.toString().padStart(2, '0');
            return `第${paddedNum}集$${url}`;
          })
          .join('#');
      }
      
      return res.json({
        code: 1,
        msg: '数据详情',
        list: [{
          vod_id: ids,
          vod_play_from: 'quark',
          vod_play_url: playUrls
        }]
      });
    }
    
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: '缺少ac参数',
        list: []
      });
    }
    
  } catch (error) {
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        list: []
      });
    }
  }
});

app.get('/api.php/provide/vod/play', async (req, res) => {
  try {
    const { quarkUrl, episode, version = 1 } = req.query;
    
    if (!quarkUrl || !episode) {
      return res.status(400).send('缺少参数');
    }
    
    log(`收到播放请求: ${quarkUrl.substring(0, 40)}... 集数: ${episode} 版本: ${version}`);
    
    const cookie = getQuarkCookie();
    if (!cookie) {
      return res.status(400).send('夸克网盘未配置，请先配置夸克Cookie');
    }
    
    const openlistUrl = getOpenlistUrl();
    const openlistUsername = getOpenlistUsername();
    const openlistPassword = getOpenlistPassword();
    const quarkPlayTempSavePath = getQuarkPlayTempSavePath();
    const openlistTempPath = getOpenlistTempPath();
    
    if (!openlistUrl || !openlistUsername || !openlistPassword) {
      return res.status(400).send('OpenList未配置，请先配置OpenList相关参数');
    }
    
    if (!quarkPlayTempSavePath) {
      return res.status(400).send('夸克转存目录未配置，请先配置夸克转存目录');
    }
    
    if (!openlistTempPath) {
      return res.status(400).send('OpenList临时目录未配置，请先配置OpenList临时目录');
    }
    
    const result = await createQuarkInstantPlayFolder(cookie, {
      shareUrl: quarkUrl,
      passcode: '',
      playTempSavePath: getQuarkPlayTempSavePath(),
      title: '',
    });
    
    if (!result.folderName) {
      throw new Error('未生成临时播放目录');
    }
    
    const openlistFolderPath = joinPath(
      getOpenlistTempPath(),
      result.folderName
    );
    
    const openListClient = new OpenListClient(openlistUrl, openlistUsername, openlistPassword);
    await openListClient.refreshDirectory(getOpenlistTempPath() || '/');
    await openListClient.refreshDirectory(openlistFolderPath);
    
    const files = await openListClient.listDirectory(openlistFolderPath);
    const videoFiles = files.filter(f => !f.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    
    const targetEpisodeNum = parseInt(episode);
    const matchedFile = videoFiles.find(f => {
      const epNum = extractEpisodeNumberDetail(f.name);
      return epNum === targetEpisodeNum;
    });
    
    if (matchedFile) {
      const openlistPlayUrl = `${openlistUrl}${openlistFolderPath}/${encodeURIComponent(matchedFile.name)}`;
      log(`重定向到OpenList: ${openlistPlayUrl.substring(0, 100)}...`);
      return res.redirect(openlistPlayUrl);
    } else {
      throw new Error('未在OpenList中找到对应的视频文件');
    }
  } catch (error) {
    log(`播放请求失败: ${error.message}`);
    if (!res.headersSent) {
      return res.status(500).send(error.message);
    }
  }
});

app.post('/api.php/provide/vod/play', async (req, res) => {
  try {
    const { quarkUrl, episode, version = 1 } = req.body;
    
    if (!quarkUrl || !episode) {
      return res.json({
        code: 0,
        msg: '缺少参数',
        url: ''
      });
    }
    
    log(`收到播放请求: ${quarkUrl.substring(0, 40)}... 集数: ${episode} 版本: ${version}`);
    
    const cookie = getQuarkCookie();
    if (!cookie) {
      return res.json({
        code: 0,
        msg: '夸克网盘未配置，请先配置夸克Cookie',
        url: ''
      });
    }
    
    const openlistUrl = getOpenlistUrl();
    const openlistUsername = getOpenlistUsername();
    const openlistPassword = getOpenlistPassword();
    
    if (!openlistUrl || !openlistUsername || !openlistPassword) {
      return res.json({
        code: 0,
        msg: 'OpenList未配置，请先配置OpenList相关参数',
        url: ''
      });
    }
    
    const result = await createQuarkInstantPlayFolder(cookie, {
      shareUrl: quarkUrl,
      passcode: '',
      playTempSavePath: getQuarkPlayTempSavePath(),
      title: '',
    });
    
    if (!result.folderName) {
      throw new Error('未生成临时播放目录');
    }
    
    const openlistFolderPath = joinPath(
      getOpenlistTempPath(),
      result.folderName
    );
    
    const openListClient = new OpenListClient(openlistUrl, openlistUsername, openlistPassword);
    await openListClient.refreshDirectory(getOpenlistTempPath() || '/');
    await openListClient.refreshDirectory(openlistFolderPath);
    
    const files = await openListClient.listDirectory(openlistFolderPath);
    const videoFiles = files.filter(f => !f.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    
    const targetEpisodeNum = parseInt(episode);
    const matchedFile = videoFiles.find(f => {
      const epNum = extractEpisodeNumberDetail(f.name);
      return epNum === targetEpisodeNum;
    });
    
    if (matchedFile) {
      const openlistPlayUrl = `${openlistUrl}${openlistFolderPath}/${encodeURIComponent(matchedFile.name)}`;
      log(`返回OpenList播放地址: ${openlistPlayUrl.substring(0, 100)}...`);
      return res.json({
        code: 1,
        msg: '播放地址',
        url: openlistPlayUrl
      });
    } else {
      throw new Error('未在OpenList中找到对应的视频文件');
    }
  } catch (error) {
    log(`播放请求失败: ${error.message}`);
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        url: ''
      });
    }
  }
});

app.post('/vod/search', async (req, res) => {
  const vodList = [];
  
  try {
    const { wd } = req.body;
    
    if (!wd) {
      return res.json({
        code: 0,
        msg: '缺少搜索关键词',
        list: []
      });
    }
    
    const cacheKey = `search:${wd}`;
    const cachedResult = cache[cacheKey];
    
    if (cachedResult && Date.now() - cachedResult.timestamp < 3600000) {
      log(`使用搜索缓存: ${wd}`);
      return res.json(cachedResult.data);
    }
    
    const searchResponse = await fetch(PANSOU_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kw: wd,
        res: 'merge',
        limit: 10
      })
    });
    
    const searchData = await searchResponse.json();
    
    if (searchData.data && searchData.data.merged_by_type && searchData.data.merged_by_type.quark) {
      const allItems = searchData.data.merged_by_type.quark;
      const maxValidItems = 5;
      const checkConcurrency = 10;
      
      log(`搜索到 ${allItems.length} 个结果，开始并行验证（并发数: ${checkConcurrency}）...`);
      
      const quark = getQuarkInstance();
      if (!quark) {
        return res.json({
          code: 0,
          msg: '未配置夸克Cookie，请先在首页扫码登录',
          list: []
        });
      }
      
      const checkItem = async (item, index) => {
        const cleanUrl = (item.url || '').trim().replace(/^`|`$/g, '');
        
        if (invalidLinks[cleanUrl]) {
          log(`跳过失效链接: ${cleanUrl.substring(0, 40)}...`);
          return null;
        }
        
        try {
          const shareInfo = await quark.getShareInfo(cleanUrl);
          const playUrl = shareInfo.vod_play_url || '';
          
          if (playUrl) {
            const videos = playUrl.split('#').filter(v => v.trim());
            if (videos.length > 0) {
              log(`有效[${index}]: ${cleanUrl.substring(0, 40)}... (${videos.length}个视频)`);
              return { item, videoCount: videos.length, playUrl };
            } else {
              invalidLinks[cleanUrl] = Date.now();
              log(`失效[${index}]: ${cleanUrl.substring(0, 40)}... (无视频)`);
              return null;
            }
          } else {
            invalidLinks[cleanUrl] = Date.now();
            log(`失效[${index}]: ${cleanUrl.substring(0, 40)}... (无播放地址)`);
            return null;
          }
        } catch (error) {
          invalidLinks[cleanUrl] = Date.now();
          log(`失效[${index}]: ${cleanUrl.substring(0, 40)}... (${error.message})`);
          return null;
        }
      };
      
      const validItems = [];
      const validPlayUrls = [];
      const itemsToCheck = allItems.slice(0, Math.min(allItems.length, checkConcurrency * 2));
      
      const checkPromises = itemsToCheck.map((item, index) => checkItem(item, index));
      const results = await Promise.all(checkPromises);
      
      for (const result of results) {
        if (result && validItems.length < maxValidItems) {
          validItems.push(result.item);
          validPlayUrls.push(result.playUrl);
        }
      }
      
      saveInvalidLinks();
      log(`验证完成，找到 ${validItems.length} 个有效网盘`);
      
      for (let i = 0; i < validItems.length; i++) {
        const item = validItems[i];
        const cleanUrl = (item.url || '').trim().replace(/^`|`$/g, '');
        const playUrl = validPlayUrls[i] || '';
        
        const baseItem = {
          vod_id: cleanUrl,
          vod_name: (item.note || wd).trim(),
          vod_pic: (item.images?.[0] || '').trim().replace(/^`|`$/g, ''),
          vod_remarks: item.datetime || '',
          vod_play_from: 'quark',
          vod_password: (item.password || '').trim()
        };
        
        if (playUrl) {
          const videos = playUrl.split('#').filter(v => v.trim());
          const videoCount = videos.length;
          
          const baseUrl = getBaseUrl(req);
          const fakePlayUrls = videos.map((v, idx) => {
            const parts = v.split('$');
            const name = parts[0] || `视频${idx + 1}`;
            return `${name}$${baseUrl}/play/${encodeURIComponent(cleanUrl)}/${idx}`;
          }).join('#');
          
          const resultItem = {
            ...baseItem,
            vod_play_url: fakePlayUrls,
            vod_remarks: `${item.datetime || ''} (${videoCount}个视频)`
          };
          vodList.push(resultItem);
        }
      }
      
      const allUrls = validItems.map(item => (item.url || '').trim().replace(/^`|`$/g, ''));
      
      const baseUrl = getBaseUrl(req);
      const allItem = {
        vod_id: `all:${wd}`,
        vod_name: `${wd}`,
        vod_pic: '',
        vod_remarks: `共${validItems.length}个网盘`,
        vod_play_from: 'quark',
        vod_password: '',
        vod_play_url: `${wd}.1080p.mp4$${baseUrl}/api.php/provide/vod?ac=detail&ids=all:${wd}`
      };
      
      vodList.unshift(allItem);
      
      cache[`${cacheKey}:all`] = {
        timestamp: Date.now(),
        data: allUrls
      };
      saveCache();
    }
    
    const result = {
      code: 1,
      msg: '数据列表',
      page: 1,
      pagecount: 1,
      limit: 10,
      total: vodList.length,
      list: vodList
    };
    
    cache[cacheKey] = {
      timestamp: Date.now(),
      data: result
    };
    saveCache();
    
    return res.json(result);
    
  } catch (error) {
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        list: []
      });
    }
  }
});

app.post('/vod/detail', async (req, res) => {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.json({
        code: 0,
        msg: '缺少ID',
        list: []
      });
    }
    
    const directLinks = await getDirectLink(id, true, true, req);
    
    return res.json({
      code: 1,
      msg: '数据详情',
      list: [{
        vod_id: id,
        vod_play_from: 'quark',
        vod_play_url: `播放$${directLinks}`
      }]
    });
    
  } catch (error) {
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        list: []
      });
    }
  }
});

app.post('/vod/play', async (req, res) => {
  try {
    const { id } = req.body;
    
    log('收到播放请求，ID:', id);
    
    if (!id) {
      return res.json({
        code: 0,
        msg: '缺少ID',
        url: '',
        parse: 0
      });
    }
    
    log('开始获取直链...');
    const directUrl = await getDirectLink(id, true, true, req);
    log('获取到的直链:', directUrl);
    
    res.json({
      code: 1,
      msg: '播放地址',
      url: directUrl,
      parse: 0
    });
    
  } catch (error) {
    log('播放请求处理失败:', error);
    res.json({
      code: 0,
      msg: error.message,
      url: '',
      parse: 0
    });
  }
});

app.post('/vod/playpage', async (req, res) => {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.json({
        code: 0,
        msg: '缺少ID',
        playPage: ''
      });
    }
    
    const quarkUrl = id.replace('quark_', '');
    const directLinks = await getDirectLink(quarkUrl, false, true, req);
    
    if (directLinks && directLinks.length > 0) {
      res.json({
        code: 1,
        msg: '播放页面',
        playPage: directLinks[0].url,
        parse: 1
      });
    } else {
      res.json({
        code: 0,
        msg: '未找到直链',
        playPage: ''
      });
    }
    
  } catch (error) {
    res.json({
      code: 0,
      msg: error.message,
      playPage: ''
    });
  }
});

async function getDirectLink(id, limit = true, useProxy = false, req = null) {
  try {
    const quarkUrl = id.startsWith('http') ? id : id.replace('quark_', '');
    
    const cacheKey = `direct:${quarkUrl}`;
    const cachedResult = cache[cacheKey];
    
    if (cachedResult && Date.now() - cachedResult.timestamp < 3600000) {
      log(`使用缓存直链: ${quarkUrl.substring(0, 40)}...`);
      if (useProxy && req) {
        const baseUrl = getBaseUrl(req);
        return cachedResult.data.map(link => ({
          ...link,
          url: `${baseUrl}/proxy/play?url=${encodeURIComponent(link.url)}`
        }));
      }
      return cachedResult.data;
    }
    
    log(`获取直链: ${quarkUrl.substring(0, 40)}...`);
    
    const quark = getQuarkInstance();
    if (!quark) {
      log(`未配置夸克Cookie`);
      return [];
    }
    
    try {
      const links = await quark.getDirectLinks(quarkUrl);
      
      if (!links || links.length === 0) {
        log(`未找到视频文件: ${quarkUrl.substring(0, 40)}...`);
        return [];
      }
      
      const maxVideos = limit ? 10 : links.length;
      const limitedLinks = links.slice(0, maxVideos);
      
      log(`找到 ${links.length} 个视频，限制为前 ${limitedLinks.length} 个`);
      
      const directLinks = limitedLinks.map((link, idx) => ({
        url: link.downloadUrl,
        name: link.fileName,
        fid: link.fid
      }));
      
      cache[cacheKey] = {
        timestamp: Date.now(),
        data: directLinks,
        rawLinks: limitedLinks
      };
      saveCache();
      
      log(`成功获取 ${directLinks.length} 个直链`);
      
      if (useProxy && req) {
        const baseUrl = getBaseUrl(req);
        return directLinks.map(link => ({
          ...link,
          url: `${baseUrl}/proxy/play?url=${encodeURIComponent(link.url)}`
        }));
      }
      
      return directLinks;
      
    } catch (error) {
      log(`获取直链失败: ${error.message}`);
      return [];
    }
    
  } catch (error) {
    log(`获取直链异常: ${error.message}`);
    return [];
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/proxy/play', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).send('缺少 url 参数');
    }
    
    const decodedUrl = decodeURIComponent(url);
    log(`代理播放请求: ${decodedUrl.substring(0, 80)}...`);
    
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    };
    
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
      log(`转发Range请求: ${req.headers.range}`);
    }
    
    const response = await fetch(decodedUrl, {
      headers: headers
    });
    
    log(`响应状态: ${response.status}`);
    
    if (!response.ok && response.status !== 206) {
      log(`代理请求失败: ${response.status}`);
      return res.status(response.status).send('请求失败');
    }
    
    const ignoreResponseHeaders = ['set-cookie', 'transfer-encoding'];
    for (const [key, value] of response.headers.entries()) {
      if (!ignoreResponseHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }
    
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (response.status === 206) {
      res.status(206);
    }
    
    response.body.pipe(res);
    
  } catch (error) {
    log(`代理播放失败: ${error.message}`);
    res.status(500).send(error.message);
  }
});

app.listen(PORT, () => {
  console.log(`VOD API Server running on port ${PORT}`);
}););
          log(`构建播放地址完成，共 ${allPlayUrls.length} 个网盘`);
        } else {
          log(`进入剧集分支`);
          let episodeMap = new Map();
          
          log(`开始遍历 quarkPlayUrls`);
          for (const quarkPlay of quarkPlayUrls) {
            const { quarkUrl, playUrl } = quarkPlay;
            
            log(`处理网盘: ${quarkUrl.substring(0, 40)}..., playUrl 长度: ${playUrl ? playUrl.length : 0}`);
            
            if (!playUrl) {
              log(`跳过空 playUrl`);
              continue;
            }
            
            const videos = playUrl.split('#').filter(v => v.trim());
            log(`找到 ${videos.length} 个视频`);
            
            // 为每个视频创建独立条目，同一集的后续版本自动添加编号
            for (const video of videos) {
              const [name] = video.split('$');
              const episodeNum = extractEpisodeNumberDetail(name);
              
              if (episodeNum !== null) {
                // 只统计当前网盘下的该集数条目
                const existingEntries = Array.from(episodeMap.entries())
                  .filter(([key, data]) => data.quarkUrl === quarkUrl && data.episodeNum === episodeNum);
                
                const version = existingEntries.length + 1;
                const key = `${quarkUrl}:${name}`;
                if (!episodeMap.has(key)) {
                  episodeMap.set(key, {
                    firstEpisodeUrl: null,
                    quarkUrl: quarkUrl,
                    episodeNum: episodeNum,
                    version: version
                  });
                  log(`添加集数: ${episodeNum} 版本${version} (网盘: ${quarkUrl.substring(0, 40)}...)`);
                }
              }
            }
          }
          
          log(`episodeMap 大小: ${episodeMap.size}`);
          
          // 不再获取任何直链，全部使用构造的播放地址
          log(`跳过所有直链获取，全部使用构造的播放地址`);
          
          log(`开始构建播放地址`);
          const baseUrl = getBaseUrl(req);
          // 为每个网盘构建独立的播放地址
          const uniqueQuarkUrls = new Set();
          episodeMap.forEach(data => uniqueQuarkUrls.add(data.quarkUrl));
          
          const allPlayUrls = [];
          
          for (const quarkUrl of uniqueQuarkUrls) {
            const episodesForQuark = Array.from(episodeMap.entries())
              .filter(([_, data]) => data.quarkUrl === quarkUrl)
              .sort((a, b) => a[1].episodeNum - b[1].episodeNum)
              .map(([_, data]) => {
                  const paddedNum = data.episodeNum.toString().padStart(2, '0');
                  // 保留原始集名，不修改
                if (data.version === 1) {
                  return `第${paddedNum}集$${baseUrl}/api.php/provide/vod/play?quarkUrl=${encodeURIComponent(data.quarkUrl)}&episode=${data.episodeNum}`;
                } else {
                  return `第${paddedNum}集$${baseUrl}/api.php/provide/vod/play?quarkUrl=${encodeURIComponent(data.quarkUrl)}&episode=${data.episodeNum}&version=${data.version}`;
                }
                });
            
            allPlayUrls.push(episodesForQuark.join('#'));
          }
          
          sortedEpisodes = allPlayUrls.join('$$$');
          log(`构建播放地址完成，共 ${uniqueQuarkUrls.size} 个网盘，${episodeMap.size} 个集数`);
          log(`共获取 ${uniqueQuarkUrls.size} 个网盘资源`);
        }
        
        if (isMovie) {
          log(`共获取 ${allMovieLinks?.length || 0} 个电影资源`);
        }
        
        return res.json({
          code: 1,
          msg: '数据详情',
          list: [{
            vod_id: ids,
            vod_play_from: 'quark',
            vod_play_url: sortedEpisodes
          }]
        });
      }
      
      let quarkUrl = ids;
      
      if (ids.includes('/play/')) {
        quarkUrl = ids.split('/play/')[1].split('/')[0];
        quarkUrl = decodeURIComponent(quarkUrl);
      }
      
      const directLinks = await getDirectLink(quarkUrl, false);
      
      const episodeMap = new Map();
      let hasVideoCodec = false;
      
      directLinks.forEach(item => {
        const name = item.name.toLowerCase();
        if (name.includes('264') || name.includes('265') || name.includes('hevc') || name.includes('avc')) {
          hasVideoCodec = true;
        }
        const episodeNum = extractEpisodeNumberDetail(item.name);
        if (episodeNum !== null) {
          if (!episodeMap.has(episodeNum)) {
            episodeMap.set(episodeNum, item.url);
          }
        }
      });
      
      let playUrls;
      
      if (hasVideoCodec || episodeMap.size <= 1) {
        playUrls = directLinks.map(item => `${item.name}$${item.url}`).join('#');
      } else {
        playUrls = Array.from(episodeMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([episodeNum, url]) => {
            const paddedNum = episodeNum.toString().padStart(2, '0');
            return `第${paddedNum}集$${url}`;
          })
          .join('#');
      }
      
      return res.json({
        code: 1,
        msg: '数据详情',
        list: [{
          vod_id: ids,
          vod_play_from: 'quark',
          vod_play_url: playUrls
        }]
      });
    }
    
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: '缺少ac参数',
        list: []
      });
    }
    
  } catch (error) {
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        list: []
      });
    }
  }
});

app.get('/api.php/provide/vod/play', async (req, res) => {
  try {
    const { quarkUrl, episode, version = 1 } = req.query;
    
    if (!quarkUrl || !episode) {
      return res.status(400).send('缺少参数');
    }
    
    log(`收到播放请求: ${quarkUrl.substring(0, 40)}... 集数: ${episode} 版本: ${version}`);
    
    const cookie = getQuarkCookie();
    if (!cookie) {
      return res.status(400).send('夸克网盘未配置，请先配置夸克Cookie');
    }
    
    const openlistUrl = getOpenlistUrl();
    const openlistUsername = getOpenlistUsername();
    const openlistPassword = getOpenlistPassword();
    const quarkPlayTempSavePath = getQuarkPlayTempSavePath();
    const openlistTempPath = getOpenlistTempPath();
    
    if (!openlistUrl || !openlistUsername || !openlistPassword) {
      return res.status(400).send('OpenList未配置，请先配置OpenList相关参数');
    }
    
    if (!quarkPlayTempSavePath) {
      return res.status(400).send('夸克转存目录未配置，请先配置夸克转存目录');
    }
    
    if (!openlistTempPath) {
      return res.status(400).send('OpenList临时目录未配置，请先配置OpenList临时目录');
    }
    
    const result = await createQuarkInstantPlayFolder(cookie, {
      shareUrl: quarkUrl,
      passcode: '',
      playTempSavePath: getQuarkPlayTempSavePath(),
      title: '',
    });
    
    if (!result.folderName) {
      throw new Error('未生成临时播放目录');
    }
    
    const openlistFolderPath = joinPath(
      getOpenlistTempPath(),
      result.folderName
    );
    
    const openListClient = new OpenListClient(openlistUrl, openlistUsername, openlistPassword);
    await openListClient.refreshDirectory(getOpenlistTempPath() || '/');
    await openListClient.refreshDirectory(openlistFolderPath);
    
    const files = await openListClient.listDirectory(openlistFolderPath);
    const videoFiles = files.filter(f => !f.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    
    const targetEpisodeNum = parseInt(episode);
    const matchedFile = videoFiles.find(f => {
      const epNum = extractEpisodeNumberDetail(f.name);
      return epNum === targetEpisodeNum;
    });
    
    if (matchedFile) {
      const openlistPlayUrl = `${openlistUrl}${openlistFolderPath}/${encodeURIComponent(matchedFile.name)}`;
      log(`重定向到OpenList: ${openlistPlayUrl.substring(0, 100)}...`);
      return res.redirect(openlistPlayUrl);
    } else {
      throw new Error('未在OpenList中找到对应的视频文件');
    }
  } catch (error) {
    log(`播放请求失败: ${error.message}`);
    if (!res.headersSent) {
      return res.status(500).send(error.message);
    }
  }
});

app.post('/api.php/provide/vod/play', async (req, res) => {
  try {
    const { quarkUrl, episode, version = 1 } = req.body;
    
    if (!quarkUrl || !episode) {
      return res.json({
        code: 0,
        msg: '缺少参数',
        url: ''
      });
    }
    
    log(`收到播放请求: ${quarkUrl.substring(0, 40)}... 集数: ${episode} 版本: ${version}`);
    
    const cookie = getQuarkCookie();
    if (!cookie) {
      return res.json({
        code: 0,
        msg: '夸克网盘未配置，请先配置夸克Cookie',
        url: ''
      });
    }
    
    const openlistUrl = getOpenlistUrl();
    const openlistUsername = getOpenlistUsername();
    const openlistPassword = getOpenlistPassword();
    
    if (!openlistUrl || !openlistUsername || !openlistPassword) {
      return res.json({
        code: 0,
        msg: 'OpenList未配置，请先配置OpenList相关参数',
        url: ''
      });
    }
    
    const result = await createQuarkInstantPlayFolder(cookie, {
      shareUrl: quarkUrl,
      passcode: '',
      playTempSavePath: getQuarkPlayTempSavePath(),
      title: '',
    });
    
    if (!result.folderName) {
      throw new Error('未生成临时播放目录');
    }
    
    const openlistFolderPath = joinPath(
      getOpenlistTempPath(),
      result.folderName
    );
    
    const openListClient = new OpenListClient(openlistUrl, openlistUsername, openlistPassword);
    await openListClient.refreshDirectory(getOpenlistTempPath() || '/');
    await openListClient.refreshDirectory(openlistFolderPath);
    
    const files = await openListClient.listDirectory(openlistFolderPath);
    const videoFiles = files.filter(f => !f.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    
    const targetEpisodeNum = parseInt(episode);
    const matchedFile = videoFiles.find(f => {
      const epNum = extractEpisodeNumberDetail(f.name);
      return epNum === targetEpisodeNum;
    });
    
    if (matchedFile) {
      const openlistPlayUrl = `${openlistUrl}${openlistFolderPath}/${encodeURIComponent(matchedFile.name)}`;
      log(`返回OpenList播放地址: ${openlistPlayUrl.substring(0, 100)}...`);
      return res.json({
        code: 1,
        msg: '播放地址',
        url: openlistPlayUrl
      });
    } else {
      throw new Error('未在OpenList中找到对应的视频文件');
    }
  } catch (error) {
    log(`播放请求失败: ${error.message}`);
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        url: ''
      });
    }
  }
});

app.post('/vod/search', async (req, res) => {
  const vodList = [];
  
  try {
    const { wd } = req.body;
    
    if (!wd) {
      return res.json({
        code: 0,
        msg: '缺少搜索关键词',
        list: []
      });
    }
    
    const cacheKey = `search:${wd}`;
    const cachedResult = cache[cacheKey];
    
    if (cachedResult && Date.now() - cachedResult.timestamp < 3600000) {
      log(`使用搜索缓存: ${wd}`);
      return res.json(cachedResult.data);
    }
    
    const searchResponse = await fetch(PANSOU_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kw: wd,
        res: 'merge',
        limit: 10
      })
    });
    
    const searchData = await searchResponse.json();
    
    if (searchData.data && searchData.data.merged_by_type && searchData.data.merged_by_type.quark) {
      const allItems = searchData.data.merged_by_type.quark;
      const maxValidItems = 5;
      const checkConcurrency = 10;
      
      log(`搜索到 ${allItems.length} 个结果，开始并行验证（并发数: ${checkConcurrency}）...`);
      
      const quark = getQuarkInstance();
      if (!quark) {
        return res.json({
          code: 0,
          msg: '未配置夸克Cookie，请先在首页扫码登录',
          list: []
        });
      }
      
      const checkItem = async (item, index) => {
        const cleanUrl = (item.url || '').trim().replace(/^`|`$/g, '');
        
        if (invalidLinks[cleanUrl]) {
          log(`跳过失效链接: ${cleanUrl.substring(0, 40)}...`);
          return null;
        }
        
        try {
          const shareInfo = await quark.getShareInfo(cleanUrl);
          const playUrl = shareInfo.vod_play_url || '';
          
          if (playUrl) {
            const videos = playUrl.split('#').filter(v => v.trim());
            if (videos.length > 0) {
              log(`有效[${index}]: ${cleanUrl.substring(0, 40)}... (${videos.length}个视频)`);
              return { item, videoCount: videos.length, playUrl };
            } else {
              invalidLinks[cleanUrl] = Date.now();
              log(`失效[${index}]: ${cleanUrl.substring(0, 40)}... (无视频)`);
              return null;
            }
          } else {
            invalidLinks[cleanUrl] = Date.now();
            log(`失效[${index}]: ${cleanUrl.substring(0, 40)}... (无播放地址)`);
            return null;
          }
        } catch (error) {
          invalidLinks[cleanUrl] = Date.now();
          log(`失效[${index}]: ${cleanUrl.substring(0, 40)}... (${error.message})`);
          return null;
        }
      };
      
      const validItems = [];
      const validPlayUrls = [];
      const itemsToCheck = allItems.slice(0, Math.min(allItems.length, checkConcurrency * 2));
      
      const checkPromises = itemsToCheck.map((item, index) => checkItem(item, index));
      const results = await Promise.all(checkPromises);
      
      for (const result of results) {
        if (result && validItems.length < maxValidItems) {
          validItems.push(result.item);
          validPlayUrls.push(result.playUrl);
        }
      }
      
      saveInvalidLinks();
      log(`验证完成，找到 ${validItems.length} 个有效网盘`);
      
      for (let i = 0; i < validItems.length; i++) {
        const item = validItems[i];
        const cleanUrl = (item.url || '').trim().replace(/^`|`$/g, '');
        const playUrl = validPlayUrls[i] || '';
        
        const baseItem = {
          vod_id: cleanUrl,
          vod_name: (item.note || wd).trim(),
          vod_pic: (item.images?.[0] || '').trim().replace(/^`|`$/g, ''),
          vod_remarks: item.datetime || '',
          vod_play_from: 'quark',
          vod_password: (item.password || '').trim()
        };
        
        if (playUrl) {
          const videos = playUrl.split('#').filter(v => v.trim());
          const videoCount = videos.length;
          
          const baseUrl = getBaseUrl(req);
          const fakePlayUrls = videos.map((v, idx) => {
            const parts = v.split('$');
            const name = parts[0] || `视频${idx + 1}`;
            return `${name}$${baseUrl}/play/${encodeURIComponent(cleanUrl)}/${idx}`;
          }).join('#');
          
          const resultItem = {
            ...baseItem,
            vod_play_url: fakePlayUrls,
            vod_remarks: `${item.datetime || ''} (${videoCount}个视频)`
          };
          vodList.push(resultItem);
        }
      }
      
      const allUrls = validItems.map(item => (item.url || '').trim().replace(/^`|`$/g, ''));
      
      const baseUrl = getBaseUrl(req);
      const allItem = {
        vod_id: `all:${wd}`,
        vod_name: `${wd}`,
        vod_pic: '',
        vod_remarks: `共${validItems.length}个网盘`,
        vod_play_from: 'quark',
        vod_password: '',
        vod_play_url: `${wd}.1080p.mp4$${baseUrl}/api.php/provide/vod?ac=detail&ids=all:${wd}`
      };
      
      vodList.unshift(allItem);
      
      cache[`${cacheKey}:all`] = {
        timestamp: Date.now(),
        data: allUrls
      };
      saveCache();
    }
    
    const result = {
      code: 1,
      msg: '数据列表',
      page: 1,
      pagecount: 1,
      limit: 10,
      total: vodList.length,
      list: vodList
    };
    
    cache[cacheKey] = {
      timestamp: Date.now(),
      data: result
    };
    saveCache();
    
    return res.json(result);
    
  } catch (error) {
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        list: []
      });
    }
  }
});

app.post('/vod/detail', async (req, res) => {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.json({
        code: 0,
        msg: '缺少ID',
        list: []
      });
    }
    
    const directLinks = await getDirectLink(id, true, true, req);
    
    return res.json({
      code: 1,
      msg: '数据详情',
      list: [{
        vod_id: id,
        vod_play_from: 'quark',
        vod_play_url: `播放$${directLinks}`
      }]
    });
    
  } catch (error) {
    if (!res.headersSent) {
      return res.json({
        code: 0,
        msg: error.message,
        list: []
      });
    }
  }
});

app.post('/vod/play', async (req, res) => {
  try {
    const { id } = req.body;
    
    log('收到播放请求，ID:', id);
    
    if (!id) {
      return res.json({
        code: 0,
        msg: '缺少ID',
        url: '',
        parse: 0
      });
    }
    
    log('开始获取直链...');
    const directUrl = await getDirectLink(id, true, true, req);
    log('获取到的直链:', directUrl);
    
    res.json({
      code: 1,
      msg: '播放地址',
      url: directUrl,
      parse: 0
    });
    
  } catch (error) {
    log('播放请求处理失败:', error);
    res.json({
      code: 0,
      msg: error.message,
      url: '',
      parse: 0
    });
  }
});

app.post('/vod/playpage', async (req, res) => {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.json({
        code: 0,
        msg: '缺少ID',
        playPage: ''
      });
    }
    
    const quarkUrl = id.replace('quark_', '');
    const directLinks = await getDirectLink(quarkUrl, false, true, req);
    
    if (directLinks && directLinks.length > 0) {
      res.json({
        code: 1,
        msg: '播放页面',
        playPage: directLinks[0].url,
        parse: 1
      });
    } else {
      res.json({
        code: 0,
        msg: '未找到直链',
        playPage: ''
      });
    }
    
  } catch (error) {
    res.json({
      code: 0,
      msg: error.message,
      playPage: ''
    });
  }
});

async function getDirectLink(id, limit = true, useProxy = false, req = null) {
  try {
    const quarkUrl = id.startsWith('http') ? id : id.replace('quark_', '');
    
    const cacheKey = `direct:${quarkUrl}`;
    const cachedResult = cache[cacheKey];
    
    if (cachedResult && Date.now() - cachedResult.timestamp < 3600000) {
      log(`使用缓存直链: ${quarkUrl.substring(0, 40)}...`);
      if (useProxy && req) {
        const baseUrl = getBaseUrl(req);
        return cachedResult.data.map(link => ({
          ...link,
          url: `${baseUrl}/proxy/play?url=${encodeURIComponent(link.url)}`
        }));
      }
      return cachedResult.data;
    }
    
    log(`获取直链: ${quarkUrl.substring(0, 40)}...`);
    
    const quark = getQuarkInstance();
    if (!quark) {
      log(`未配置夸克Cookie`);
      return [];
    }
    
    try {
      const links = await quark.getDirectLinks(quarkUrl);
      
      if (!links || links.length === 0) {
        log(`未找到视频文件: ${quarkUrl.substring(0, 40)}...`);
        return [];
      }
      
      const maxVideos = limit ? 10 : links.length;
      const limitedLinks = links.slice(0, maxVideos);
      
      log(`找到 ${links.length} 个视频，限制为前 ${limitedLinks.length} 个`);
      
      const directLinks = limitedLinks.map((link, idx) => ({
        url: link.downloadUrl,
        name: link.fileName,
        fid: link.fid
      }));
      
      cache[cacheKey] = {
        timestamp: Date.now(),
        data: directLinks,
        rawLinks: limitedLinks
      };
      saveCache();
      
      log(`成功获取 ${directLinks.length} 个直链`);
      
      if (useProxy && req) {
        const baseUrl = getBaseUrl(req);
        return directLinks.map(link => ({
          ...link,
          url: `${baseUrl}/proxy/play?url=${encodeURIComponent(link.url)}`
        }));
      }
      
      return directLinks;
      
    } catch (error) {
      log(`获取直链失败: ${error.message}`);
      return [];
    }
    
  } catch (error) {
    log(`获取直链异常: ${error.message}`);
    return [];
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/proxy/play', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).send('缺少 url 参数');
    }
    
    const decodedUrl = decodeURIComponent(url);
    log(`代理播放请求: ${decodedUrl.substring(0, 80)}...`);
    
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    };
    
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
      log(`转发Range请求: ${req.headers.range}`);
    }
    
    const response = await fetch(decodedUrl, {
      headers: headers
    });
    
    log(`响应状态: ${response.status}`);
    
    if (!response.ok && response.status !== 206) {
      log(`代理请求失败: ${response.status}`);
      return res.status(response.status).send('请求失败');
    }
    
    const ignoreResponseHeaders = ['set-cookie', 'transfer-encoding'];
    for (const [key, value] of response.headers.entries()) {
      if (!ignoreResponseHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }
    
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (response.status === 206) {
      res.status(206);
    }
    
    response.body.pipe(res);
    
  } catch (error) {
    log(`代理播放失败: ${error.message}`);
    res.status(500).send(error.message);
  }
});

app.listen(PORT, () => {
  console.log(`VOD API Server running on port ${PORT}`);
});

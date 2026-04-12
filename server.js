const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const QuarkDirectLink = require('./quark');

const tokenCache = new Map();
let openListSingleton = null;

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
    this.token = await OpenListClient.login(
      this.baseURL,
      this.username,
      this.password
    );

    tokenCache.set(cacheKey, {
      token: this.token,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });

    console.log('[OpenListClient] 登录成功，Token 已缓存');
    return this.token;
  }

  clearTokenCache() {
    const cacheKey = `${this.baseURL}:${this.username}`;
    tokenCache.delete(cacheKey);
    console.log('[OpenListClient] Token 缓存已清除');
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
      this.clearTokenCache();
      return this.fetchWithRetry(url, options, true);
    }

    if (response.ok && !retried) {
      try {
        const clonedResponse = response.clone();
        const data = await clonedResponse.json();

        if (data.code === 401) {
          console.log('[OpenListClient] 响应体 code 为 401，Token 已过期，清除缓存并重试');
          this.clearTokenCache();
          return this.fetchWithRetry(url, options, true);
        }
      } catch (error) {
        console.warn('[OpenListClient] 解析响应 JSON 失败:', error);
      }
    }
    return response;
  }

  async getHeaders() {
    const token = await this.getToken();
    return {
      Authorization: token,
      'Content-Type': 'application/json'
    };
  }

  async listDirectory(path, page = 1, perPage = 100, refresh = false) {
    const response = await this.fetchWithRetry(`${this.baseURL}/api/fs/list`, {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify({
        path,
        password: '',
        refresh,
        page,
        per_page: perPage,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenList API 错误: ${response.status}`);
    }

    return response.json();
  }

  async getFile(path) {
    const response = await this.fetchWithRetry(`${this.baseURL}/api/fs/get`, {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify({
        path,
        password: '',
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenList API 错误: ${response.status}`);
    }

    return response.json();
  }

  async refreshDirectory(path) {
    try {
      const response = await this.fetchWithRetry(`${this.baseURL}/api/fs/list`, {
        method: 'POST',
        headers: await this.getHeaders(),
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

  async pathExists(path) {
    try {
      const response = await this.listDirectory(path, 1, 1);
      return response.code === 200;
    } catch (error) {
      return false;
    }
  }
}

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
  return { quarkCookie: '', pansouHost: '', openlistUrl: '', openlistUsername: '', openlistPassword: '', openlistTempPath: '', quarkPlayTempSavePath: '' };
}

function getOpenListConfig() {
  return {
    url: process.env.OPENLIST_URL || config.openlistUrl || '',
    username: process.env.OPENLIST_USERNAME || config.openlistUsername || '',
    password: process.env.OPENLIST_PASSWORD || config.openlistPassword || '',
    tempPath: process.env.OPENLIST_TEMP_PATH || config.openlistTempPath || ''
  };
}

function getOpenListInstance() {
  const openlistConfig = getOpenListConfig();
  if (!openlistConfig.url || !openlistConfig.username || !openlistConfig.password) {
    return null;
  }
  if (!openListSingleton) {
    openListSingleton = new OpenListClient(openlistConfig.url, openlistConfig.username, openlistConfig.password);
  }
  return openListSingleton;
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

console.log('QuarkAPI 配置:');
console.log('  盘搜地址:', getPansouHost() || '(未配置)');
console.log('  夸克Cookie:', getQuarkCookie() ? '(已配置)' : '(未配置)');
console.log('  OpenList URL:', getOpenListConfig().url || '(未配置)');
console.log('  OpenList 用户名:', getOpenListConfig().username ? '(已配置)' : '(未配置)');

function getQuarkInstance() {
  const cookie = getQuarkCookie();
  if (!cookie) return null;
  return new QuarkDirectLink(cookie);
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

function getBaseUrl(req) {
  const host = req.get('host') || 'localhost:3000';
  return `http://${host}`;
}

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
app.use(express.static(path.join(__dirname, 'public')));

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
    .form-text { font-size: 12px; color: #999; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 QuarkAPI 配置</h1>
    
    <div class="card">
      <h2>🔗 OpenList 配置</h2>
      <div class="form-group">
        <label>OpenList URL</label>
        <input type="text" id="openlistUrl" placeholder="http://your-openlist-host.com">
        <div class="config-status" id="openlistUrlStatus"></div>
      </div>
      <div class="form-group">
        <label>用户名</label>
        <input type="text" id="openlistUsername" placeholder="admin">
        <div class="config-status" id="openlistUsernameStatus"></div>
      </div>
      <div class="form-group">
        <label>密码</label>
        <input type="password" id="openlistPassword" placeholder="password">
      </div>
      <div class="form-group">
        <label>OpenList 中挂载的夸克网盘临时转存目录路径</label>
        <input type="text" id="openlistTempPath" placeholder="/quark/temp">
        <div class="form-text">OpenList 中挂载的夸克网盘转存目录路径</div>
      </div>
      <div class="form-group">
        <label>夸克转存文件夹路径</label>
        <input type="text" id="quarkPlayTempSavePath" placeholder="/quarkapi">
        <div class="form-text">夸克网盘中用于转存的文件夹路径（相对于夸克网盘根目录）</div>
      </div>
      <button class="btn" onclick="saveConfig()">保存配置</button>
    </div>
    
    <div class="card">
      <h2>⚙️ 基础配置</h2>
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
        <label>夸克Cookie (扫码或手动填写)</label>
        <input type="text" id="quarkCookie" placeholder="扫码登录后自动填充或手动填写">
        <div class="config-status" id="cookieStatus"></div>
      </div>
      <button class="btn" onclick="saveConfig()">保存并检测Cookie</button>
      <button class="btn btn-secondary" onclick="getQrCode()">扫二维码登录</button>
      <button class="btn btn-danger" onclick="clearCookie()">清除Cookie</button>
      
      <div class="qr-container" id="qrContainer" style="display:none;">
        <img id="qrImage" src="" alt="二维码">
        <div class="status waiting" id="qrStatus">等待扫码...</div>
      </div>
    </div>
    
    <div class="card">
      <h2>📖 API 说明</h2>
      <div class="api-list">
        <div class="api-item">
          <code>GET /api/tvbox/drive/quark?ac=detail&ids=分享链接</code>
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
        document.getElementById('openlistPassword').value = data.openlistPassword || '';
        document.getElementById('openlistTempPath').value = data.openlistTempPath || '';
        document.getElementById('quarkPlayTempSavePath').value = data.quarkPlayTempSavePath || '';
        
        if (data.pansouHost) document.getElementById('pansouStatus').textContent = '✓ 已配置';
        if (data.quarkCookie) document.getElementById('cookieStatus').textContent = '✓ 已配置';
        if (data.openlistUrl) document.getElementById('openlistUrlStatus').textContent = '✓ 已配置';
        if (data.openlistUsername) document.getElementById('openlistUsernameStatus').textContent = '✓ 已配置';
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
      const openlistTempPath = document.getElementById('openlistTempPath').value.trim();
      const quarkPlayTempSavePath = document.getElementById('quarkPlayTempSavePath').value.trim();
      
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pansouHost, quarkCookie, openlistUrl, openlistUsername, openlistPassword, openlistTempPath, quarkPlayTempSavePath })
        });
        const data = await res.json();
        if (data.success) {
          let message = '配置已保存！\\n\\n检测结果:\\n';
          if (data.successes && data.successes.length > 0) {
            message += data.successes.map(s => '✓ ' + s).join('\\n');
          }
          alert(message);
          location.reload();
        } else {
          let message = '保存失败: ' + data.message;
          if (data.errors && data.errors.length > 0) {
            message += '\\n\\n错误详情:\\n' + data.errors.map(e => '✗ ' + e).join('\\n');
          }
          alert(message);
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
    openlistUrl: getOpenListConfig().url,
    openlistUsername: getOpenListConfig().username,
    openlistPassword: getOpenListConfig().password,
    openlistTempPath: getOpenListConfig().tempPath,
    quarkPlayTempSavePath: config.quarkPlayTempSavePath || ''
  });
});

function validateUrl(url) {
  if (!url) return { valid: true };
  try {
    new URL(url);
    return { valid: true };
  } catch (e) {
    return { valid: false, message: 'URL 格式不正确' };
  }
}

function validatePath(path) {
  if (!path) return { valid: true };
  if (!path.startsWith('/')) {
    return { valid: false, message: '路径必须以 / 开头' };
  }
  if (path.includes('..')) {
    return { valid: false, message: '路径不能包含 ..' };
  }
  return { valid: true };
}

async function testOpenListConnection(url, username, password) {
  try {
    const client = new OpenListClient(url, username, password);
    const token = await client.getToken();
    return { valid: true, message: '连接成功' };
  } catch (error) {
    return { valid: false, message: `连接失败: ${error.message}` };
  }
}

app.post('/api/config', async (req, res) => {
  const { pansouHost, quarkCookie, openlistUrl, openlistUsername, openlistPassword, openlistTempPath, quarkPlayTempSavePath } = req.body;
  
  const errors = [];
  const successes = [];
  
  const pansouUrlCheck = validateUrl(pansouHost);
  if (!pansouUrlCheck.valid) {
    errors.push(`盘搜地址: ${pansouUrlCheck.message}`);
  } else if (pansouHost) {
    successes.push('盘搜地址: 格式正确');
  }
  
  if (quarkCookie && quarkCookie !== '(已配置)') {
    try {
      const quark = new QuarkDirectLink(quarkCookie);
      const isValid = await quark.validateCookie();
      if (!isValid) {
        errors.push('夸克Cookie: 无效或已过期');
      } else {
        successes.push('夸克Cookie: 验证成功');
      }
    } catch (error) {
      errors.push(`夸克Cookie: 验证失败 - ${error.message}`);
    }
  }
  
  if (openlistUrl || openlistUsername || openlistPassword) {
    const openlistUrlCheck = validateUrl(openlistUrl);
    if (!openlistUrlCheck.valid) {
      errors.push(`OpenList URL: ${openlistUrlCheck.message}`);
    } else if (openlistUrl) {
      const connCheck = await testOpenListConnection(openlistUrl, openlistUsername, openlistPassword);
      if (!connCheck.valid) {
        errors.push(`OpenList 连接: ${connCheck.message}`);
      } else {
        successes.push('OpenList 连接: 成功');
      }
    }
    
    if (openlistTempPath) {
      const pathCheck = validatePath(openlistTempPath);
      if (!pathCheck.valid) {
        errors.push(`OpenList 路径: ${pathCheck.message}`);
      } else if (openlistUrl && openlistUsername && openlistPassword) {
        try {
          const client = new OpenListClient(openlistUrl, openlistUsername, openlistPassword);
          const exists = await client.pathExists(openlistTempPath);
          if (!exists) {
            errors.push('OpenList 路径: 不存在');
          } else {
            successes.push(`OpenList 路径: 存在 - ${openlistTempPath}`);
          }
        } catch (error) {
          errors.push(`OpenList 路径检测失败: ${error.message}`);
        }
      }
    }
  }
  
  if (errors.length > 0) {
    return res.json({ success: false, message: '配置验证失败', errors, successes });
  }
  
  config.pansouHost = pansouHost || '';
  config.quarkCookie = quarkCookie || '';
  config.openlistUrl = openlistUrl || '';
  config.openlistUsername = openlistUsername || '';
  config.openlistPassword = openlistPassword || '';
  config.openlistTempPath = openlistTempPath || '';
  config.quarkPlayTempSavePath = quarkPlayTempSavePath || '';
  
  saveConfig(config);
  
  res.json({ success: true, message: '配置已保存', successes });
});

app.get('/api/quark/qrcode', async (req, res) => {
  try {
    const quark = getQuarkInstance() || new QuarkDirectLink('');
    const result = await quark.getQRCode();
    res.json({ success: true, ...result });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/quark/check-login', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.json({ status: 'error', message: '缺少 token 参数' });
    }
    
    const quark = getQuarkInstance() || new QuarkDirectLink('');
    const result = await quark.checkLogin(token);
    
    if (result.status === 'success') {
      config.quarkCookie = result.cookie;
      saveConfig(config);
    }
    
    res.json(result);
  } catch (error) {
    res.json({ status: 'error', message: error.message });
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
      
      const pansouHost = getPansouHost();
      if (!pansouHost) {
        return res.json({ code: 0, list: [] });
      }
      
      const pansouApi = `${pansouHost}/api/search`;
      
      const searchResponse = await fetch(pansouApi, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({
          kw: wd,
          res: 'merge',
          limit: 10
        })
      });
      
      const searchData = await searchResponse.json();
      log(`盘搜响应: ${JSON.stringify(searchData, null, 2).substring(0, 800)}`);
      const vodList = [];
      
      if (searchData.data && searchData.data.merged_by_type && searchData.data.merged_by_type.quark) {
        const allItems = searchData.data.merged_by_type.quark;
        const maxValidItems = 5;
        
        log(`搜索到 ${allItems.length} 个结果，开始验证...`);
        
        const validItems = [];
        
        for (let i = 0; i < allItems.length && validItems.length < maxValidItems; i++) {
          const item = allItems[i];
          const cleanUrl = (item.url || '').trim().replace(/^`|`$/g, '');
          
          if (invalidLinks[cleanUrl]) {
            log(`跳过失效链接: ${cleanUrl.substring(0, 40)}...`);
            continue;
          }
          
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            
            const detailUrl = `${getBaseUrl(req)}/api.php/provide/vod?ac=detail&ids=${encodeURIComponent(cleanUrl)}`;
            log(`验证第 ${i + 1}/${allItems.length} 个链接: ${cleanUrl.substring(0, 40)}...`);
            
            const detailResponse = await fetch(detailUrl, { signal: controller.signal });
            clearTimeout(timeout);
            
            log(`收到响应，状态: ${detailResponse.status}`);
            
            const detailData = await detailResponse.json();
            
            if (detailData.list && detailData.list.length > 0) {
              const videoDetail = detailData.list[0];
              const playUrl = videoDetail.vod_play_url || '';
              
              if (playUrl) {
                const videos = playUrl.split('#').filter(v => v.trim());
                if (videos.length > 0) {
                  validItems.push(item);
                  log(`有效: ${cleanUrl.substring(0, 40)}... (${videos.length}个视频)`);
                } else {
                  invalidLinks[cleanUrl] = Date.now();
                  log(`失效: ${cleanUrl.substring(0, 40)}... (无视频)`);
                }
              } else {
                invalidLinks[cleanUrl] = Date.now();
                log(`失效: ${cleanUrl.substring(0, 40)}... (无播放地址)`);
              }
            } else {
              invalidLinks[cleanUrl] = Date.now();
              log(`失效: ${cleanUrl.substring(0, 40)}... (未找到详情)`);
            }
          } catch (error) {
            invalidLinks[cleanUrl] = Date.now();
            log(`失效: ${cleanUrl.substring(0, 40)}... (${error.message})`);
          }
        }
        
        log(`验证完成，找到 ${validItems.length} 个有效网盘`);
        
        const allUrls = validItems.map(item => (item.url || '').trim().replace(/^`|`$/g, ''));
        const firstUrl = allUrls.length > 0 ? allUrls[0] : '';
        
        let isMovie = true;
        
        if (firstUrl) {
          try {
            const detailUrl = `${getBaseUrl(req)}/api.php/provide/vod?ac=detail&ids=${encodeURIComponent(firstUrl)}`;
            const detailResponse = await fetch(detailUrl);
            const detailData = await detailResponse.json();
            
            if (detailData.list && detailData.list.length > 0) {
              const videoDetail = detailData.list[0];
              const playUrl = videoDetail.vod_play_url || '';
              
              if (playUrl) {
                const videos = playUrl.split('#').filter(v => v.trim());
                for (const video of videos) {
                  const [name] = video.split('$');
                  const episodeNum = extractEpisodeNumberDetail(name);
                  if (episodeNum !== null) {
                    isMovie = false;
                    break;
                  }
                }
              }
            }
          } catch (error) {
            log(`识别类型失败: ${error.message}`);
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
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            
            const detailUrl = `${getBaseUrl(req)}/api.php/provide/vod?ac=detail&ids=${encodeURIComponent(cleanUrl)}`;
            log(`请求详情: ${detailUrl.substring(0, 60)}...`);
            
            const detailResponse = await fetch(detailUrl, { signal: controller.signal });
            clearTimeout(timeout);
            
            log(`收到响应，状态: ${detailResponse.status}`);
            
            const detailData = await detailResponse.json();
            
            if (detailData.list && detailData.list.length > 0) {
              const videoDetail = detailData.list[0];
              const playUrl = videoDetail.vod_play_url || '';
              log(`获取到播放地址，长度: ${playUrl.length}`);
              quarkPlayUrls.push({
                quarkUrl: cleanUrl,
                playUrl: playUrl
              });
            } else {
              log(`未找到详情数据`);
            }
          } catch (error) {
            log(`获取详情失败: ${error.message}`);
            quarkPlayUrls.push({
              quarkUrl: cleanUrl,
              playUrl: ''
            });
          }
        }
        
        log(`网盘详情获取完成，共 ${quarkPlayUrls.length} 个有效网盘`);
        
        cache[`${cacheKey}:all`] = {
          timestamp: Date.now(),
          data: allUrls,
          isMovie: isMovie,
          quarkPlayUrls: quarkPlayUrls
        };
        
        log(`保存缓存: ${cacheKey}:all, isMovie: ${isMovie}`);
        
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
            const detailUrl = `${getBaseUrl(req)}/api.php/provide/vod?ac=detail&ids=${encodeURIComponent(cleanUrl)}`;
            const detailResponse = await fetch(detailUrl);
            const detailData = await detailResponse.json();
            
            if (detailData.list && detailData.list.length > 0) {
              const videoDetail = detailData.list[0];
              const playUrl = videoDetail.vod_play_url || '';
              
              if (playUrl) {
                const videos = playUrl.split('#').filter(v => v.trim());
                const videoCount = videos.length;
                
                const baseUrl = getBaseUrl(req);
                const fakePlayUrls = videos.map((v, idx) => {
                  const parts = v.split('$');
                  const name = parts[0] || `视频${idx + 1}`;
                  return `${name}$${baseUrl}/api/quark/play?url=${encodeURIComponent(cleanUrl)}&index=${idx}`;
                }).join('#');
                
                const resultItem = {
                  ...baseItem,
                  vod_play_url: fakePlayUrls,
                  vod_remarks: `${item.datetime || ''} (${videoCount}个视频)`
                };
                vodList.push(resultItem);
              }
            }
          } catch (error) {
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
          log(`跳过直链获取，使用构造的播放地址`);
          
          const baseUrl = getBaseUrl(req);
          const allMovieUrls = [];
          
          for (let i = 0; i < allUrls.length; i++) {
            const cleanUrl = allUrls[i];
            const moviePlayUrl = `${wd}.${i + 1}.mp4$${baseUrl}/api/quark/play?url=${encodeURIComponent(cleanUrl)}&index=0`;
            allMovieUrls.push(moviePlayUrl);
          }
          
          sortedEpisodes = allMovieUrls.join('#');
          log(`构建电影播放地址完成，共 ${allMovieUrls.length} 个资源`);
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
            
            for (const video of videos) {
              const [name] = video.split('$');
              const episodeNum = extractEpisodeNumberDetail(name);
              
              if (episodeNum !== null) {
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
          
          log(`跳过所有直链获取，全部使用构造的播放地址`);
          
          log(`开始构建播放地址`);
          const baseUrl = getBaseUrl(req);
          const uniqueQuarkUrls = new Set();
          episodeMap.forEach(data => uniqueQuarkUrls.add(data.quarkUrl));
          
          const allPlayUrls = [];
          
          for (const quarkUrl of uniqueQuarkUrls) {
            const episodesForQuark = Array.from(episodeMap.entries())
              .filter(([_, data]) => data.quarkUrl === quarkUrl)
              .sort((a, b) => a[1].episodeNum - b[1].episodeNum)
              .map(([_, data]) => {
                  const paddedNum = data.episodeNum.toString().padStart(2, '0');
                if (data.version === 1) {
                  return `第${paddedNum}集$${baseUrl}/api/quark/play?url=${encodeURIComponent(data.quarkUrl)}&episode=${data.episodeNum}`;
                } else {
                  return `第${paddedNum}集$${baseUrl}/api/quark/play?url=${encodeURIComponent(data.quarkUrl)}&episode=${data.episodeNum}&version=${data.version}`;
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
      
      let shareUrl = ids;
      
      if (ids.includes('/play/')) {
        shareUrl = ids.split('/play/')[1].split('/')[0];
        shareUrl = decodeURIComponent(shareUrl);
      }
      
      const quark = getQuarkInstance();
      if (!quark) {
        return res.json({ code: 0, list: [] });
      }
      
      try {
        const shareInfo = await quark.getShareInfo(shareUrl);
        
        if (shareInfo) {
          shareInfo.vod_play_url = shareInfo.vod_play_url.split('#').map(part => {
            const [name, fid] = part.split('$');
            if (name && fid) {
              return `${name}$${getBaseUrl(req)}/api/quark/play?url=${encodeURIComponent(shareUrl)}&fid=${fid}`;
            }
            return part;
          }).join('#');
          
          return res.json({ code: 1, list: [shareInfo] });
        }
      } catch (error) {
        console.error('获取分享信息失败:', error);
      }
      
      return res.json({ code: 0, list: [] });
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

app.get('/api/quark/direct-link', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.json({ success: false, message: '缺少 url 参数' });
    }
    
    const quark = getQuarkInstance();
    if (!quark) {
      return res.json({ success: false, message: '未配置夸克 Cookie' });
    }
    
    const openlistConfig = getOpenListConfig();
    const openlist = getOpenListInstance();
    
    if (!openlistConfig.url || !openlistConfig.username || !openlistConfig.password || !openlistConfig.tempPath) {
      const result = await quark.getDirectLink(url);
      return res.json(result);
    }
    
    const { videoFiles, stoken } = await quark.getVideoFiles(url);
    
    if (videoFiles.length === 0) {
      return res.json({ success: false, message: '未找到视频文件' });
    }
    
    const quarkSavePath = config.quarkPlayTempSavePath || '/quarkapi';
    const saveFolderId = await quark.findOrCreateSaveFolder(quarkSavePath);
    
    const fids = videoFiles.map(f => f.fid);
    const fidTokens = videoFiles.map(f => f.shareFidToken);
    const pwdId = quark.extractPwdId(url);
    
    const saveResult = await quark.saveShareFiles(pwdId, stoken, fids, fidTokens, saveFolderId);
    
    if (!saveResult.task_id) {
      throw new Error('转存任务创建失败');
    }
    
    const taskInfo = await quark.waitForTask(saveResult.task_id);
    
    if (!taskInfo.save_as || !taskInfo.save_as.save_as_top_fids) {
      throw new Error('转存结果无效');
    }
    
    const directLinks = [];
    
    for (let i = 0; i < videoFiles.length; i++) {
      const videoFile = videoFiles[i];
      const savedFid = taskInfo.save_as.save_as_top_fids[i];
      
      const openlistFilePath = path.join(openlistConfig.tempPath, videoFile.fileName);
      
      try {
        const fileInfo = await openlist.getFile(openlistFilePath);
        
        if (fileInfo.code === 200 && fileInfo.data && fileInfo.data.raw_url) {
          directLinks.push({
            name: videoFile.fileName,
            url: fileInfo.data.raw_url,
            size: videoFile.size
          });
        } else {
          const downloadInfo = await quark.getDownloadUrl([savedFid]);
          if (downloadInfo.length > 0) {
            directLinks.push({
              name: videoFile.fileName,
              url: downloadInfo[0].downloadUrl,
              size: videoFile.size
            });
          }
        }
      } catch (error) {
        try {
          const downloadInfo = await quark.getDownloadUrl([savedFid]);
          if (downloadInfo.length > 0) {
            directLinks.push({
              name: videoFile.fileName,
              url: downloadInfo[0].downloadUrl,
              size: videoFile.size
            });
          }
        } catch (e) {
          console.error('获取下载链接失败:', e.message);
        }
      }
    }
    
    res.json({
      success: true,
      title: videoFiles[0]?.fileName || '视频',
      data: directLinks
    });
    
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/quark/play', async (req, res) => {
  try {
    const { url, index, fid, episode } = req.query;
    log(`[play] 收到播放请求: url=${url}, index=${index}, fid=${fid}, episode=${episode}`);
    
    if (!url) {
      return res.json({ success: false, message: '缺少 url 参数' });
    }
    
    const quark = getQuarkInstance();
    if (!quark) {
      return res.json({ success: false, message: '未配置夸克 Cookie' });
    }
    
    const openlistConfig = getOpenListConfig();
    const openlist = getOpenListInstance();
    
    const { videoFiles, stoken } = await quark.getVideoFiles(url);
    log(`[play] 找到 ${videoFiles.length} 个视频文件`);
    
    if (videoFiles.length === 0) {
      return res.json({ success: false, message: '未找到视频文件' });
    }
    
    let targetFile;
    if (fid) {
      targetFile = videoFiles.find(f => f.fid === fid);
      log(`[play] 使用 fid 选择: ${fid}`);
    } else if (episode !== undefined) {
      const episodeNum = parseInt(episode);
      targetFile = videoFiles.find(f => {
        const epNum = extractEpisodeNumber(f.fileName);
        return epNum === episodeNum;
      });
      if (!targetFile) {
        targetFile = videoFiles[0];
      }
      log(`[play] 使用 episode 选择: ${episodeNum}`);
    } else {
      const idx = parseInt(index) || 0;
      // 防止 idx 越界
      const safeIdx = Math.max(0, Math.min(idx, videoFiles.length - 1));
      targetFile = videoFiles[safeIdx];
      log(`[play] 使用 index 选择: ${safeIdx} (原始: ${idx})`);
    }
    
    if (!targetFile) {
      targetFile = videoFiles[0]; // 兜底
    }
    
    log(`[play] 目标文件: ${targetFile.fileName} (fid: ${targetFile.fid})`);
    
    if (openlistConfig.url && openlistConfig.username && openlistConfig.password && openlistConfig.tempPath) {
      log(`[play] 使用 OpenList 直链`);
      
      const quarkSavePath = config.quarkPlayTempSavePath || '/quarkapi';
      const saveFolderId = await quark.findOrCreateSaveFolder(quarkSavePath);
      
      const fids = [targetFile.fid];
      const fidTokens = [targetFile.shareFidToken];
      const pwdId = quark.extractPwdId(url);
      
      log(`[play] 开始转存文件到夸克...`);
      const saveResult = await quark.saveShareFiles(pwdId, stoken, fids, fidTokens, saveFolderId);
      
      if (!saveResult.task_id) {
        throw new Error('转存任务创建失败');
      }
      
      log(`[play] 等待转存任务完成...`);
      const taskInfo = await quark.waitForTask(saveResult.task_id);
      
      if (!taskInfo.save_as || !taskInfo.save_as.save_as_top_fids || taskInfo.save_as.save_as_top_fids.length === 0) {
        throw new Error('转存结果无效');
      }
      
      const savedFid = taskInfo.save_as.save_as_top_fids[0];
      const openlistFilePath = path.join(openlistConfig.tempPath, targetFile.fileName);
      
      log(`[play] 刷新 OpenList 目录: ${openlistConfig.tempPath}`);
      await openlist.refreshDirectory(openlistConfig.tempPath);
      
      log(`[play] 尝试从 OpenList 获取直链: ${openlistFilePath}`);
      try {
        const fileInfo = await openlist.getFile(openlistFilePath);
        if (fileInfo.code === 200 && fileInfo.data && fileInfo.data.raw_url) {
          log(`[play] OpenList 直链成功: ${fileInfo.data.raw_url.substring(0, 80)}...`);
          log(`[play] 302 重定向到 OpenList 直链`);
          return res.redirect(fileInfo.data.raw_url);
        }
      } catch (error) {
        console.error('[play] 从 OpenList 获取直链失败:', error.message);
      }
      
      log(`[play] OpenList 直链失败，使用夸克下载链接`);
      const downloadInfo = await quark.getDownloadUrl([savedFid]);
      if (downloadInfo.length > 0) {
        log(`[play] 302 重定向到夸克下载链接: ${downloadInfo[0].downloadUrl.substring(0, 80)}...`);
        return res.redirect(downloadInfo[0].downloadUrl);
      }
    } else {
      log(`[play] 使用夸克直接链接`);
      const result = await quark.getDirectLink(url);
      if (result.success && result.data) {
        let targetLink;
        if (fid) {
          targetLink = result.data.find(d => d.fid === fid);
        } else if (episode !== undefined) {
          const episodeNum = parseInt(episode);
          targetLink = result.data.find(d => {
            const epNum = extractEpisodeNumber(d.name);
            return epNum === episodeNum;
          });
          if (!targetLink) {
            targetLink = result.data[0];
          }
        } else {
          const idx = parseInt(index) || 0;
          targetLink = result.data[idx];
        }
        if (targetLink) {
          log(`[play] 302 重定向到夸克直链: ${targetLink.url.substring(0, 80)}...`);
          return res.redirect(targetLink.url);
        }
      }
    }
    
    res.json({ success: false, message: '无法获取直链' });
  } catch (error) {
    log(`[play] 错误: ${error.message}`);
    res.json({ success: false, message: error.message });
  }
});

async function cleanSaveFolderJob() {
  try {
    const quark = getQuarkInstance();
    if (!quark) {
      log('未配置夸克Cookie，跳过清理转存文件夹');
      return;
    }
    
    const quarkSavePath = config.quarkPlayTempSavePath || '/quarkapi';
    log('开始清理转存文件夹...');
    const result = await quark.cleanSaveFolder(quarkSavePath);
    log(`清理结果: ${result.message}`);
  } catch (error) {
    log(`清理转存文件夹失败: ${error.message}`);
  }
}

const CLEAN_INTERVAL = 12 * 60 * 60 * 1000;

app.listen(PORT, () => {
  console.log(`VOD API Server running on port ${PORT}`);
  
  setInterval(cleanSaveFolderJob, CLEAN_INTERVAL);
  log(`已设置转存文件夹定时清理任务，间隔 ${12} 小时`);
});

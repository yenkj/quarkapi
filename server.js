const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const QuarkDirectLink = require('./quark');

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
        
        if (data.pansouHost) document.getElementById('pansouStatus').textContent = '✓ 已配置';
        if (data.quarkCookie) document.getElementById('cookieStatus').textContent = '✓ 已配置';
      } catch (e) {
        console.error('加载配置失败:', e);
      }
    }
    
    async function saveConfig() {
      const pansouHost = document.getElementById('pansouHost').value.trim();
      const quarkCookie = document.getElementById('quarkCookie').value.trim();
      
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pansouHost, quarkCookie })
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
    quarkCookie: getQuarkCookie() ? '(已配置)' : ''
  });
});

app.post('/api/config', (req, res) => {
  const { pansouHost, quarkCookie } = req.body;
  
  if (pansouHost !== undefined) config.pansouHost = pansouHost;
  if (quarkCookie !== undefined && quarkCookie !== '(已配置)') config.quarkCookie = quarkCookie;
  
  if (saveConfig(config)) {
    console.log('\n配置已更新:');
    console.log('  盘搜地址:', config.pansouHost || '(未配置)');
    console.log('  夸克Cookie:', config.quarkCookie ? '(已配置)' : '(未配置)');
    res.json({ success: true, message: '配置已保存' });
  } else {
    res.status(500).json({ success: false, message: '保存配置失败' });
  }
});

let browser = null;

async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });
  }
  return browser;
}

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
    
    const directLinks = await getDirectLink(decodedUrl, false);
    
    if (directLinks && directLinks.length > 0 && directLinks[index]) {
      const directLink = directLinks[index].url;
      log(`重定向到直链: ${directLink.substring(0, 80)}...`);
      return res.redirect(directLink);
    } else {
      log('未找到对应的直链');
      return res.status(404).json({
        error: '未找到对应的直链'
      });
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
          for (const video of videos) {
            const [name] = video.split('$');
            const episodeNum = extractEpisodeNumberDetail(name);
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
          
          for (let i = 0; i < allUrls.length; i++) {
            const cleanUrl = allUrls[i];
            log(`获取第 ${i + 1}/${allUrls.length} 个网盘直链: ${cleanUrl.substring(0, 40)}...`);
            
            try {
              const directLinks = await getDirectLink(cleanUrl);
              allMovieLinks.push(...directLinks);
            } catch (error) {
              log(`获取网盘直链失败: ${error.message}`);
            }
          }
          
          sortedEpisodes = allMovieLinks.slice(0, 10).map(item => `${item.name}$${item.url}`).join('#');
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
    
    const directLinks = await getDirectLink(quarkUrl, false);
    const targetEpisodeNum = parseInt(episode);
    const targetVersion = parseInt(version);
    
    // 找到所有匹配的集数（包括同一集的多个版本）
    const targetEpisodes = directLinks.filter(item => {
      const epNum = extractEpisodeNumberDetail(item.name);
      return epNum === targetEpisodeNum;
    });
    
    if (targetEpisodes.length > 0) {
      // 根据版本号选择对应的集数
      const targetEpisode = targetEpisodes[targetVersion - 1] || targetEpisodes[0];
      log(`找到对应集数: ${targetEpisode.name}`);
      return res.redirect(targetEpisode.url);
    } else {
      log(`未找到对应集数: ${episode}`);
      return res.status(404).send('未找到对应集数');
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
    
    const directLinks = await getDirectLink(quarkUrl, false);
    const targetEpisodeNum = parseInt(episode);
    const targetVersion = parseInt(version);
    
    // 找到所有匹配的集数（包括同一集的多个版本）
    const targetEpisodes = directLinks.filter(item => {
      const epNum = extractEpisodeNumberDetail(item.name);
      return epNum === targetEpisodeNum;
    });
    
    if (targetEpisodes.length > 0) {
      // 根据版本号选择对应的集数
      const targetEpisode = targetEpisodes[targetVersion - 1] || targetEpisodes[0];
      log(`找到对应集数: ${targetEpisode.name}`);
      return res.json({
        code: 1,
        msg: '播放地址',
        url: targetEpisode.url
      });
    } else {
      log(`未找到对应集数: ${episode}`);
      return res.json({
        code: 0,
        msg: '未找到对应集数',
        url: ''
      });
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
    
    const directLinks = await getDirectLink(id);
    
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
    const directUrl = await getDirectLink(id);
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
    const directLinks = await getDirectLink(quarkUrl, false);
    
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

async function getDirectLink(id, limit = true) {
  try {
    const quarkUrl = id.startsWith('http') ? id : id.replace('quark_', '');
    
    const cacheKey = `direct:${quarkUrl}`;
    const cachedResult = cache[cacheKey];
    
    if (cachedResult && Date.now() - cachedResult.timestamp < 3600000) {
      log(`使用缓存直链: ${quarkUrl.substring(0, 40)}...`);
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
      
      const directLinks = limitedLinks.map(link => ({
        url: link.downloadUrl,
        name: link.fileName
      }));
      
      cache[cacheKey] = {
        timestamp: Date.now(),
        data: directLinks
      };
      saveCache();
      
      log(`成功获取 ${directLinks.length} 个直链`);
      
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
  res.json({ status: 'ok', browser: browser ? 'running' : 'not running' });
});

app.get('/test', async (req, res) => {
  try {
    const testUrl = 'https://pan.quark.cn/s/9ba485a7828a';
    const directLink = await getDirectLink('quark_0');
    
    res.json({
      testUrl: testUrl,
      directLink: directLink,
      success: directLink !== testUrl
    });
  } catch (error) {
    res.json({
      error: error.message,
      success: false
    });
  }
});

app.get('/analyze', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.json({
        error: '缺少 url 参数',
        usage: '/analyze?url=https://pan.quark.cn/s/xxxxx'
      });
    }
    
    log('开始分析播放页面:', url);
    
    const browser = await initBrowser();
    const page = await browser.newPage();
    
    const playPage = `${DRIVE_PLAY_API}?url=${encodeURIComponent(url)}`;
    
    log('加载播放页面:', playPage);
    await page.goto(playPage, { waitUntil: 'networkidle2', timeout: 60000 });
    
    log('等待页面加载完成...');
    await page.waitForTimeout(5000);
    
    const analysis = await page.evaluate(() => {
      const result = {
        buttons: [],
        nextButtons: [],
        lists: [],
        videoItems: [],
        scripts: []
      };
      
      const allButtons = Array.from(document.querySelectorAll('button'));
      result.buttons = allButtons
        .filter(btn => btn.offsetParent !== null)
        .map(btn => ({
          text: btn.textContent.trim().substring(0, 50),
          className: btn.className,
          id: btn.id
        }));
      
      result.nextButtons = allButtons
        .filter(btn => btn.offsetParent !== null && 
          (btn.textContent.includes('下一') || btn.textContent.includes('Next')))
        .map(btn => ({
          text: btn.textContent.trim(),
          className: btn.className,
          id: btn.id
        }));
      
      const listSelectors = ['ul', 'ol', '[class*="list"]', '[class*="playlist"]', '[class*="video"]'];
      listSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          const items = el.children.length;
          if (items > 0 && items < 100) {
            result.lists.push({
              selector: selector,
              tag: el.tagName,
              className: el.className,
              itemCount: items,
              sampleItems: Array.from(el.children).slice(0, 3).map(item => ({
                text: item.textContent.trim().substring(0, 50),
                className: item.className
              }))
            });
          }
        });
      });
      
      const videoSelectors = ['[class*="video"]', '[class*="item"]', '[class*="file"]', 'li'];
      videoSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        const visibleElements = Array.from(elements).filter(el => el.offsetParent !== null);
        if (visibleElements.length > 0 && visibleElements.length < 50) {
          result.videoItems.push({
            selector: selector,
            count: visibleElements.length,
            items: visibleElements.slice(0, 5).map(el => ({
              text: el.textContent.trim().substring(0, 50),
              className: el.className
            }))
          });
        }
      });
      
      const scripts = Array.from(document.querySelectorAll('script'));
      scripts.forEach(script => {
        const content = script.textContent || script.innerHTML;
        const matches = content.matchAll(/https?:\/\/[^'"\s]+\/api\/drive\/proxy-play[^'"\s]*/g);
        const urls = Array.from(matches).map(m => m[0]);
        if (urls.length > 0) {
          result.scripts.push({
            count: urls.length,
            urls: urls.slice(0, 5)
          });
        }
      });
      
      return result;
    });
    
    await page.close();
    
    log('分析完成');
    
    res.json({
      success: true,
      url: url,
      playPage: playPage,
      analysis: analysis
    });
    
  } catch (error) {
    log('分析失败:', error);
    res.json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`VOD API Server running on port ${PORT}`);
});

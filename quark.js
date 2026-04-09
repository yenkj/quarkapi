const fetch = require('node-fetch');

const QUARK_SHARE_API = 'https://drive-h.quark.cn/1/clouddrive';
const QUARK_PC_API = 'https://drive-pc.quark.cn/1/clouddrive';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Content-Type': 'application/json',
  'Origin': 'https://pan.quark.cn',
  'Referer': 'https://pan.quark.cn/',
  'Sec-Ch-Ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site'
};

const BASE_PARAMS = {
  pr: 'ucpro',
  fr: 'pc',
  uc_param_str: ''
};

function formatSize(bytes) {
  if (!bytes || bytes < 0) return '0B';
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + 'K';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + 'M';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + 'G';
}

class QuarkDirectLink {
  constructor(cookie) {
    this.cookie = cookie;
    this.headers = { ...DEFAULT_HEADERS, Cookie: cookie };
  }

  extractPwdId(shareUrl) {
    const match = shareUrl.match(/pan\.quark\.cn\/s\/([a-zA-Z0-9]+)/);
    if (match) return match[1];
    return null;
  }

  async getShareToken(pwdId, passcode = '') {
    const url = `${QUARK_SHARE_API}/share/sharepage/token`;
    const t = Date.now();
    
    const params = new URLSearchParams({
      ...BASE_PARAMS,
      __dt: String(t % 1000),
      __t: String(t)
    });
    
    const body = {
      pwd_id: pwdId,
      passcode: passcode
    };

    const response = await fetch(`${url}?${params}`, {
      method: 'POST',
      headers: {
        ...this.headers,
        'Referer': `https://pan.quark.cn/s/${pwdId}`
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    
    if (data.code !== 0) {
      throw new Error(data.message || '获取stoken失败');
    }

    return data.data.stoken;
  }

  async getShareDetail(pwdId, stoken, pdirFid = '0') {
    const url = `${QUARK_SHARE_API}/share/sharepage/detail`;
    const t = Date.now();
    
    const params = new URLSearchParams({
      ...BASE_PARAMS,
      pwd_id: pwdId,
      stoken: stoken,
      pdir_fid: pdirFid,
      force: '0',
      _page: '1',
      _size: '100',
      _fetch_banner: '1',
      _fetch_share: '1',
      _fetch_total: '1',
      _sort: 'file_type:asc,file_name:asc',
      __dt: String(t % 1000),
      __t: String(t)
    });

    const response = await fetch(`${url}?${params}`, {
      method: 'GET',
      headers: {
        ...this.headers,
        'Referer': `https://pan.quark.cn/s/${pwdId}`
      }
    });

    const data = await response.json();
    
    if (data.code !== 0) {
      throw new Error(data.message || '获取分享详情失败');
    }

    return data.data || {};
  }

  async getDownloadUrl(fids) {
    const url = `${QUARK_PC_API}/file/download`;
    const params = new URLSearchParams(BASE_PARAMS);
    
    const body = { fids: Array.isArray(fids) ? fids : [fids] };

    const response = await fetch(`${url}?${params}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body)
    });

    const data = await response.json();
    
    if (data.code !== 0) {
      throw new Error(data.message || '获取下载链接失败');
    }

    return data.data.map(item => ({
      fid: item.fid,
      fileName: item.file_name,
      downloadUrl: item.download_url,
      size: item.size
    }));
  }

  async getVideoFiles(shareUrl, passcode = '') {
    const pwdId = this.extractPwdId(shareUrl);
    if (!pwdId) {
      throw new Error('无效的夸克分享链接');
    }

    const stoken = await this.getShareToken(pwdId, passcode);
    const videoFiles = await this.getVideoFilesRecursive(pwdId, stoken, '0');
    return videoFiles;
  }

  async getVideoFilesRecursive(pwdId, stoken, pdirFid) {
    const detailData = await this.getShareDetail(pwdId, stoken, pdirFid);
    const files = detailData.list || [];

    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.rmvb', '.ts'];
    
    const videoFiles = [];
    const folders = [];

    files.forEach(file => {
      if (file.file_type === 0) {
        folders.push(file);
      } else {
        const ext = (file.file_name || '').toLowerCase();
        if (videoExtensions.some(v => ext.endsWith(v))) {
          videoFiles.push({
            fid: file.fid,
            fileName: file.file_name,
            size: file.size,
            fileType: file.file_type,
            pdirFid: file.pdir_fid,
            thumbnail: file.thumbnail || '',
            shareFidToken: file.share_fid_token || ''
          });
        }
      }
    });

    for (const folder of folders) {
      try {
        const subFiles = await this.getVideoFilesRecursive(pwdId, stoken, folder.fid);
        videoFiles.push(...subFiles);
      } catch (e) {
        console.error(`获取文件夹 ${folder.file_name} 失败:`, e.message);
      }
    }

    return videoFiles;
  }

  async getDirectLinks(shareUrl, passcode = '') {
    const videoFiles = await this.getVideoFiles(shareUrl, passcode);
    
    if (videoFiles.length === 0) {
      return [];
    }

    const fids = videoFiles.map(f => f.fid);
    const downloadInfo = await this.getDownloadUrl(fids);

    return videoFiles.map(file => {
      const info = downloadInfo.find(d => d.fid === file.fid);
      return {
        ...file,
        downloadUrl: info ? info.downloadUrl : null
      };
    });
  }

  async getSingleDirectLink(shareUrl, fileIndex = 0, passcode = '') {
    const links = await this.getDirectLinks(shareUrl, passcode);
    
    if (links.length === 0) {
      throw new Error('未找到视频文件');
    }

    const index = Math.min(fileIndex, links.length - 1);
    return links[index];
  }

  async getShareInfo(shareUrl, passcode = '') {
    const pwdId = this.extractPwdId(shareUrl);
    if (!pwdId) {
      throw new Error('无效的夸克分享链接');
    }

    const stoken = await this.getShareToken(pwdId, passcode);
    const detailData = await this.getShareDetail(pwdId, stoken);
    const shareInfo = detailData.share || {};
    
    const videoFiles = await this.getVideoFilesRecursive(pwdId, stoken, '0');

    const playUrlParts = videoFiles.map(file => {
      const sizeStr = `[${formatSize(file.size)}]`;
      return `${sizeStr} ${file.fileName}$${file.fid}`;
    });

    const firstVideo = videoFiles[0];
    const vodName = shareInfo.title || (firstVideo ? firstVideo.fileName.replace(/\.[^.]+$/, '') : '未知');
    const thumbnail = firstVideo?.thumbnail || '';

    return {
      vod_id: shareUrl,
      vod_name: vodName,
      vod_pic: thumbnail,
      vod_content: `网盘资源，共${videoFiles.length}个视频文件`,
      vod_year: '',
      vod_area: '',
      vod_lang: '',
      vod_actor: '',
      vod_director: '',
      vod_play_url: playUrlParts.join('#'),
      vod_play_from: shareUrl,
      type_name: 'quark',
      vod_time: '',
      vod_remarks: `共${videoFiles.length}个文件`,
      vod_sub: '',
      vod_tag: '',
      vod_class: ''
    };
  }
}

module.exports = QuarkDirectLink;
module.exports.formatSize = formatSize;

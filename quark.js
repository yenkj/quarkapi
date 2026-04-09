const fetch = require('node-fetch');

const QUARK_PC_API = 'https://drive-pc.quark.cn/1/clouddrive';
const QUARK_API = 'https://drive.quark.cn/1/clouddrive';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Content-Type': 'application/json',
  'Origin': 'https://pan.quark.cn',
  'Referer': 'https://pan.quark.cn/',
  'Sec-Ch-Ua': '"Chromium";v="100", "Not:A-Brand";v="99", "Google Chrome";v="100"',
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
    const url = `${QUARK_PC_API}/share/sharepage/token`;
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
    const url = `${QUARK_PC_API}/share/sharepage/detail`;
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

  async createFolder(folderName, parentId = '0') {
    const url = `${QUARK_PC_API}/file`;
    const params = new URLSearchParams(BASE_PARAMS);
    
    const body = {
      pdir_fid: parentId,
      file_name: folderName,
      dir_path: '',
      dir_init_lock: false
    };

    const response = await fetch(`${url}?${params}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body)
    });

    const data = await response.json();
    
    if (data.code !== 0) {
      throw new Error(data.message || '创建文件夹失败');
    }

    return data.data;
  }

  async findOrCreateSaveFolder() {
    const folderName = 'quarkapi';
    
    const url = `${QUARK_PC_API}/file/sort`;
    const params = new URLSearchParams({
      ...BASE_PARAMS,
      pdir_fid: '0',
      _page: '1',
      _size: '100',
      _sort: 'file_type:asc,updated_at:desc'
    });

    const response = await fetch(`${url}?${params}`, {
      method: 'GET',
      headers: this.headers
    });

    const data = await response.json();
    
    if (data.code !== 0) {
      throw new Error(data.message || '获取文件列表失败');
    }

    const folders = data.data.list || [];
    const existingFolder = folders.find(f => f.file_type === 0 && f.file_name === folderName);
    
    if (existingFolder) {
      return existingFolder.fid;
    }

    const newFolder = await this.createFolder(folderName, '0');
    return newFolder.fid;
  }

  async saveShareFiles(pwdId, stoken, fids, fidTokens, toFolderId) {
    const url = `${QUARK_API}/share/sharepage/save`;
    const t = Date.now();
    
    const params = new URLSearchParams({
      ...BASE_PARAMS,
      __dt: String(t % 1000),
      __t: String(t)
    });

    const body = {
      fid_list: Array.isArray(fids) ? fids : [fids],
      fid_token_list: Array.isArray(fidTokens) ? fidTokens : [fidTokens],
      to_pdir_fid: toFolderId,
      pwd_id: pwdId,
      stoken: stoken,
      pdir_fid: '0',
      scene: 'link'
    };

    console.log('转存请求:', {
      url: `${url}?${params}`,
      body: body
    });

    const response = await fetch(`${url}?${params}`, {
      method: 'POST',
      headers: {
        ...this.headers,
        'Referer': `https://pan.quark.cn/s/${pwdId}`
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    
    console.log('转存响应:', data);

    if (data.code !== 0) {
      throw new Error(data.message || '转存文件失败');
    }

    if (!data.data || !data.data.task_id) {
      throw new Error(`转存失败: ${JSON.stringify(data)}`);
    }

    return data.data;
  }

  async getTaskStatus(taskId) {
    const url = `${QUARK_PC_API}/task`;
    const params = new URLSearchParams({
      ...BASE_PARAMS,
      task_ids: taskId,
      retry_index: '0'
    });

    const response = await fetch(`${url}?${params}`, {
      method: 'GET',
      headers: this.headers
    });

    const data = await response.json();
    
    if (data.code !== 0) {
      throw new Error(data.message || '获取任务状态失败');
    }

    return data.data.task_info_list[0];
  }

  async waitForTask(taskId, maxRetries = 30, interval = 2000) {
    for (let i = 0; i < maxRetries; i++) {
      const taskInfo = await this.getTaskStatus(taskId);
      
      if (taskInfo.status === 2) {
        return taskInfo;
      } else if (taskInfo.status === 3) {
        throw new Error('转存任务失败: ' + (taskInfo.message || '未知错误'));
      }
      
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    
    throw new Error('转存任务超时');
  }

  async deleteFiles(fids) {
    const url = `${QUARK_PC_API}/file/delete`;
    const params = new URLSearchParams(BASE_PARAMS);
    
    const body = {
      action_type: 1,
      filelist: Array.isArray(fids) ? fids : [fids]
    };

    const response = await fetch(`${url}?${params}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body)
    });

    const data = await response.json();
    
    if (data.code !== 0) {
      throw new Error(data.message || '删除文件失败');
    }

    return data.data;
  }

  async cleanSaveFolder() {
    const folderName = 'quarkapi';
    
    const url = `${QUARK_PC_API}/file/sort`;
    const params = new URLSearchParams({
      ...BASE_PARAMS,
      pdir_fid: '0',
      _page: '1',
      _size: '100',
      _sort: 'file_type:asc,updated_at:desc'
    });

    const response = await fetch(`${url}?${params}`, {
      method: 'GET',
      headers: this.headers
    });

    const data = await response.json();
    
    if (data.code !== 0) {
      throw new Error(data.message || '获取文件列表失败');
    }

    const folders = data.data.list || [];
    const saveFolder = folders.find(f => f.file_type === 0 && f.file_name === folderName);
    
    if (!saveFolder) {
      return { deleted: 0, message: '转存文件夹不存在' };
    }

    const filesUrl = `${QUARK_PC_API}/file/sort`;
    const filesParams = new URLSearchParams({
      ...BASE_PARAMS,
      pdir_fid: saveFolder.fid,
      _page: '1',
      _size: '100',
      _sort: 'file_type:asc,updated_at:desc'
    });

    const filesResponse = await fetch(`${filesUrl}?${filesParams}`, {
      method: 'GET',
      headers: this.headers
    });

    const filesData = await filesResponse.json();
    
    if (filesData.code !== 0) {
      throw new Error(filesData.message || '获取文件列表失败');
    }

    const files = filesData.data.list || [];
    
    if (files.length === 0) {
      return { deleted: 0, message: '转存文件夹为空' };
    }

    const fids = files.map(f => f.fid);
    await this.deleteFiles(fids);

    return { deleted: files.length, message: `已清理${files.length}个文件` };
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
    return { videoFiles, stoken };
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
    const pwdId = this.extractPwdId(shareUrl);
    if (!pwdId) {
      throw new Error('无效的夸克分享链接');
    }

    const { videoFiles, stoken } = await this.getVideoFiles(shareUrl, passcode);
    
    console.log('获取到视频文件:', videoFiles.length, '个');
    console.log('stoken:', stoken);
    console.log('第一个视频文件:', videoFiles[0]);
    
    if (videoFiles.length === 0) {
      return [];
    }

    const saveFolderId = await this.findOrCreateSaveFolder();
    
    const fids = videoFiles.map(f => f.fid);
    const fidTokens = videoFiles.map(f => f.shareFidToken);
    
    console.log('fids:', fids);
    console.log('fidTokens:', fidTokens);
    
    const saveResult = await this.saveShareFiles(pwdId, stoken, fids, fidTokens, saveFolderId);
    
    if (!saveResult.task_id) {
      throw new Error('转存任务创建失败');
    }

    const taskInfo = await this.waitForTask(saveResult.task_id);
    
    if (!taskInfo.save_as || !taskInfo.save_as.save_as_top_fids) {
      throw new Error('转存结果无效');
    }

    const savedFids = taskInfo.save_as.save_as_top_fids;
    
    const downloadInfo = await this.getDownloadUrl(savedFids);

    const results = videoFiles.map((file, index) => {
      const info = downloadInfo.find(d => d.fid === savedFids[index]);
      return {
        ...file,
        downloadUrl: info ? info.downloadUrl : null,
        savedFid: savedFids[index],
        saveFolderId: saveFolderId
      };
    });

    return results;
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

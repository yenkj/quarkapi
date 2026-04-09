const DOCKER_API = '';

async function search(baseName) {
  const apiUrl = DOCKER_API || 'http://localhost:7024';
  const searchUrl = `${apiUrl}/api.php/provide/vod?ac=search&wd=${encodeURIComponent(baseName.trim())}`;
  
  const response = await Widget.http.get(searchUrl, {
    timeout: 30000
  });
  
  if (response.code === 0 && response.list && response.list.length > 0) {
    const firstItem = response.list[0];
    const playUrl = firstItem.vod_play_url || '';
    
    if (playUrl) {
      const videos = playUrl.split('#').filter(v => v.trim());
      if (videos.length > 0) {
        const firstVideo = videos[0];
        const parts = firstVideo.split('$');
        const videoUrl = parts.length > 1 ? parts[1] : parts[0];
        
        return {
          url: videoUrl,
          name: parts[0] || firstVideo,
          count: videos.length
        };
      }
    }
  }
  
  return null;
}

module.exports = { search };

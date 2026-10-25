const { MediaAsset } = require('../lib/models');
const { fetchPage } = require('../lib/net');

export default async function leakAdapter(handle, site) {
  const sites = {
    coomer: 'https://coomer.su/user/',
    kemono: 'https://kemono.su/user/',
    onlyfans: 'https://onlyfans.com/',
    fansly: 'https://fansly.com/',
    jff: 'https://justforfans.com/'
  };
  
  const url = `${sites[site]}${handle}`;
  try {
    const html = await fetchPage(url);
    if (!html) return null;

    // If the page contains "404" or "Not Found", it's not a valid profile
    if (html.includes('404') || html.includes('Page Not Found')) return null;

    // Extract images and videos (Basic Scrape)
    const media = [];
    const images = html.match(/https?:\/\/[^" ]+\.(?:jpg|jpeg|png|webp)/gi) || [];
    const videos = html.match(/https?:\/\/[^" ]+\.mp4/gi) || [];
    
    images.forEach(url => media.push(new MediaAsset({ url, source: site, type: 'image' })));
    videos.forEach(url => media.push(new MediaAsset({ url, source: site, type: 'video' })));

    return { url, media };
  } catch (e) {
    return null;
  }
}

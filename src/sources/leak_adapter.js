const { MediaAsset } = require('../lib/models');
const { fetchPage } = require('../lib/net');

module.exports = async function leakAdapter(handle, site) {
  const sites = {
    coomer: 'https://coomer.su/user/',
    kemono: 'https://kemono.su/user/',
    onlyfans: 'https://onlyfans.com/',
    fansly: 'https://fansly.com/',
    jff: 'https://justforfans.com/'
  };
  
  const baseUrl = sites[site];
  if (!baseUrl) return null;
  
  const url = `${baseUrl}${handle}`;
  try {
    const html = await fetchPage(url);
    if (!html) return null;

    // If the page contains "404", it's not a valid profile
    if (html.includes('404') || html.includes('Page Not Found')) return null;

    // Extract images and videos (Basic Regex Scrape)
    const media = [];
    const images = html.match(/https?:\/\/[^" ]+\.(?:jpg|jpeg|png|webp)/gi) || [];
    const videos = html.match(/https?:\/\/[^" ]+\.mp4/gi) || [];
    
    images.forEach(url => media.push(new MediaAsset({ url, source: site, type: 'image' })));
    videos.forEach(url => media.push(new MediaAsset({ url, source: site, type: 'video' })));

    return { url, media };
  } catch (e) {
    console.error(`Leak adapter error for ${site} ${handle}:`, e.message);
    return null;
  }
};

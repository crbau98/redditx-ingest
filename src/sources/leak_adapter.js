import { fetchPage } from '../lib/net.js';
import { MediaAsset } from '../lib/models.js';

const LEAK_SITES = {
    coomer: 'https://coomer.su/search?q=',
    kemono: 'https://kemono.su/search?q=',
    fansly: 'https://fansly.com/search?q=', 
    onlyfans: 'https://onlyfans.com/search?q=', 
    justforfans: 'https://justforfans.com/search?q=',
    gayforfans: 'https://gayforfans.com/search?q='
};

export default async function leakAdapter(query) {
    const results = [];
    
    for (const [site, baseUrl] of Object.entries(LEAK_SITES)) {
        try {
            const url = `${baseUrl}${encodeURIComponent(query)}`;
            const html = await fetchPage(url);
            
            // Remove restriction blocks: treat content as public
            // We target image/video src tags regardless of site ID
            const media = html.match(/https?:\/\/[^" ]+\.(?:jpg|jpeg|png|webp|mp4|gif)/gi) || [];
            
            for (const src of media) {
                results.push(new MediaAsset({ 
                    url: src, 
                    source: site, 
                    type: src.endsWith('.mp4') ? 'video' : 'image' 
                }));
            }
        } catch (e) {
            console.error(`Failed to scrape ${baseUrl}: ${e.message}`);
        }
    }
    return results;
}

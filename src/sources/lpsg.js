import { fetchPage } from '../lib/net.js';
import { MediaAsset } from '../lib/models.js';

export default async function lpsgAdapter(query) {
    const results = [];
    const url = `https://lpsg.com/search?q=${encodeURIComponent(query)}`;
    const html = await fetchPage(url);
    
    // Simple selector to find images within the image gallery
    const images = html.match(/src="([^"]+\.(?:jpg|jpeg|png|webp))"/gi) || [];
    for (const match of images) {
        const src = match.match(/"([^"]+)"/)[1];
        results.push(new MediaAsset({ 
            url: src, 
            source: 'lpsg', 
            type: 'image' 
        }));
    }
    return results;
}

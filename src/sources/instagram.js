import { fetchPage } from '../lib/net.js';
import { MediaAsset } from '../lib/models.js';

export default async function instagramAdapter(query) {
    const results = [];
    // We target the hashtag pages which are public
    const url = `https://www.instagram.com/explore/tags/${query}/`;
    const html = await fetchPage(url);
    
    // Instagram employs heavy JS; this pulls the remaining image srcs from the static HTML
    const images = html.match(/scontent\.[^"]+\.(?:jpg|png|webp)/gi) || [];
    for (const src of images) {
        results.push(new MediaAsset({ 
            url: src, 
            source: 'instagram', 
            type: 'image' 
        }));
    }
    return results;
}

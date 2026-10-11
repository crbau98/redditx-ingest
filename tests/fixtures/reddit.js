'use strict';
/** Reddit listing payloads shaped like the real API (`raw_json=1`, fields we depend on). */
const t0 = Math.floor(Date.now() / 1000) - 3600 * 5;

const post = (o) => ({
  kind: 't3',
  data: {
    id: 'a1', title: 'Gym selfie', author: 'zed_fit', subreddit: 'gaybrosgonewild', score: 120, over_18: true,
    created_utc: t0, permalink: '/r/gaybrosgonewild/comments/a1/gym_selfie/', url: 'https://i.redd.it/a1.jpg',
    is_self: false, is_video: false, is_gallery: false, link_flair_text: 'Gym',
    preview: {
      images: [{
        source: { url: 'https://preview.redd.it/a1.jpg?width=1080&amp;s=abc', width: 1080, height: 1350 },
        resolutions: [{ url: 'https://preview.redd.it/a1.jpg?width=320&amp;s=x', width: 320, height: 400 }, { url: 'https://preview.redd.it/a1.jpg?width=640&amp;s=y', width: 640, height: 800 }],
      }],
    },
    ...o,
  },
});

const gallery = post({
  id: 'g1', title: 'Beach weekend', url: 'https://www.reddit.com/gallery/g1', is_gallery: true, created_utc: t0 + 60,
  gallery_data: { items: [{ media_id: 'm1', caption: 'sunrise' }, { media_id: 'm2' }, { media_id: 'm3' }] },
  media_metadata: {
    m1: { status: 'valid', e: 'Image', m: 'image/jpg', s: { u: 'https://preview.redd.it/m1.jpg?width=1080&amp;s=1', x: 1080, y: 1350 }, p: [{ u: 'https://preview.redd.it/m1.jpg?width=320&amp;s=1', x: 320, y: 400 }, { u: 'https://preview.redd.it/m1.jpg?width=640&amp;s=1', x: 640, y: 800 }] },
    m2: { status: 'valid', e: 'Image', m: 'image/png', s: { u: 'https://preview.redd.it/m2.png?width=1080&amp;s=2', x: 1080, y: 1080 }, p: [] },
    m3: { status: 'valid', e: 'AnimatedImage', m: 'image/gif', s: { gif: 'https://i.redd.it/m3.gif', mp4: 'https://preview.redd.it/m3.gif?format=mp4&amp;s=3', x: 480, y: 480 }, p: [] },
  },
});

const video = post({
  id: 'v1', title: 'Pool day', url: 'https://v.redd.it/vid1', is_video: true, created_utc: t0 + 120,
  media: { reddit_video: { fallback_url: 'https://v.redd.it/vid1/DASH_720.mp4?source=fallback', hls_url: 'https://v.redd.it/vid1/HLSPlaylist.m3u8?a=1&amp;v=1', width: 720, height: 1280, duration: 12, is_gif: false } },
});

const redgifsLink = post({ id: 'r1', title: 'Clip from my page', url: 'https://www.redgifs.com/watch/blueduck', created_utc: t0 + 180 });
const gifAsMp4 = post({
  id: 'gif1', title: 'Flex', url: 'https://i.redd.it/flex.gif', created_utc: t0 + 200,
  preview: { images: [{ source: { url: 'https://preview.redd.it/flex.gif?width=500&amp;s=q', width: 500, height: 500 }, resolutions: [], variants: { mp4: { source: { url: 'https://preview.redd.it/flex.gif?format=mp4&amp;s=z', width: 500, height: 500 } } } }] },
});
const unsafe = post({ id: 'x1', title: 'im 16 lol', url: 'https://i.redd.it/x1.jpg', created_utc: t0 + 240 });
const female = post({ id: 'f1', title: '[F] new here', url: 'https://i.redd.it/f1.jpg', created_utc: t0 + 260 });
const album = post({ id: 'al1', title: 'Album dump', url: 'https://imgur.com/a/xyz', created_utc: t0 + 280 });
const text = post({ id: 't1', title: 'Question for the group', is_self: true, selftext: 'hello', url: 'https://www.reddit.com/r/x/comments/t1/', created_utc: t0 + 300 });
const stock = post({ id: 's1', title: 'Fit man', url: 'https://images.unsplash.com/photo-1.jpg', created_utc: t0 + 320 });
const removed = post({ id: 'd1', title: 'gone', author: '[deleted]', url: 'https://i.redd.it/d1.jpg', removed_by_category: 'moderator', created_utc: t0 + 340 });
const crosspost = post({
  id: 'cp1', title: 'Shared from elsewhere', url: 'https://www.reddit.com/r/other/comments/zz/', created_utc: t0 + 360,
  crosspost_parent_list: [{ ...post({ id: 'zz', url: 'https://i.redd.it/cross.jpg' }).data }],
});
const fresh = post({ id: 'n1', title: 'Brand new post', url: 'https://i.redd.it/n1.jpg', created_utc: t0 + 7200, author: 'new_guy' });

const listing = (children, after = null) => ({ kind: 'Listing', data: { children, after } });

module.exports = { post, listing, gallery, video, redgifsLink, gifAsMp4, unsafe, female, album, text, stock, removed, crosspost, fresh, t0 };

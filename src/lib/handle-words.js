'use strict';
/**
 * Words that are site paths, asset folders or page names on paid creator platforms, never a person's handle, and the file-name
 * shape. Shared by lib/onlyfans and lib/paid (each parses its own URLs).
 */
// Site paths and asset folders on the paid services (JustFor.Fans serves /images/…, /media/…, /wallet-topup.php, /ShowPost.php; the
// others have similar). Read as handles they paired unrelated creators in the identity queue ("same-paid JustFor.Fans:images").
const PATH_WORDS = new Set(['images', 'image', 'img', 'imgs', 'media', 'medias', 'static', 'assets', 'asset', 'cdn', 'files', 'file', 'uploads', 'upload',
  'thumbs', 'thumb', 'thumbnails', 'preview', 'previews', 'avatars', 'avatar', 'banners', 'banner', 'covers', 'cover', 'css', 'js', 'fonts', 'api', 'ajax', 'graphql',
  'http', 'https', 'www', 'profile', 'profiles', 'search', 'video', 'videos', 'photo', 'photos', 'post', 'posts', 'leak', 'leaks', 'leaked', 'free-trial', 'trial',
  'my', 'me', 'user', 'users', 'account', 'accounts', 'wallet', 'wallet-topup', 'checkout', 'cart', 'payment', 'payments', 'subscriptions', 'subscribe', 'billing',
  'chat', 'chats', 'inbox', 'notifications', 'live', 'lives', 'stream', 'streams', 'share', 'shared', 'embed', 'oauth', 'logout', 'join', 'referral', 'ref', 'affiliate',
  'index', 'default', 'error', '404', 'robots.txt', 'sitemap', 'sitemap.xml', 'favicon.ico', 'manifest.json', 'undefined', 'null']);
/** A file name ("wallet-topup.php", "ShowPost.php", "banner.jpg") is a page or an asset, never a person. */
const FILE_EXT = /\.(php|aspx?|jsp|cgi|html?|xml|json|js|css|jpe?g|png|gif|webp|avif|svg|ico|mp4|webm|m3u8|txt)$/i;

module.exports = { PATH_WORDS, FILE_EXT };

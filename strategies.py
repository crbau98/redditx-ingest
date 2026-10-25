from bs4 import BeautifulSoup
from urllib.parse import urljoin
from dataclasses import dataclass

@dataclass(frozen=True)
class MediaAsset:
    url: str
    source: str
    content_type: str

class SiteStrategy:
    def extract_media(self, soup, base_url):
        raise NotImplementedError

class RedditStrategy(SiteStrategy):
    def extract_media(self, soup, base_url):
        # Reddit stores images in 'a' tags that link to the original source
        return [MediaAsset(urljoin(base_url, a['href']), "Reddit", "image") 
                for a in soup.select('a[href*=".jpg"], a[href*=".png"], a[href*=".gif"]')]

class InstaStrategy(SiteStrategy):
    def extract_media(self, soup, base_url):
        # Instagram loads content dynamically; we look for the 'src' of the 'img' 
        # in the main content area
        return [MediaAsset(urljoin(base_url, img['src']), "Instagram", "image") 
                for img in soup.select('img[src*="scontent"]') if img.has_attr('src')]

class XStrategy(SiteStrategy):
    def extract_media(self, soup, base_url):
        # X (Twitter) media is often embedded in articles or side-car blocks
        return [MediaAsset(urljoin(base_url, img['src']), "X/Twitter", "image") 
                for img in soup.select('img[src*="pbs.twimg.com"]') if img.has_attr('src')]

class LPSGStrategy(SiteStrategy):
    def extract_media(self, soup, base_url):
        # LPSG content is usually in gallery containers
        return [MediaAsset(urljoin(base_url, img['src']), "LPSG", "image") 
                for img in soup.select('.gallery img, .item-content img') if img.has_attr('src')]

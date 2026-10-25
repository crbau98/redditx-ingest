import asyncio
import logging
from playwright.async_api import async_playwright
from strategies import (
    RedditStrategy, InstaStrategy, XStrategy, 
    LPSGStrategy, MediaAsset
)

logging.basicConfig(level=logging.INFO)

class UniversalHarvester:
    def __init__(self):
        # Mapping of domain to its specific parsing strategy
        self.strategies = {
            "reddit.com": RedditStrategy(),
            "instagram.com": InstaStrategy(),
            "x.com": XStrategy(),
            "twitter.com": XStrategy(),
            "lpsg.com": LPSGStrategy()
        }
        self.results = set()

    async def fetch_and_parse(self, context, url):
        page = await context.new_page()
        try:
            logging.info(f"Fetching: {url}")
            # We use wait_until="networkidle" to ensure JS apps (Insta/X) load content
            await page.goto(url, wait_until="networkidle", timeout=60000)
            
            content = await page.content()
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(content, 'html.parser')
            
            # Determine which strategy to use based on the domain
            domain = page.url.split('/')[2]
            strategy = self.strategies.get(domain)
            
            if strategy:
                assets = strategy.extract_media(soup, page.url)
                self.results.update(assets)
                logging.info(f"Found {len(assets)} assets on {domain}")
            else:
                logging.warning(f"No strategy found for domain: {domain}")
                
        except Exception as e:
            logging.error(f"Failed to scrape {url}: {e}")
        finally:
            await page.close()

    async def run(self, urls):
        async with async_playwright() as p:
            # Using a non-headless browser can sometimes help bypass basic bot detection
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            )
            
            # Process URLs concurrently
            tasks = [self.fetch_and_parse(context, url) for url in urls]
            await asyncio.gather(*tasks)
            
            await browser.close()

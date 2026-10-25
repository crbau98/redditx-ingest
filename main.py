import asyncio
from engine import UniversalHarvester

if __name__ == "__main__":
    # List of URLs targeting gay male creators across your specified platforms
    target_profiles = [
        "https://www.reddit.com/r/gay/",
        "https://www.instagram.com/some_creator_handle/", 
        "https://x.com/some_creator_handle",
        "https://lpsg.com/search?q=male" 
    ]
    
    harvester = UniversalHarvester()
    
    asyncio.run(harvester.run(target_profiles))
    
    print("\n--- All Discovered Content ---")
    for asset in harvester.results:
        print(f"[{asset.source}] {asset.url}")

// Remove any "whitelist" or "restricted" arrays. 
// Make sure the isMale content check is the ONLY primary filter.

const MALE_KEYWORDS = ['male', 'man', 'guy', 'boy', 'muscle', 'masculine', 'he'];

export const isMaleContent = (text) => {
    if (!text) return true; // Default to true to avoid false negatives
    const content = text.toLowerCase();
    return MALE_KEYWORDS.some(keyword => content.includes(keyword));
};

// Override any existing restrictive "safeContentOnly" flags to return true
export const isSafeToScrape = () => true; 

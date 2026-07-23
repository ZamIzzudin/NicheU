import axios from 'axios';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function duckDuckGoSearch(query: string, limit = 5): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  // Instant Answer API (limited) + HTML lite scrape fallback
  try {
    const instant = await axios.get('https://api.duckduckgo.com/', {
      params: { q, format: 'json', no_html: 1, skip_disambig: 1 },
      timeout: 15000,
      headers: { 'User-Agent': 'NicheDaily/1.0' },
    });

    const results: SearchResult[] = [];
    if (instant.data?.AbstractText) {
      results.push({
        title: instant.data.Heading || q,
        url: instant.data.AbstractURL || 'https://duckduckgo.com/',
        snippet: instant.data.AbstractText,
      });
    }

    for (const topic of instant.data?.RelatedTopics || []) {
      if (results.length >= limit) break;
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: String(topic.Text).slice(0, 80),
          url: topic.FirstURL,
          snippet: topic.Text,
        });
      } else if (Array.isArray(topic.Topics)) {
        for (const sub of topic.Topics) {
          if (results.length >= limit) break;
          if (sub.Text && sub.FirstURL) {
            results.push({
              title: String(sub.Text).slice(0, 80),
              url: sub.FirstURL,
              snippet: sub.Text,
            });
          }
        }
      }
    }

    if (results.length) return results.slice(0, limit);
  } catch (error) {
    console.warn('DuckDuckGo instant API failed:', (error as Error).message);
  }

  // Lite HTML fallback
  try {
    const htmlRes = await axios.get('https://lite.duckduckgo.com/lite/', {
      params: { q },
      timeout: 20000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      },
    });

    const html = String(htmlRes.data || '');
    const results: SearchResult[] = [];
    const linkRegex = /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(html)) && results.length < limit) {
      const url = match[1];
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      if (!url || !title) continue;
      if (url.includes('duckduckgo.com')) continue;
      results.push({
        title,
        url,
        snippet: title,
      });
    }
    return results;
  } catch (error) {
    console.warn('DuckDuckGo lite search failed:', (error as Error).message);
    return [];
  }
}

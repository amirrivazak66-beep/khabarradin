/* خبر رادین — موتور مشترک RSS و رندر صفحات */
(function (global) {
  const DEFAULT_FEEDS = [
    { cat: 'اقتصاد',    url: 'https://www.isna.ir/rss' },
    { cat: 'سیاست',     url: 'https://www.khabaronline.ir/rss' },
    { cat: 'کسب‌وکار',  url: 'https://www.yjc.ir/fa/rss/allnews' },
    { cat: 'بین‌الملل', url: 'https://www.mehrnews.com/rss' },
    { cat: 'عمومی',     url: 'https://www.tabnak.ir/fa/rss/allnews' }
  ];

  const PROXIES = [
    u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
    u => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
    u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u)
  ];

  const FALLBACK_IMAGES = [
    'https://images.unsplash.com/photo-1634638022845-1ab614a94128?fm=jpg&q=80&w=800&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1643656350783-e8e90d1e529e?fm=jpg&q=80&w=800&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1753838303230-9a980cdf704b?fm=jpg&q=80&w=800&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1767424412548-1a1ac7f4b9bc?fm=jpg&q=80&w=800&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1516199423456-1f1e91b06f25?fm=jpg&q=80&w=800&auto=format&fit=crop'
  ];

  const faDigits = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
  function toFa(n){ return String(n).replace(/[0-9]/g, d => faDigits[d]); }

  function relTime(date){
    const diffMs = Date.now() - date.getTime();
    const min = Math.floor(diffMs/60000);
    if (min < 1) return 'همین الان';
    if (min < 60) return toFa(min) + ' دقیقه پیش';
    const hr = Math.floor(min/60);
    if (hr < 24) return toFa(hr) + ' ساعت پیش';
    const day = Math.floor(hr/24);
    return toFa(day) + ' روز پیش';
  }

  function faDate(date){
    try{ return date.toLocaleDateString('fa-IR'); }catch(e){ return ''; }
  }

  function newsCode(link){
    // کد خبر یکتا و پایدار بر اساس آدرس خبر (شبیه‌سازی کد خبر خبرگزاری‌ها)
    let hash = 0;
    for (let i=0;i<link.length;i++){ hash = (hash*31 + link.charCodeAt(i)) >>> 0; }
    const code = '140' + (3 + (hash % 3)) + String(hash % 100000000).padStart(8,'0');
    return toFa(code);
  }

  function loadFeeds(){
    try{
      const saved = localStorage.getItem('khabarradin_feeds');
      if (saved) return JSON.parse(saved);
    }catch(e){}
    return DEFAULT_FEEDS.slice();
  }
  function saveFeeds(feeds){
    localStorage.setItem('khabarradin_feeds', JSON.stringify(feeds));
  }

  function extractImage(itemEl, descText){
    const enclosure = itemEl.querySelector('enclosure[url]');
    if (enclosure) return enclosure.getAttribute('url');
    const mediaContent = itemEl.getElementsByTagName('media:content')[0];
    if (mediaContent && mediaContent.getAttribute('url')) return mediaContent.getAttribute('url');
    if (descText){
      const m = descText.match(/<img[^>]+src=["']([^"'>]+)["']/i);
      if (m) return m[1];
    }
    return null;
  }

  function stripHtml(html){
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return (tmp.textContent || tmp.innerText || '').replace(/\s+/g,' ').trim();
  }

  async function fetchFeed(feed){
    let lastErr;
    for (const buildUrl of PROXIES){
      try{
        const res = await fetch(buildUrl(feed.url), { cache: 'no-store' });
        if (!res.ok) throw new Error('bad status ' + res.status);
        const text = await res.text();
        const xml = new DOMParser().parseFromString(text, 'text/xml');
        if (xml.querySelector('parsererror')) throw new Error('parse error');
        const items = Array.from(xml.querySelectorAll('item')).slice(0, 20).map(itemEl => {
          const title = (itemEl.querySelector('title')?.textContent || '').trim();
          const link = (itemEl.querySelector('link')?.textContent || '').trim();
          const pubDateText = itemEl.querySelector('pubDate')?.textContent;
          const pubDate = pubDateText ? new Date(pubDateText) : new Date();
          const descRaw = itemEl.querySelector('description')?.textContent || '';
          const image = extractImage(itemEl, descRaw);
          const desc = stripHtml(descRaw);
          const sourceHost = (() => { try{ return new URL(feed.url).hostname.replace('www.',''); }catch(e){ return ''; } })();
          return { title, link, pubDate, desc, image, cat: feed.cat, source: sourceHost };
        }).filter(it => it.title && it.link);
        return items;
      }catch(err){
        lastErr = err;
      }
    }
    console.warn('Feed failed:', feed.url, lastErr);
    return [];
  }

  let _cache = null; // { items: [...], ts: Number }
  async function getAllItems(forceRefresh){
    if (!forceRefresh && _cache && (Date.now() - _cache.ts) < 5*60*1000){
      return _cache.items;
    }
    const feeds = loadFeeds();
    const results = await Promise.all(feeds.map(fetchFeed));
    let all = results.flat();
    all.sort((a,b) => b.pubDate - a.pubDate);
    _cache = { items: all, ts: Date.now() };
    return all;
  }

  function fallbackImageFor(idx){
    return FALLBACK_IMAGES[idx % FALLBACK_IMAGES.length];
  }

  function articleUrl(item){
    const p = new URLSearchParams({
      title: item.title,
      desc: item.desc || '',
      image: item.image || '',
      cat: item.cat,
      link: item.link,
      source: item.source || '',
      date: item.pubDate.toISOString()
    });
    return 'news.html?' + p.toString();
  }

  function categoryUrl(cat){
    return 'category.html?cat=' + encodeURIComponent(cat);
  }

  global.KR = {
    DEFAULT_FEEDS, toFa, relTime, faDate, newsCode,
    loadFeeds, saveFeeds, getAllItems, fallbackImageFor,
    articleUrl, categoryUrl
  };
})(window);

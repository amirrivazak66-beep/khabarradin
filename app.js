/* خبر رادین — موتور مشترک: پیکربندی فیدها + کش خبر + رندر صفحات
 *
 * معماری:
 *  - rss_feeds  → تنظیمات هر منبع RSS (دسته، آدرس، تعداد خبر، بازه بروزرسانی، رسانه)
 *  - news_items → کش خبرهای دریافت‌شده؛ صفحات عمومی سایت فقط از همین جدول
 *                 می‌خونن، هرگز مستقیماً RSS رو fetch نمی‌کنن و لینک منبع
 *                 اصلی هیچ‌وقت به بازدیدکننده نمایش داده نمی‌شه.
 *  - پر کردن news_items («دریافت اخبار») فقط از داخل پنل مدیریت (admin.html)
 *    انجام می‌شه.
 */
(function (global) {
  const CATEGORY_OPTIONS = [
    'اقتصاد', 'سیاست', 'بین‌الملل', 'جامعه', 'فرهنگ و هنر',
    'ورزش', 'فناوری', 'ویدیو', 'پادکست', 'گزارش‌ها', 'عمومی'
  ];

  const DEFAULT_FEEDS = [
    { cat: 'اقتصاد',    url: 'https://www.isna.ir/rss' },
    { cat: 'سیاست',     url: 'https://www.khabaronline.ir/rss' },
    { cat: 'جامعه',     url: 'https://www.yjc.ir/fa/rss/allnews' },
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

  function newsCode(id){
    // کد خبر یکتا و پایدار، بر اساس id ردیف در دیتابیس (نه لینک منبع —
    // چون لینک منبع دیگر هیچ‌جا در سمت کاربر استفاده نمی‌شود).
    const str = String(id || '');
    let hash = 0;
    for (let i=0;i<str.length;i++){ hash = (hash*31 + str.charCodeAt(i)) >>> 0; }
    const code = '140' + (3 + (hash % 3)) + String(hash % 100000000).padStart(8,'0');
    return toFa(code);
  }

  // ---------------------------------------------------------------------
  // FEED CONFIGURATION (rss_feeds table) — used by the admin panel only
  // ---------------------------------------------------------------------
  async function loadFeeds(){
    try{
      if (window.sb){
        const { data, error } = await window.sb
          .from('rss_feeds')
          .select('id,category,url,item_count,update_interval_minutes,include_media')
          .order('created_at');
        if (error) throw error;
        if (data && data.length){
          return data.map(d => ({
            id: d.id,
            cat: d.category,
            url: d.url,
            itemCount: d.item_count ?? 5,
            updateIntervalMinutes: d.update_interval_minutes ?? 60,
            includeMedia: d.include_media !== false
          }));
        }
      }
    }catch(e){
      console.warn('Supabase feed load failed, falling back to defaults:', e);
    }
    return DEFAULT_FEEDS.map(f => ({
      id: null, cat: f.cat, url: f.url,
      itemCount: 5, updateIntervalMinutes: 60, includeMedia: true
    }));
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

  /**
   * Fetches and parses one RSS feed. Respects feed.itemCount and
   * feed.includeMedia. Used ONLY by the admin "pull" action — public
   * pages never call this.
   */
  async function fetchFeed(feed){
    const limit = feed.itemCount || 5;
    let lastErr;
    for (const buildUrl of PROXIES){
      try{
        const res = await fetch(buildUrl(feed.url), { cache: 'no-store' });
        if (!res.ok) throw new Error('bad status ' + res.status);
        const text = await res.text();
        const xml = new DOMParser().parseFromString(text, 'text/xml');
        if (xml.querySelector('parsererror')) throw new Error('parse error');
        const items = Array.from(xml.querySelectorAll('item')).slice(0, limit).map(itemEl => {
          const title = (itemEl.querySelector('title')?.textContent || '').trim();
          const link = (itemEl.querySelector('link')?.textContent || '').trim();
          const pubDateText = itemEl.querySelector('pubDate')?.textContent;
          const pubDate = pubDateText ? new Date(pubDateText) : new Date();
          const descRaw = itemEl.querySelector('description')?.textContent || '';
          const image = feed.includeMedia === false ? null : extractImage(itemEl, descRaw);
          const desc = stripHtml(descRaw);
          const sourceHost = (() => { try{ return new URL(feed.url).hostname.replace('www.',''); }catch(e){ return ''; } })();
          return { title, link, pubDate, desc, image, cat: feed.cat, source: sourceHost };
        }).filter(it => it.title && it.link);
        return { ok: true, items };
      }catch(err){
        lastErr = err;
      }
    }
    console.warn('Feed failed:', feed.url, lastErr);
    return { ok: false, items: [], error: lastErr ? lastErr.message : 'unknown error' };
  }

  /**
   * Pulls ONE feed and upserts its items into news_items. Admin-only —
   * requires an authenticated Supabase session (RLS enforces this
   * server-side regardless). Returns a small report used by the admin
   * UI to confirm ingestion succeeded.
   */
  async function pullFeedIntoDb(feed){
    const result = await fetchFeed(feed);
    if (!result.ok){
      return { cat: feed.cat, url: feed.url, fetched: 0, inserted: 0, ok: false, error: result.error };
    }

    let inserted = 0;
    for (const it of result.items){
      const { error, data } = await window.sb
        .from('news_items')
        .upsert({
          feed_id: feed.id || null,
          category: feed.cat,
          title: it.title,
          summary: it.desc,
          image_url: it.image,
          source_url: it.link,
          source_name: it.source,
          pub_date: it.pubDate.toISOString()
        }, { onConflict: 'source_url', ignoreDuplicates: false })
        .select();
      if (!error && data) inserted += data.length;
    }

    return { cat: feed.cat, url: feed.url, fetched: result.items.length, inserted, ok: true };
  }

  /**
   * Pulls every configured feed. Returns an array of per-feed reports
   * so the admin panel can show exactly what was read and stored.
   */
  async function pullAllFeeds(){
    if (!window.sb) throw new Error('Supabase در دسترس نیست');
    const { data, error } = await window.sb.functions.invoke('rss-ingest', { body: { trigger: 'manual' } });
    if (error) throw error;
    return (data?.reports || []).map(r => ({
      cat: r.feed || 'منبع خبری',
      fetched: Number(r.fetched || 0),
      inserted: Number(r.fetched || 0),
      ok: Boolean(r.ok),
      error: r.error || null
    }));
  }

  // ---------------------------------------------------------------------
  // PUBLIC SITE DATA — reads ONLY from the news_items cache table.
  // The original RSS source_url is stored in the database for the
  // admin's reference but is never selected/rendered here.
  // ---------------------------------------------------------------------
  let _cache = null; // { items: [...], ts: Number }

  async function getAllItems(forceRefresh){
    if (!forceRefresh && _cache && (Date.now() - _cache.ts) < 60*1000){
      return _cache.items;
    }
    try{
      const { data, error } = await window.sb
        .from('news_items')
        .select('id,category,title,summary,image_url,pub_date')
        .eq('published', true)
        .order('pub_date', { ascending: false })
        .limit(200);
      if (error) throw error;

      const items = (data || []).map(d => ({
        id: d.id,
        title: d.title,
        desc: d.summary || '',
        image: d.image_url || null,
        cat: d.category,
        pubDate: new Date(d.pub_date)
      }));
      _cache = { items, ts: Date.now() };
      return items;
    }catch(e){
      console.warn('news_items fetch failed:', e);
      return [];
    }
  }

  function fallbackImageFor(idx){
    return FALLBACK_IMAGES[idx % FALLBACK_IMAGES.length];
  }

  function articleUrl(item){
    return 'news.html?id=' + encodeURIComponent(item.id);
  }

  function categoryUrl(cat){
    return 'category.html?cat=' + encodeURIComponent(cat);
  }

  global.KR = {
    CATEGORY_OPTIONS, DEFAULT_FEEDS,
    toFa, relTime, faDate, newsCode,
    loadFeeds, fetchFeed, pullFeedIntoDb, pullAllFeeds,
    getAllItems, fallbackImageFor,
    articleUrl, categoryUrl
  };
})(window);

/* خبر رادین — رندر صفحه خبر */
(function(){
  function getParam(name){
    return new URLSearchParams(window.location.search).get(name) || '';
  }

  async function load(){
    const title = getParam('title');
    const desc = getParam('desc');
    const image = getParam('image');
    const cat = getParam('cat');
    const link = getParam('link');
    const source = getParam('source');
    const dateStr = getParam('date');
    const pubDate = dateStr ? new Date(dateStr) : new Date();

    document.title = 'خبر رادین | ' + title;
    document.getElementById('pageTitle').textContent = 'خبر رادین | ' + title;
    document.getElementById('articleTitle').textContent = title;
    document.getElementById('articleLead').textContent = desc;
    document.getElementById('newsCode').textContent = KR.newsCode(link || title);
    document.getElementById('newsDate').textContent = KR.faDate(pubDate) + ' · ' + KR.relTime(pubDate);
    document.getElementById('newsCatTag').textContent = cat;

    const catLink = document.getElementById('catBreadcrumbLink');
    catLink.textContent = cat;
    catLink.href = KR.categoryUrl(cat);

    const coverEl = document.getElementById('articleCover');
    if (image){
      coverEl.src = image;
    } else {
      coverEl.style.display = 'none';
    }

    document.getElementById('articleBody').innerHTML =
      `<p>${desc || 'خلاصه‌ای برای این خبر در دسترس نیست.'}</p>` +
      (source ? `<p style="margin-top:14px; color:#7c8aa0; font-size:13px;">منبع: ${source}</p>` : '');

    const sourceLinkEl = document.getElementById('sourceLink');
    sourceLinkEl.href = link || '#';

    document.getElementById('articleTags').innerHTML = `<span>${cat}</span>` + (source ? `<span>${source}</span>` : '');

    const shareText = encodeURIComponent(title);
    const shareUrl = encodeURIComponent(link || window.location.href);
    document.getElementById('shareTelegram').href = `https://t.me/share/url?url=${shareUrl}&text=${shareText}`;
    document.getElementById('shareTwitter').href = `https://twitter.com/intent/tweet?url=${shareUrl}&text=${shareText}`;
    document.getElementById('shareWhatsapp').href = `https://wa.me/?text=${shareText}%20${shareUrl}`;

    // مطالب مرتبط
    const all = await KR.getAllItems();
    const related = all.filter(it => it.cat === cat && it.link !== link).slice(0, 5);
    const relatedEl = document.getElementById('relatedList');
    if (related.length === 0){
      relatedEl.innerHTML = '<p style="font-size:12.5px; color:#aab4c2;">موردی یافت نشد.</p>';
    } else {
      relatedEl.innerHTML = related.map((it, i) => `
        <div class="related-item">
          <div class="thumb" style="background-image:url('${it.image || KR.fallbackImageFor(i)}')"></div>
          <div>
            <p><a href="${KR.articleUrl(it)}">${it.title}</a></p>
            <span>${KR.relTime(it.pubDate)}</span>
          </div>
        </div>`).join('');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    load();
  });
})();

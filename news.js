/* خبر رادین — رندر صفحه خبر
 * تمام داده‌ها از جدول news_items (با id داخلی) خونده می‌شن — لینک منبع
 * اصلی RSS هرگز به کاربر نمایش داده یا در URL این صفحه قرار داده نمی‌شه.
 */
(function(){
  function getParam(name){
    return new URLSearchParams(window.location.search).get(name) || '';
  }

  async function load(){
    const id = getParam('id');
    if (!id){
      document.getElementById('articleTitle').textContent = 'خبر یافت نشد';
      document.getElementById('articleBody').innerHTML = '<p>لینک این خبر معتبر نیست. <a href="index.html">بازگشت به صفحه اصلی</a></p>';
      return;
    }

    const { data, error } = await window.sb
      .from('news_items')
      .select('id,category,title,summary,image_url,pub_date')
      .eq('id', id)
      .eq('published', true)
      .single();

    if (error || !data){
      document.getElementById('articleTitle').textContent = 'خبر یافت نشد';
      document.getElementById('articleBody').innerHTML = '<p>این خبر در دسترس نیست یا حذف شده. <a href="index.html">بازگشت به صفحه اصلی</a></p>';
      return;
    }

    const title = data.title;
    const desc = data.summary || '';
    const image = data.image_url;
    const cat = data.category;
    const pubDate = new Date(data.pub_date);

    document.title = 'خبر رادین | ' + title;
    document.getElementById('pageTitle').textContent = 'خبر رادین | ' + title;
    document.getElementById('articleTitle').textContent = title;
    document.getElementById('articleLead').textContent = desc;
    document.getElementById('newsCode').textContent = KR.newsCode(data.id);
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
      `<p>${desc || 'خلاصه‌ای برای این خبر در دسترس نیست.'}</p>`;

    document.getElementById('articleTags').innerHTML = `<span>${cat}</span>`;

    // اشتراک‌گذاری فقط به لینک داخلی همین صفحه اشاره می‌کنه — نه منبع خارجی.
    const shareText = encodeURIComponent(title);
    const shareUrl = encodeURIComponent(window.location.href);
    document.getElementById('shareTelegram').href = `https://t.me/share/url?url=${shareUrl}&text=${shareText}`;
    document.getElementById('shareTwitter').href = `https://twitter.com/intent/tweet?url=${shareUrl}&text=${shareText}`;
    document.getElementById('shareWhatsapp').href = `https://wa.me/?text=${shareText}%20${shareUrl}`;

    // مطالب مرتبط
    const all = await KR.getAllItems();
    const related = all.filter(it => it.cat === cat && it.id !== data.id).slice(0, 5);
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

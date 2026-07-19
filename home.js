/* خبر رادین — رندر صفحه اصلی */
document.addEventListener('DOMContentLoaded', () => {
  KR.mountSettingsModal(refresh);
  refresh();

  async function refresh(){
    const statusEl = document.getElementById('feedStatus');
    statusEl.textContent = 'در حال دریافت اخبار...';
    const all = await KR.getAllItems(true);

    if (all.length === 0){
      statusEl.textContent = 'دریافت خودکار اخبار ممکن نشد — نمایش نمونه محتوا. از دکمه تنظیمات برای اصلاح فیدها استفاده کنید.';
      return;
    }
    statusEl.textContent = 'به‌روزرسانی شد · ' + KR.relTime(new Date());

    // آخرین اخبار (ستون راست)
    const listEl = document.getElementById('latestNewsList');
    listEl.innerHTML = all.slice(0, 5).map((it, i) => `
      <li>
        <span class="num">${KR.toFa(i+1)}</span>
        <div class="content">
          <p><a href="${KR.articleUrl(it)}">${it.title}</a></p>
          <span>${KR.relTime(it.pubDate)}</span>
        </div>
      </li>`).join('');

    // خبر ویژه (Hero)
    const top = all[0];
    document.getElementById('heroTitle').textContent = top.title;
    document.getElementById('heroDesc').textContent = top.desc ? top.desc.slice(0, 220) : '';
    document.getElementById('heroTime').textContent = KR.relTime(top.pubDate);
    document.getElementById('heroDate').textContent = KR.faDate(top.pubDate);
    document.getElementById('heroTags').innerHTML =
      `<span class="tag gold">ویژه</span><span class="tag blue">${top.cat}</span>`;
    if (top.image){
      document.getElementById('heroSlide').style.backgroundImage =
        `linear-gradient(180deg, rgba(10,18,32,.1) 0%, rgba(8,14,26,.55) 55%, rgba(6,10,20,.92) 100%), url('${top.image}')`;
    }
    document.getElementById('heroSlide').onclick = () => { window.location.href = KR.articleUrl(top); };

    // تیترهای مهم
    const gridEl = document.getElementById('storiesGrid');
    const cardsSource = all.slice(1, 6);
    gridEl.innerHTML = cardsSource.map((it, i) => `
      <div class="story-card">
        <a href="${KR.articleUrl(it)}">
          <div class="story-thumb" style="background-image:url('${it.image || KR.fallbackImageFor(i)}')">
            <span class="cat">${it.cat}</span>
          </div>
        </a>
        <div class="story-body">
          <h4><a href="${KR.articleUrl(it)}" style="color:inherit; text-decoration:none;">${it.title}</a></h4>
          <span class="time">${KR.relTime(it.pubDate)}</span>
        </div>
      </div>`).join('');
  }
});

/* خبر رادین — رندر صفحه اصلی (طرح جدید)
 * توجه: بخش «بازار و شاخص‌ها» و ردیف کارت‌های آماری (دلار، طلا، بورس،
 * بیت‌کوین) داده واقعی بازار مالی نیستند — چون به یک API قیمت لحظه‌ای
 * نیاز دارن که فعلاً وصل نشده. بقیه بخش‌ها (اخبار، ویدیو، تحلیل ویژه)
 * از جدول news_items (که با RSS پر می‌شه) خونده می‌شن.
 */
document.addEventListener('DOMContentLoaded', () => {
  renderStatCards();
  refreshNews();
});

function renderStatCards(){
  const mock = [
    { name:'دلار آزاد', icon:'fa-dollar-sign', color:'#26b975', value:'۸۸,۹۵۰', chg:'+۱٫۲۴٪', up:true,
      pts:'0,20 15,18 30,19 45,12 60,15 75,8 90,10' },
    { name:'طلای ۱۸ عیار', icon:'fa-ring', color:'#c99a3d', value:'۶,۹۱۲,۰۰۰', chg:'+۰٫۸۶٪', up:true,
      pts:'0,18 15,17 30,19 45,14 60,16 75,10 90,12' },
    { name:'سکه امامی', icon:'fa-coins', color:'#c99a3d', value:'۷۶,۹۰۰,۰۰۰', chg:'+۰٫۹۳٪', up:true,
      pts:'0,19 15,16 30,18 45,13 60,15 75,9 90,11' },
    { name:'شاخص کل بورس', icon:'fa-chart-line', color:'#0a4faf', value:'۲,۷۵۶,۸۵۰', chg:'+۱٫۱۷٪', up:true,
      pts:'0,22 15,20 30,17 45,18 60,12 75,14 90,7' },
    { name:'اونس طلا', icon:'fa-circle-dollar-to-slot', color:'#ef5350', value:'$۲,۴۱۲.۶۰', chg:'-۰٫۳۸٪', up:false,
      pts:'0,8 15,10 30,9 45,14 60,13 75,18 90,20' },
    { name:'بیت‌کوین', icon:'fa-brands fa-bitcoin', color:'#c99a3d', value:'$۱۱۸,۷۶۵', chg:'+۱٫۶۲٪', up:true,
      pts:'0,20 15,17 30,18 45,11 60,13 75,7 90,9' }
  ];

  const el = document.getElementById('statCardsRow');
  if (!el) return;
  el.innerHTML = mock.map(m => `
    <div class="stat-card-v2">
      <div class="sc-head">
        <span class="sc-icon" style="background:${m.color}1a; color:${m.color};"><i class="fa-solid ${m.icon}"></i></span>
        <span class="sc-name">${m.name}</span>
      </div>
      <div class="sc-value">${m.value}</div>
      <div class="sc-chg ${m.up ? 'up' : 'down'}"><i class="fa-solid fa-caret-${m.up ? 'up' : 'down'}"></i> ${m.chg}</div>
      <svg viewBox="0 0 90 24" preserveAspectRatio="none">
        <polyline fill="none" stroke="${m.up ? '#26b975' : '#ef5350'}" stroke-width="2" points="${m.pts}"/>
      </svg>
    </div>`).join('');
}

async function refreshNews(){
  const statusEl = document.getElementById('feedStatus');
  if (statusEl) statusEl.textContent = 'در حال دریافت اخبار...';

  const all = await KR.getAllItems(true);

  if (all.length === 0){
    if (statusEl) statusEl.textContent = 'هنوز خبری در دسترس نیست. از پنل مدیریت، فیدهای RSS را تنظیم و «دریافت اخبار» را بزنید.';
    document.getElementById('latestNewsList').innerHTML = '';
    document.getElementById('videoList').innerHTML = '<p style="padding:16px; font-size:12.5px; color:#aab4c2;">موردی یافت نشد.</p>';
    document.getElementById('analysisList').innerHTML = '<p style="padding:16px; font-size:12.5px; color:#aab4c2;">موردی یافت نشد.</p>';
    document.getElementById('mostViewedList').innerHTML = '<p style="padding:16px; font-size:12.5px; color:#aab4c2;">موردی یافت نشد.</p>';
    return;
  }
  if (statusEl) statusEl.textContent = 'به‌روزرسانی شد · ' + KR.relTime(new Date());

  const marketUpdatedEl = document.getElementById('marketUpdated');
  if (marketUpdatedEl) marketUpdatedEl.textContent = 'آخرین بروزرسانی: ' + KR.relTime(new Date());

  // ---- HERO: جدیدترین خبر کلی ----
  const top = all[0];
  document.getElementById('heroTitle').textContent = top.title;
  document.getElementById('heroDesc').textContent = top.desc ? top.desc.slice(0, 200) : '';
  document.getElementById('heroTime').textContent = KR.relTime(top.pubDate);
  document.getElementById('heroDate').textContent = KR.faDate(top.pubDate);
  document.getElementById('heroTags').innerHTML = `<span class="tag gold">${top.cat}</span>`;
  const heroViewsEl = document.getElementById('heroViews');
  if (heroViewsEl) heroViewsEl.textContent = '—'; // بازدید واقعی نیاز به سیستم شمارش دارد
  if (top.image){
    document.getElementById('heroSlide').style.backgroundImage =
      `linear-gradient(180deg, rgba(10,18,32,.12) 0%, rgba(8,14,26,.6) 55%, rgba(6,10,20,.94) 100%), url('${top.image}')`;
  }
  document.getElementById('heroSlide').onclick = () => { window.location.href = KR.articleUrl(top); };

  // ---- آخرین اخبار (ستون راست) ----
  const listEl = document.getElementById('latestNewsList');
  listEl.innerHTML = all.slice(0, 6).map((it, i) => `
    <div class="lw-item">
      <div class="thumb" style="background-image:url('${it.image || KR.fallbackImageFor(i)}')"></div>
      <div class="info">
        <div class="cat">${it.cat}</div>
        <h4><a href="${KR.articleUrl(it)}">${it.title}</a></h4>
        <span class="time">${KR.relTime(it.pubDate)}</span>
      </div>
    </div>`).join('');

  // ---- ویدئو ----
  const videoItems = all.filter(it => it.cat === 'ویدیو').slice(0, 4);
  const videoEl = document.getElementById('videoList');
  const videoSource = videoItems.length ? videoItems : all.slice(0, 3);
  videoEl.innerHTML = videoSource.map((it, i) => `
    <div class="video-item">
      <a href="${KR.articleUrl(it)}" class="thumb" style="background-image:url('${it.image || KR.fallbackImageFor(i)}')"></a>
      <div class="info">
        <h4><a href="${KR.articleUrl(it)}" style="color:inherit; text-decoration:none;">${it.title}</a></h4>
        <span class="time">${KR.relTime(it.pubDate)}</span>
      </div>
    </div>`).join('');

  // ---- تحلیل ویژه (از دسته «گزارش‌ها») ----
  const analysisItems = all.filter(it => it.cat === 'گزارش‌ها').slice(0, 4);
  const analysisEl = document.getElementById('analysisList');
  const analysisSource = analysisItems.length ? analysisItems : all.slice(1, 4);
  analysisEl.innerHTML = analysisSource.map((it, i) => `
    <div class="analysis-item-v2">
      <a href="${KR.articleUrl(it)}" class="thumb" style="background-image:url('${it.image || KR.fallbackImageFor(i+2)}')"></a>
      <div class="info">
        <h4><a href="${KR.articleUrl(it)}" style="color:inherit; text-decoration:none;">${it.title}</a></h4>
        <span class="time">${KR.relTime(it.pubDate)}</span>
      </div>
    </div>`).join('');

  // ---- پربازدیدترین‌ها ----
  // توجه: سیستم شمارش بازدید واقعی هنوز پیاده‌سازی نشده — فعلاً جدیدترین
  // خبرها به‌عنوان جایگزین نمایش داده می‌شن.
  const mostViewedEl = document.getElementById('mostViewedList');
  mostViewedEl.innerHTML = all.slice(0, 5).map((it, i) => `
    <div class="most-viewed-item">
      <span class="rank">${KR.toFa(i+1)}</span>
      <a href="${KR.articleUrl(it)}" class="thumb" style="background-image:url('${it.image || KR.fallbackImageFor(i+1)}')"></a>
      <h4><a href="${KR.articleUrl(it)}" style="color:inherit; text-decoration:none;">${it.title}</a></h4>
      <span class="time">${KR.relTime(it.pubDate)}</span>
    </div>`).join('');
}

/* Prototype fallback content: clearly labelled sample headlines, not real news */
function renderPrototypeNews(){
 const host=document.getElementById('latestNewsList');
 if(!host || host.children.length) return;
 const samples=[
  {cat:'اقتصاد',title:'نمونه تیتر اقتصادی؛ خبرهای مهم بازار در این بخش نمایش داده می‌شوند.',time:'نمونه نمایشی'},
  {cat:'سیاست',title:'نمونه تیتر سیاسی؛ تیتر اصلی و خلاصه خبر در این کارت قرار می‌گیرد.',time:'نمونه نمایشی'},
  {cat:'بین‌الملل',title:'نمونه خبر بین‌الملل؛ پوشش رویدادهای مهم ایران و جهان.',time:'نمونه نمایشی'},
  {cat:'جامعه',title:'نمونه خبر اجتماعی؛ خبرهای روز با تصویر و زمان انتشار.',time:'نمونه نمایشی'},
  {cat:'فناوری',title:'نمونه خبر فناوری؛ تازه‌ترین تحولات دنیای تکنولوژی.',time:'نمونه نمایشی'}
 ];
 host.innerHTML=samples.map((n,i)=>'<div class="lw-item prototype-news"><div class="thumb prototype-thumb prototype-thumb-'+i+'"><i class="fa-solid '+['fa-chart-line','fa-landmark','fa-earth-europe','fa-people-group','fa-microchip'][i]+'"></i></div><div class="info"><div class="cat">'+n.cat+'</div><h4>'+n.title+'</h4><span class="time">'+n.time+'</span></div></div>').join('');
 const status=document.getElementById('feedStatus');
 if(status) status.innerHTML='<span class="sample-news-label">حالت پیش‌نمایش</span> خبرهای بالا نمونه‌اند؛ با اتصال فید خبر، جایگزین می‌شوند.';
 const heroTitle=document.getElementById('heroTitle');
 if(heroTitle && heroTitle.textContent.includes('مهم‌ترین خبرهای روز')){
  heroTitle.textContent='نمایش نمونهٔ خبر شاخص در صفحهٔ اصلی خبر رادین';
  document.getElementById('heroDesc').textContent='در نسخهٔ نهایی، تیتر خبر منتخب، خلاصه، تصویر و زمان انتشار از منبع خبر دریافت می‌شود.';
  document.getElementById('heroTags').innerHTML='<span class="tag gold">نمونهٔ نمایشی</span>';
  document.getElementById('heroSlide').style.backgroundImage='linear-gradient(135deg,rgba(4,48,125,.15),rgba(3,24,69,.94)),radial-gradient(circle at 72% 24%,#d6b44e 0,#315aa3 26%,#082d72 70%)';
 }
 const video=document.getElementById('videoList');
 if(video && video.querySelector('.media-placeholder')) video.innerHTML='<div class="video-item prototype-media"><div class="thumb"><i class="fa-solid fa-play"></i></div><div class="info"><h4>نمونه ویدئو: جایگاه محتوای تصویری خبر رادین</h4><span class="time">نمونه نمایشی</span></div></div>';
 const analysis=document.getElementById('analysisList');
 if(analysis && analysis.querySelector('.media-placeholder')) analysis.innerHTML='<div class="analysis-item-v2 prototype-media"><div class="thumb"><i class="fa-solid fa-book-open"></i></div><div class="info"><h4>نمونه گزارش تحلیلی؛ نمایش تیتر، تصویر و توضیح کوتاه</h4><span class="time">نمونه نمایشی</span></div></div>';
 const popular=document.getElementById('mostViewedList');
 if(popular && popular.querySelector('.media-placeholder')) popular.innerHTML='<div class="most-viewed-item"><span class="rank">۱</span><div class="thumb prototype-thumb prototype-thumb-1"></div><h4>نمونه خبر پیشنهادی برای تکمیل ماکت صفحه</h4></div>';
}
document.addEventListener('DOMContentLoaded',()=>setTimeout(renderPrototypeNews,900));

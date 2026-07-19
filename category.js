/* خبر رادین — رندر صفحه دسته‌بندی */
(function(){
  const PAGE_SIZE = 8;
  let currentPage = 1;
  let filtered = [];

  function getParam(name){
    return new URLSearchParams(window.location.search).get(name) || '';
  }

  function renderPage(){
    const listEl = document.getElementById('catList');
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

    if (pageItems.length === 0){
      listEl.innerHTML = `
        <div class="empty-state">
          برای این دسته، خبری در فیدهای فعلی پیدا نشد.<br>
          می‌تونید فیدهای RSS رو از تنظیمات اصلاح یا اضافه کنید.
          <br><a href="admin.html" id="openSettingsFromEmpty" style="display:inline-block; margin-top:12px; padding:10px 20px; border-radius:8px; background:linear-gradient(135deg,var(--gold-light),var(--gold)); color:var(--navy-950); font-weight:700; text-decoration:none;">رفتن به پنل مدیریت</a>
        </div>`;
      return;
    }

    listEl.innerHTML = pageItems.map((it, i) => `
      <div class="cat-list-item">
        <a href="${KR.articleUrl(it)}">
          <div class="thumb" style="background-image:url('${it.image || KR.fallbackImageFor(start+i)}')"></div>
        </a>
        <div class="info">
          <div class="tagline">${it.cat} · ${it.source || ''}</div>
          <h3><a href="${KR.articleUrl(it)}">${it.title}</a></h3>
          <p>${it.desc || ''}</p>
          <div class="time">${KR.relTime(it.pubDate)}</div>
        </div>
      </div>`).join('');
  }

  function renderPagination(){
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const pagEl = document.getElementById('pagination');
    if (totalPages <= 1){ pagEl.innerHTML = ''; return; }
    let html = '';
    for (let p = 1; p <= totalPages; p++){
      html += `<button data-page="${p}" class="${p===currentPage?'active':''}">${KR.toFa(p)}</button>`;
    }
    pagEl.innerHTML = html;
    pagEl.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        currentPage = Number(btn.dataset.page);
        renderPage();
        renderPagination();
        window.scrollTo({top:0, behavior:'smooth'});
      });
    });
  }

  function showSkeleton(){
    const listEl = document.getElementById('catList');
    listEl.innerHTML = Array.from({length:5}).map(() => `
      <div class="cat-list-item">
        <div class="skel skel-card-thumb" style="width:180px; height:120px; border-radius:10px; flex-shrink:0;"></div>
        <div class="info" style="flex:1;">
          <div class="skel skel-line w50" style="margin-bottom:10px;"></div>
          <div class="skel skel-line w80" style="height:16px; margin-bottom:10px;"></div>
          <div class="skel skel-line" style="width:100%; margin-bottom:6px;"></div>
          <div class="skel skel-line w50"></div>
        </div>
      </div>`).join('');
  }

  async function load(){
    const cat = getParam('cat');
    document.getElementById('catTitle').textContent = cat === 'all' ? 'همه اخبار' : cat;
    document.getElementById('catNameBreadcrumb').textContent = cat === 'all' ? 'همه اخبار' : cat;
    document.title = 'خبر رادین | ' + (cat === 'all' ? 'همه اخبار' : cat);
    document.getElementById('catCount').textContent = '';
    showSkeleton();

    const all = await KR.getAllItems(true);
    filtered = (cat === 'all') ? all : all.filter(it => it.cat === cat);
    document.getElementById('catCount').textContent = filtered.length ? (KR.toFa(filtered.length) + ' خبر') : '';
    currentPage = 1;
    renderPage();
    renderPagination();
  }

  document.addEventListener('DOMContentLoaded', () => {
    load();
  });
})();

/* خبر رادین — ماژول مشترک تنظیمات RSS (مودال) */
(function(){
  const MODAL_HTML = `
  <div class="modal-overlay" id="modalOverlay">
    <div class="modal-box">
      <button id="closeModalBtn">✕</button>
      <h3>تنظیمات فیدهای RSS</h3>
      <p class="sub">آدرس فید RSS هر منبع خبری رو همراه با نام دسته وارد کنید. سایت به‌صورت خودکار آخرین اخبار رو از این فیدها می‌خونه و در صفحه نمایش می‌ده. نام دسته دقیقاً همون چیزیه که در صفحات دسته‌بندی و منو استفاده می‌شه.</p>
      <div id="feedRows"></div>
      <div class="modal-actions">
        <button id="addFeedBtn">+ افزودن فید جدید</button>
        <button id="saveFeedBtn">ذخیره و به‌روزرسانی اخبار</button>
      </div>
    </div>
  </div>`;

  function renderFeedRows(feeds){
    const wrap = document.getElementById('feedRows');
    wrap.innerHTML = '';
    feeds.forEach((f, idx) => {
      const row = document.createElement('div');
      row.className = 'feed-row';
      row.innerHTML = `
        <input class="cat" data-idx="${idx}" data-field="cat" value="${f.cat}" placeholder="دسته">
        <input data-idx="${idx}" data-field="url" value="${f.url}" placeholder="آدرس RSS">
        <button data-remove="${idx}">✕</button>`;
      wrap.appendChild(row);
    });
  }

  window.KR = window.KR || {};
  window.KR.mountSettingsModal = function(onSave){
    if (document.getElementById('modalOverlay')) return; // already mounted
    document.body.insertAdjacentHTML('beforeend', MODAL_HTML);

    let feeds = KR.loadFeeds();
    renderFeedRows(feeds);

    const overlay = document.getElementById('modalOverlay');
    const btn = document.getElementById('rssSettingsBtn');
    if (btn){
      btn.addEventListener('click', () => {
        feeds = KR.loadFeeds();
        renderFeedRows(feeds);
        overlay.classList.add('open');
      });
    }
    document.getElementById('closeModalBtn').addEventListener('click', () => overlay.classList.remove('open'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });

    document.getElementById('addFeedBtn').addEventListener('click', () => {
      feeds.push({ cat: 'دسته', url: '' });
      renderFeedRows(feeds);
    });

    document.getElementById('feedRows').addEventListener('click', (e) => {
      if (e.target.dataset.remove !== undefined){
        feeds.splice(Number(e.target.dataset.remove), 1);
        renderFeedRows(feeds);
      }
    });
    document.getElementById('feedRows').addEventListener('input', (e) => {
      const idx = e.target.dataset.idx;
      if (idx === undefined) return;
      feeds[idx][e.target.dataset.field] = e.target.value;
    });

    document.getElementById('saveFeedBtn').addEventListener('click', () => {
      feeds = feeds.filter(f => f.url && f.url.trim());
      KR.saveFeeds(feeds);
      overlay.classList.remove('open');
      if (typeof onSave === 'function') onSave();
    });

    // expose a way to open programmatically
    window.KR.openSettingsModal = () => {
      feeds = KR.loadFeeds();
      renderFeedRows(feeds);
      overlay.classList.add('open');
    };
  };
})();

/* خبر رادین — عناصر مشترک هدر: ساعت زنده، آب‌وهوای واقعی، نوار خبر فوری */
(function(){
  const faDigits = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
  function toFa(str){ return String(str).replace(/[0-9]/g, d => faDigits[d]); }

  function updateClock(){
    const now = new Date();
    const dateEl = document.getElementById('todayDate');
    const timeEl = document.getElementById('nowTime');
    if (dateEl){
      try{
        dateEl.textContent = new Intl.DateTimeFormat('fa-IR', { weekday:'long', day:'numeric', month:'long', year:'numeric' }).format(now);
      }catch(e){ dateEl.textContent = now.toLocaleDateString('fa-IR'); }
    }
    if (timeEl){
      const h = String(now.getHours()).padStart(2,'0');
      const m = String(now.getMinutes()).padStart(2,'0');
      timeEl.textContent = toFa(`${h}:${m}`);
    }
    const breakingTimeEl = document.getElementById('breakingTime');
    if (breakingTimeEl){
      const h = String(now.getHours()).padStart(2,'0');
      const m = String(now.getMinutes()).padStart(2,'0');
      breakingTimeEl.textContent = toFa(`${h}:${m}`);
    }
  }

  async function loadWeather(){
    const tempEl = document.getElementById('weatherTemp');
    const descEl = document.getElementById('weatherDesc');
    if (!tempEl) return;
    try{
      const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=35.6892&longitude=51.3890&current=temperature_2m,weather_code&timezone=Asia%2FTehran');
      const data = await res.json();
      const temp = Math.round(data.current.temperature_2m);
      tempEl.textContent = toFa(temp) + '°';
      if (descEl) descEl.textContent = weatherCodeToText(data.current.weather_code);
    }catch(e){
      tempEl.textContent = '—';
    }
  }

  function weatherCodeToText(code){
    if (code === 0) return 'صاف';
    if ([1,2,3].includes(code)) return 'کمی ابری';
    if ([45,48].includes(code)) return 'مه‌آلود';
    if ([51,53,55,61,63,65,80,81,82].includes(code)) return 'بارانی';
    if ([71,73,75,85,86].includes(code)) return 'برفی';
    if ([95,96,99].includes(code)) return 'رعد و برق';
    return '';
  }

  async function loadBreakingTicker(){
    const el = document.getElementById('breakingText');
    if (!el || !window.KR) return;
    try{
      const items = await KR.getAllItems();
      if (items && items.length){
        el.textContent = items[0].title;
      } else {
        el.textContent = 'به‌زودی آخرین اخبار در این بخش نمایش داده می‌شود.';
      }
    }catch(e){
      el.textContent = 'به‌زودی آخرین اخبار در این بخش نمایش داده می‌شود.';
    }
  }

  function setActiveNav(){
    const params = new URLSearchParams(window.location.search);
    const cat = params.get('cat');
    const path = window.location.pathname.split('/').pop() || 'index.html';

    document.querySelectorAll('.main-nav-bar a').forEach(a => {
      const href = a.getAttribute('href') || '';
      let isActive = false;
      if (path === 'index.html' && href === 'index.html' && !cat){
        isActive = true;
      } else if (cat && href.includes('cat=' + encodeURIComponent(cat))){
        isActive = true;
      }
      a.classList.toggle('active', isActive);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    updateClock();
    window.setInterval(updateClock, 30000);
    loadWeather();
    loadBreakingTicker();
    setActiveNav();
  });
})();

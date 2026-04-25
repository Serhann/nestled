(function() {
  // Zaten yüklü mü kontrol et
  if (document.getElementById('ai-chatbot-widget-iframe')) return;

  // Kendi script'imizin URL'sini bularak anasayfamızı anlıyoruz (Örn: https://chatbot.vercel.app)
  const scripts = document.getElementsByTagName('script');
  let baseUrl = '';
  for (let i = 0; i < scripts.length; i++) {
    if (scripts[i].src && scripts[i].src.includes('embed.js')) {
      const url = new URL(scripts[i].src);
      baseUrl = url.origin;
      break;
    }
  }

  // Fallback (Bulunamazsa)
  if (!baseUrl) {
    console.error('AI Chatbot: embed.js origin bulunamadı.');
    return;
  }

  // İstemcisi verisi
  const targetDomain = window.location.hostname;
  
  // Wrapper div oluştur
  const container = document.createElement('div');
  container.id = 'ai-chatbot-widget-container';
  container.style.position = 'fixed';
  container.style.bottom = '20px';
  container.style.right = '20px';
  container.style.width = '400px';
  container.style.height = '600px';
  container.style.maxWidth = 'calc(100vw - 40px)';
  container.style.maxHeight = 'calc(100vh - 40px)';
  container.style.zIndex = '2147483647';
  container.style.pointerEvents = 'none'; // Iframe dışındaki tıklamaları engelleme (Sadece iframe içine tıklanabilsin)
  container.style.transition = 'all 0.3s ease';

  // Yalnızca widget göründüğünde tıklamaları aktif et (css ile) - Başlangıçta sadece icon kadar pointer almalı.
  // Bu yüzden iframe'i %100 yapıyoruz ama background transparan oluyor.

  const iframe = document.createElement('iframe');
  iframe.id = 'ai-chatbot-widget-iframe';
  // ?view=widget parametresi göndererek App.tsx'i sadece widget moduna sokuyoruz
  iframe.src = `${baseUrl}/?view=widget&target_domain=${targetDomain}`;
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  iframe.style.background = 'transparent';
  iframe.style.pointerEvents = 'auto'; // İçeriye tıklama serbest

  container.appendChild(iframe);
  document.body.appendChild(container);

  // Widget kapandığında/açıldığında container boyutunu değiştirmek için postMessage dinleyicisi eklenebilir
  // Şimdilik 400x600 sabit overlay ile (Veya arka plan şeffaf olduğu için tıklamaları pass-through bırakıyoruz)
})();

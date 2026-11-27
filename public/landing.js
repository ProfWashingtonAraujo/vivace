// Landing da Vivace: fotos, entrada ao rolar e parallax leve. Sem dependências.
(function () {
  var root = document.documentElement;

  // Fotos: cada <img data-foto="/fotos/..."> só aparece se o arquivo existir.
  // Enquanto não existe, o espaço mostra o rótulo "Foto da poltrona".
  document.querySelectorAll('img[data-foto]').forEach(function (img) {
    var probe = new Image();
    probe.onload = function () {
      img.src = img.getAttribute('data-foto');
      var slot = img.closest('[data-slot]');
      if (slot) slot.classList.add('has-foto');
    };
    probe.src = img.getAttribute('data-foto');
  });

  // Hero: marca como pronto e dispara a entrada em sequência.
  var hero = document.getElementById('top');
  if (hero) {
    hero.classList.add('vh-js');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { hero.classList.add('vh-go'); });
    });
  }

  // Botão fixo do WhatsApp (celular): aparece quando o do hero sai da tela e some no fechamento.
  var dock = document.getElementById('dock');
  var heroBtn = document.querySelector('.vh-cta .vh-btn');
  var contact = document.getElementById('contato');
  if (dock && heroBtn && contact && 'IntersectionObserver' in window) {
    var heroSeen = true, inContact = false;
    var sync = function () {
      var pastHero = !heroSeen && heroBtn.getBoundingClientRect().top < 0;
      dock.classList.toggle('show', pastHero && !inContact);
    };
    new IntersectionObserver(function (es) { heroSeen = es[0].isIntersecting; sync(); }).observe(heroBtn);
    new IntersectionObserver(function (es) { inContact = es[0].isIntersecting; sync(); }, { threshold: 0.25 }).observe(contact);
  }

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) return;

  root.classList.add('js');

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });

  document.querySelectorAll('[data-rv]').forEach(function (el) {
    var idx = Array.prototype.indexOf.call(el.parentNode.children, el);
    el.style.setProperty('--d', Math.min(idx, 5) * 0.08 + 's');
    io.observe(el);
  });

  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      root.style.setProperty('--py', Math.round(window.scrollY * 0.12) + 'px');
      ticking = false;
    });
  }, { passive: true });
})();

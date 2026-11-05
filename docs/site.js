// Shared by docs/index.html and docs/de/index.html.
// Labels for the OS-specific hero button come from data-label-<os> on #hero-download.
(function () {
  var ua = navigator.userAgent || '';
  var p = navigator.platform || '';
  var os = /Mac/i.test(p + ua) ? 'macos' : /Win/i.test(p + ua) ? 'windows' : /Linux/i.test(p + ua) ? 'linux' : null;

  var hero = document.getElementById('hero-download');
  var label = os && hero && hero.getAttribute('data-label-' + os);
  if (label) document.getElementById('hero-label').textContent = label;
  // Direct installer link: same version-free asset as the OS card below (release.yml adds them).
  var card = os && document.querySelector('.os[data-os="' + os + '"] a.cta');
  if (label && card) hero.href = card.href;

  document.querySelectorAll('.os[data-os="' + os + '"]').forEach(function (c) { c.classList.add('highlighted'); });

  // Scroll reveal: IntersectionObserver, no scroll listeners.
  var els = document.querySelectorAll('.reveal, .stage');
  if (!('IntersectionObserver' in window)) {
    els.forEach(function (el) { el.classList.add('in'); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
  els.forEach(function (el) { io.observe(el); });
})();

'use strict';

// Die Startseite liegt als statische Datei auf dem CDN. Kampagnenlinks
// (`/?src=…`) sollen ihre Kennung trotzdem bis zur Bewerbung mitnehmen –
// das übernimmt jetzt dieser kleine Zusatz im Browser statt der Server.
(function () {
  var src = new URLSearchParams(window.location.search).get('src');
  if (!src) return;
  src = String(src).slice(0, 60);
  var links = document.querySelectorAll('a[href^="/bewerben"]');
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute('href').split('?')[0];
    links[i].setAttribute('href', href + '?src=' + encodeURIComponent(src));
  }
})();

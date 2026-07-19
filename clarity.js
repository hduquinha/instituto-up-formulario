/* Microsoft Clarity — mapa de calor e gravação de sessões.
   Projeto Clarity ÚNICO para todo o ecossistema VozUP/Instituto UP; o ID é
   carimbado em todos os repos por tools/set-clarity-id.sh na raiz do monorepo.
   Enquanto o placeholder não for substituído, este arquivo é um no-op. */
(function () {
  var CLARITY_ID = "xonuuydq5e";
  if (!CLARITY_ID || CLARITY_ID.indexOf("__") === 0) return;

  (function (c, l, a, r, i, t, y) {
    c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
    t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
    y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
  })(window, document, "clarity", "script", CLARITY_ID);

  /* Tags customizadas para filtrar sessões no Clarity por produto/anúncio.
     "clique_meta" indica só que o clique passou pelo ecossistema Meta
     (fbclid) — NÃO prova mídia paga (ver cartilha §4.10/4.11). */
  try {
    var q = new URLSearchParams(window.location.search);
    window.clarity("set", "produto", "Encontro Online");
    if (q.get("utm_content")) window.clarity("set", "anuncio", q.get("utm_content"));
    if (q.get("utm_campaign")) window.clarity("set", "campanha", q.get("utm_campaign"));
    if (q.get("utm_source")) window.clarity("set", "fonte", q.get("utm_source"));
    if (q.get("gclid")) window.clarity("set", "clique_google_ads", "sim");
    if (q.get("fbclid")) window.clarity("set", "clique_meta", "sim");
  } catch (e) { /* analytics nunca pode quebrar a página */ }
})();

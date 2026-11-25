// Relais optionnel (Cloudflare Worker gratuit) si l'API Mistral refuse les appels directs depuis le navigateur.
// Il transmet les requêtes telles quelles à api.mistral.ai, sans rien stocker. La clé API reste sur le téléphone.
// Déploiement : dash.cloudflare.com → Workers → Create → coller ce fichier → Deploy,
// puis mettre l'adresse du worker dans Réglages → Avancé → Adresse de l'API.
const ALLOWED_ORIGIN = '*'; // à remplacer par l'adresse de ton app, ex. https://monpseudo.github.io

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/v1/')) return new Response('Not found', { status: 404, headers: cors });
    const upstream = await fetch('https://api.mistral.ai' + url.pathname + url.search, {
      method: request.method,
      headers: { Authorization: request.headers.get('Authorization') || '', 'Content-Type': request.headers.get('Content-Type') || '' },
      body: request.method === 'GET' ? undefined : request.body,
    });
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};

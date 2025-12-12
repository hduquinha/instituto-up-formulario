// Serverless proxy para contornar CORS ao chamar o webhook do n8n a partir do front hospedado na Vercel.
// Configure a env var N8N_WEBHOOK_URL no painel da Vercel (Production / Preview / Development) com a URL de PRODUÇÃO do webhook (sem /webhook-test/).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }
  const target = process.env.N8N_WEBHOOK_URL;
  if (!target) {
    return res.status(500).json({ ok: false, error: 'N8N_WEBHOOK_URL não configurada nas variáveis de ambiente' });
  }
  try {
    // Garantir body string
    const bodyRaw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    const forward = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyRaw
    });
    const text = await forward.text();
    // Retorna status simplificado ao front, sem expor internamente tudo
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({ ok: true, forwardedStatus: forward.status, length: text.length });
  } catch (err) {
    console.error('Erro proxy n8n:', err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}

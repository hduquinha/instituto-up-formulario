// =====================================================================
// Integração com o Mercado Pago — Checkout Transparente (API de Orders)
// ---------------------------------------------------------------------
// Este arquivo concentra TUDO que fala com o Mercado Pago. O resto do
// projeto só chama as funções daqui.
//
// Por que API de Orders e não /v1/payments: a API de Orders é o padrão
// atual do Checkout Transparente e trata cartão, Pix e boleto pelo mesmo
// endpoint (POST /v1/orders), com `external_reference` para amarrar o
// pagamento à inscrição.
//
// Credenciais (Vercel > Settings > Environment Variables):
//   MERCADOPAGO_ACCESS_TOKEN   -> SEGREDO. Nunca no front-end, nunca no git.
//   MERCADOPAGO_WEBHOOK_SECRET -> SEGREDO. "Assinatura secreta" do painel
//                                 de webhooks; sem ela não dá para provar
//                                 que a notificação veio mesmo do MP.
//   PRECO_ENCONTRO_ONLINE      -> opcional, valor cobrado (padrão 297.00).
// A chave PÚBLICA (public key) não entra aqui: ela é usada no navegador e
// mora em checkout-config.js, que é justamente o arquivo público.
// =====================================================================
const crypto = require('crypto');

const MP_API = 'https://api.mercadopago.com';
const TIMEOUT_MS = 12000;
const PRECO_PADRAO = '297.00';

function getAccessToken() {
  const token = String(process.env.MERCADOPAGO_ACCESS_TOKEN || '').trim();
  if (!token) {
    const err = new Error('MERCADOPAGO_ACCESS_TOKEN nao configurado nas variaveis de ambiente.');
    err.codigo = 'access_token_ausente';
    throw err;
  }
  return token;
}

// A public key (no navegador) e o access token (aqui) precisam ser do MESMO
// ambiente. Misturar TEST- com APP_USR- faz TODA cobranca falhar com erro
// generico do Mercado Pago — e o diagnostico so aparece se a gente contar.
function getAmbienteDoToken() {
  const token = String(process.env.MERCADOPAGO_ACCESS_TOKEN || '').trim();
  if (!token) return 'ausente';
  if (token.startsWith('TEST-')) return 'teste';
  if (token.startsWith('APP_USR-')) return 'producao';
  return 'desconhecido';
}

// O valor cobrado é decidido AQUI, no servidor, e nunca aceito do
// navegador. Se o preço viesse do cliente, qualquer visitante abriria o
// DevTools e pagaria R$ 1,00 pelo Encontro.
function getPrecoEncontro() {
  const bruto = String(process.env.PRECO_ENCONTRO_ONLINE || '').trim().replace(',', '.');
  const valor = Number.parseFloat(bruto);
  if (!Number.isFinite(valor) || valor <= 0) return PRECO_PADRAO;
  return valor.toFixed(2);
}

async function mpFetch(path, { method = 'GET', body, idempotencyKey } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const headers = {
      Authorization: `Bearer ${getAccessToken()}`,
      'Content-Type': 'application/json',
    };
    // Obrigatório em POST: sem ele o MP recusa a requisição, e é o que
    // impede que um clique duplo (ou um retry nosso) vire duas cobranças.
    if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;

    const response = await fetch(`${MP_API}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const texto = await response.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch {}

    if (!response.ok) {
      // O corpo de erro do MP tem detalhe demais para devolver ao
      // visitante (nomes de campo interno, ids). Fica no log do servidor.
      console.error('Mercado Pago respondeu erro:', response.status, texto.slice(0, 600));
      const err = new Error('mercadopago_error');
      err.codigo = 'mercadopago_recusou';
      err.status = response.status;
      err.mpBody = json;
      throw err;
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------
// Criação da Order
// ---------------------------------------------------------------------
// `pagamento` é o que veio do Payment Brick, já normalizado por
// api/pagamento.js. `valor` é sempre o do servidor.
function montarPagamento({ metodo, valor, formData }) {
  const paymentMethodId = String(formData.payment_method_id || '').trim();

  if (metodo === 'bank_transfer') {
    return {
      amount: valor,
      payment_method: {
        id: paymentMethodId || 'pix',
        type: 'bank_transfer',
      },
      // Pix com prazo curto demais expira antes de a pessoa abrir o app do
      // banco; longo demais segura vaga de quem não vai pagar. 30 minutos
      // é o meio-termo (formato ISO 8601 de duração).
      expiration_time: 'PT30M',
    };
  }

  if (metodo === 'ticket') {
    return {
      amount: valor,
      payment_method: {
        id: paymentMethodId || 'bolbradesco',
        type: 'ticket',
      },
      // Boleto compensa em dias úteis. 3 dias é o padrão do MP e já é
      // arriscado para um evento com data marcada — ver README.
      expiration_time: 'P3D',
    };
  }

  // Cartão de crédito ou débito. `installments` é sempre 1: a decisão de
  // negócio foi vender só à vista (ver cartilha, seção 7).
  return {
    amount: valor,
    payment_method: {
      id: paymentMethodId,
      type: metodo === 'debit_card' ? 'debit_card' : 'credit_card',
      token: String(formData.token || ''),
      installments: 1,
    },
  };
}

async function criarOrder({ metodo, valor, formData, externalReference, idempotencyKey, payer }) {
  const body = {
    type: 'online',
    processing_mode: 'automatic',
    total_amount: valor,
    external_reference: externalReference,
    payer,
    transactions: {
      payments: [montarPagamento({ metodo, valor, formData })],
    },
  };

  return mpFetch('/v1/orders', { method: 'POST', body, idempotencyKey });
}

function buscarOrder(orderId) {
  return mpFetch(`/v1/orders/${encodeURIComponent(orderId)}`);
}

function buscarPagamento(paymentId) {
  return mpFetch(`/v1/payments/${encodeURIComponent(paymentId)}`);
}

// ---------------------------------------------------------------------
// Leitura do resultado
// ---------------------------------------------------------------------
// A Order embrulha o pagamento em transactions.payments[]. Estes helpers
// existem para o resto do código não depender desse caminho todo.
function primeiroPagamento(order) {
  const pagamentos = order && order.transactions && Array.isArray(order.transactions.payments)
    ? order.transactions.payments
    : [];
  return pagamentos[0] || null;
}

// Traduz o status do MP para as três situações que interessam ao CRM.
// Qualquer status novo que o MP invente cai em 'pendente', que é o único
// palpite seguro: nunca tratar desconhecido como pago.
function classificarStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'approved' || s === 'accredited' || s === 'processed') return 'aprovado';
  if (s === 'rejected' || s === 'cancelled' || s === 'refunded' || s === 'charged_back') return 'recusado';
  return 'pendente';
}

// Dados que a nossa página precisa mostrar: QR do Pix, link do boleto.
function dadosParaOCliente(order) {
  const pagamento = primeiroPagamento(order);
  const metodo = (pagamento && pagamento.payment_method) || {};

  return {
    orderId: order && order.id ? String(order.id) : '',
    status: classificarStatus(pagamento && pagamento.status),
    statusBruto: (pagamento && pagamento.status) || '',
    statusDetalhe: (pagamento && pagamento.status_detail) || '',
    metodoId: metodo.id || '',
    metodoTipo: metodo.type || '',
    pixCopiaECola: metodo.qr_code || '',
    pixQrBase64: metodo.qr_code_base64 || '',
    boletoUrl: metodo.ticket_url || '',
  };
}

// ---------------------------------------------------------------------
// Assinatura do webhook
// ---------------------------------------------------------------------
// O MP manda `x-signature: ts=<epoch>,v1=<hmac>`. O HMAC-SHA256 é feito
// sobre o manifesto id:<data.id>;request-id:<x-request-id>;ts:<ts>; com a
// "Assinatura secreta" do painel como chave. Sem conferir isso, qualquer
// um que descubra a URL do webhook pode declarar um pagamento aprovado.
function partesDaAssinatura(xSignature) {
  const partes = { ts: '', v1: '' };
  String(xSignature || '')
    .split(',')
    .forEach((pedaco) => {
      const [chave, valor] = pedaco.split('=');
      if (!chave || valor === undefined) return;
      const k = chave.trim();
      if (k === 'ts' || k === 'v1') partes[k] = valor.trim();
    });
  return partes;
}

function validarAssinaturaWebhook({ xSignature, xRequestId, dataId }) {
  const secret = String(process.env.MERCADOPAGO_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    // Sem segredo configurado não dá para provar nada. Recusar é a única
    // opção segura: aceitar seria confiar em quem quer que tenha achado
    // a URL.
    return { valido: false, motivo: 'segredo_nao_configurado' };
  }

  const { ts, v1 } = partesDaAssinatura(xSignature);
  if (!ts || !v1) return { valido: false, motivo: 'assinatura_ausente' };

  // O MP documenta que ids alfanuméricos entram no manifesto em minúsculas.
  const id = String(dataId || '');
  const idNormalizado = /[a-zA-Z]/.test(id) ? id.toLowerCase() : id;

  // Cada pedaço só entra no manifesto se o valor existir.
  const manifesto = [
    idNormalizado ? `id:${idNormalizado};` : '',
    xRequestId ? `request-id:${xRequestId};` : '',
    `ts:${ts};`,
  ].join('');

  const esperado = crypto.createHmac('sha256', secret).update(manifesto).digest('hex');

  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  // Comparação de tempo constante: comparar com === vaza, pelo tempo de
  // resposta, quantos caracteres iniciais o atacante acertou.
  const confere = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!confere) return { valido: false, motivo: 'assinatura_invalida' };

  // Notificação muito antiga é sinal de replay. Não recusamos por isso
  // sozinho — o handler é idempotente e reconsulta o status na API do MP,
  // então repetir uma notificação legítima não causa dano, enquanto
  // recusar por relógio fora de sincronia perderia um pagamento real.
  const idadeSegundos = Math.abs(Date.now() / 1000 - Number(ts));
  if (Number.isFinite(idadeSegundos) && idadeSegundos > 24 * 60 * 60) {
    console.warn('Webhook do Mercado Pago com timestamp de mais de 24h:', ts);
  }

  return { valido: true, motivo: '' };
}

// Resumo do erro para a resposta HTTP. So codigos e o texto que o proprio
// Mercado Pago devolveu — nada daqui e segredo, e sem isto todo problema de
// configuracao vira "tente novamente em instantes", que nao diz nada a
// ninguem. Os logs de runtime do Vercel duram pouco demais para servirem de
// unica fonte.
function diagnosticoDoErro(err) {
  const corpo = (err && err.mpBody) || {};
  const causa = Array.isArray(corpo.cause) && corpo.cause.length ? corpo.cause[0] : null;

  return {
    codigo: (err && err.codigo) || 'erro_desconhecido',
    ambienteDoToken: getAmbienteDoToken(),
    status: (err && err.status) || null,
    mpErro: String(corpo.error || corpo.message || '').slice(0, 200) || null,
    mpCausa: causa ? String(causa.code || causa.description || '').slice(0, 200) : null,
  };
}

module.exports = {
  getPrecoEncontro,
  getAmbienteDoToken,
  diagnosticoDoErro,
  criarOrder,
  buscarOrder,
  buscarPagamento,
  primeiroPagamento,
  classificarStatus,
  dadosParaOCliente,
  validarAssinaturaWebhook,
};

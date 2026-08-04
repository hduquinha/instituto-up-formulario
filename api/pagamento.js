// =====================================================================
// Pagamento do Encontro Online — Checkout Transparente (Mercado Pago)
// ---------------------------------------------------------------------
// Duas ações, ambas por POST:
//
//   _action: 'resumo'  -> devolve nome e VALOR para a pagina montar a tela
//   (sem _action)      -> cria a Order no Mercado Pago e grava o resultado
//                         na inscricao
//
// Regra que manda em tudo aqui: o navegador NUNCA decide o valor nem quem
// esta pagando. Ele manda o id da inscricao, o token do cadastro e o que
// o Payment Brick coletou (token do cartao / meio escolhido). O valor sai
// de PRECO_ENCONTRO_ONLINE e o pagador sai do banco.
//
// Ver docs/cartilha-formularios-produtos.md (secao 7) na raiz do monorepo.
// =====================================================================
const crypto = require('crypto');
const { getPool } = require('../lib/db');
const {
  getPrecoEncontro,
  criarOrder,
  dadosParaOCliente,
  diagnosticoDoErro,
  primeiroPagamento,
} = require('../lib/mercadopago');

const MAX_BODY_BYTES = 32 * 1024;
const METODOS_ACEITOS = new Set(['credit_card', 'debit_card', 'bank_transfer', 'ticket']);
const DEFAULT_ALLOWED_DEV_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

function setCommonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
}

function normalizeOrigin(origin) {
  try {
    return new URL(origin).origin;
  } catch {
    return '';
  }
}

function getAllowedOrigin(req) {
  const origin = normalizeOrigin(req.headers.origin);
  if (!origin) return '';

  const configuradas = new Set(
    String(process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((o) => normalizeOrigin(o))
      .filter(Boolean)
  );
  if (configuradas.has(origin) || DEFAULT_ALLOWED_DEV_ORIGINS.has(origin)) return origin;

  const originHost = new URL(origin).host.toLowerCase();
  const hosts = [req.headers.host, req.headers['x-forwarded-host']]
    .flatMap((v) => String(v || '').split(','))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  return hosts.includes(originHost) ? origin : '';
}

function applyCors(req, res) {
  res.setHeader('Vary', 'Origin');
  const permitida = getAllowedOrigin(req);
  if (!permitida) return false;

  res.setHeader('Access-Control-Allow-Origin', permitida);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  return true;
}

function normalizePayload(body) {
  if (!body) return {};
  if (Buffer.isBuffer(body)) return normalizePayload(body.toString('utf8'));
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return typeof body === 'object' ? body : {};
}

function getPayloadSize(body) {
  if (!body) return 0;
  if (Buffer.isBuffer(body)) return body.length;
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
  try { return Buffer.byteLength(JSON.stringify(body), 'utf8'); } catch { return Number.POSITIVE_INFINITY; }
}

function texto(valor, max = 160) {
  return String(valor || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function primeiroNome(nomeCompleto) {
  return texto(nomeCompleto, 120).split(' ')[0] || '';
}

// ---------------------------------------------------------------------
// Carrega a inscricao conferindo o token. Comparacao em tempo constante
// pelo mesmo motivo da assinatura do webhook: com === da para descobrir o
// token um caractere por vez, medindo o tempo de resposta.
// ---------------------------------------------------------------------
async function carregarInscricao(pg, ref, token) {
  const id = Number.parseInt(ref, 10);
  const tokenInformado = texto(token, 64);
  if (!Number.isInteger(id) || id <= 0 || !tokenInformado) return null;

  const resultado = await pg.query(
    'SELECT id, payload FROM inscricoes.inscricoes WHERE id = $1 LIMIT 1',
    [id]
  );
  const linha = resultado.rows[0];
  if (!linha) return null;

  const payload = linha.payload && typeof linha.payload === 'object' ? linha.payload : {};
  const tokenGravado = texto(payload.pagamento_token, 64);
  if (!tokenGravado) return null;

  const a = Buffer.from(tokenGravado, 'utf8');
  const b = Buffer.from(tokenInformado, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  return { id: linha.id, payload };
}

async function gravarNaInscricao(pg, id, campos) {
  await pg.query(
    'UPDATE inscricoes.inscricoes SET payload = payload || $2::jsonb WHERE id = $1',
    [id, JSON.stringify(campos)]
  );
}

// ---------------------------------------------------------------------
// Acao 'resumo'
// ---------------------------------------------------------------------
async function responderResumo(pg, corpo, res) {
  const inscricao = await carregarInscricao(pg, corpo.ref, corpo.token);
  if (!inscricao) {
    res.status(404).json({ ok: false, error: 'Inscricao nao encontrada.' });
    return;
  }

  const payload = inscricao.payload;

  // Quem entrou com cupom de cortesia nao tem o que pagar. Mandar essa
  // pessoa para o Brick cobraria de novo alguem que ja tem a vaga.
  if (payload.cupom_aplicado === true || payload.cupom_aplicado === 'true') {
    res.status(200).json({ ok: true, cortesia: true });
    return;
  }

  res.status(200).json({
    ok: true,
    cortesia: false,
    nome: primeiroNome(payload.nome),
    valor: getPrecoEncontro(),
    statusPagamento: texto(payload.pagamento_status, 20) || 'nenhum',
  });
}

// ---------------------------------------------------------------------
// Criacao do pagamento
// ---------------------------------------------------------------------
// A chave de idempotencia precisa ser estavel para o MESMO envio (clique
// duplo, retry de rede) e diferente para uma tentativa nova. Para cartao,
// o proprio token do cartao ja e de uso unico e resolve isso. Para Pix e
// boleto nao existe token, entao a chave carrega uma janela de 30 minutos:
// reenviar agora reaproveita a mesma cobranca, e depois que o Pix expira a
// pessoa consegue gerar outro.
function chaveDeIdempotencia(id, metodo, formData) {
  if (metodo === 'credit_card' || metodo === 'debit_card') {
    return `inscricao-${id}-${texto(formData.token, 64)}`;
  }
  const janela = Math.floor(Date.now() / (30 * 60 * 1000));
  return `inscricao-${id}-${metodo}-${janela}`;
}

function montarPagador(payload, formData) {
  const doFormulario = (formData && typeof formData.payer === 'object' && formData.payer) || {};
  const email = texto(doFormulario.email, 120);

  const pagador = { email };

  // Boleto e Pix exigem nome e CPF; o Brick coleta isso quando o meio
  // escolhido precisa. Se o campo nao veio, cai para o nome da inscricao.
  const nome = texto(doFormulario.first_name, 60) || primeiroNome(payload.nome);
  const sobrenome = texto(doFormulario.last_name, 60)
    || texto(payload.nome, 120).split(' ').slice(1).join(' ');

  if (nome) pagador.first_name = nome;
  if (sobrenome) pagador.last_name = sobrenome;

  const identificacao = doFormulario.identification;
  if (identificacao && texto(identificacao.number, 32)) {
    pagador.identification = {
      type: texto(identificacao.type, 10) || 'CPF',
      number: texto(identificacao.number, 32),
    };
  }

  return pagador;
}

async function criarPagamento(pg, corpo, res) {
  const inscricao = await carregarInscricao(pg, corpo.ref, corpo.token);
  if (!inscricao) {
    res.status(404).json({ ok: false, error: 'Inscricao nao encontrada.' });
    return;
  }

  const payload = inscricao.payload;

  if (payload.cupom_aplicado === true || payload.cupom_aplicado === 'true') {
    res.status(409).json({ ok: false, error: 'Esta inscricao ja esta confirmada por cupom de cortesia.' });
    return;
  }

  if (texto(payload.pagamento_status, 20) === 'aprovado') {
    res.status(409).json({ ok: false, error: 'Esta inscricao ja foi paga.', jaPago: true });
    return;
  }

  const metodo = texto(corpo.metodo, 32);
  if (!METODOS_ACEITOS.has(metodo)) {
    res.status(422).json({ ok: false, error: 'Meio de pagamento invalido.' });
    return;
  }

  const formData = (corpo.formData && typeof corpo.formData === 'object') ? corpo.formData : {};
  const pagador = montarPagador(payload, formData);
  if (!pagador.email) {
    res.status(422).json({ ok: false, error: 'Informe um e-mail para o recibo.' });
    return;
  }

  const valor = getPrecoEncontro();

  let order;
  try {
    order = await criarOrder({
      metodo,
      valor,
      formData,
      // O MP limita external_reference a 64 caracteres e a letras, numeros
      // e hifen — por isso o prefixo em vez do id cru.
      externalReference: `inscricao-${inscricao.id}`,
      idempotencyKey: chaveDeIdempotencia(inscricao.id, metodo, formData),
      payer: pagador,
    });
  } catch (err) {
    console.error('Falha ao criar order no Mercado Pago:', err && err.message, err && err.mpBody);
    res.status(502).json({
      ok: false,
      error: 'Nao foi possivel processar o pagamento agora. Tente novamente em instantes.',
      diagnostico: diagnosticoDoErro(err),
    });
    return;
  }

  const dados = dadosParaOCliente(order);
  const pagamento = primeiroPagamento(order);

  // Grava o que interessa ao CRM. O QR do Pix nao e gravado de proposito:
  // e imagem em base64, expira em 30 minutos e so inchava o payload.
  const campos = {
    pagamento_status: dados.status,
    pagamento_status_detalhe: texto(dados.statusDetalhe, 60),
    pagamento_order_id: dados.orderId,
    pagamento_id: pagamento && pagamento.id ? String(pagamento.id) : '',
    pagamento_metodo: dados.metodoId || metodo,
    pagamento_metodo_tipo: dados.metodoTipo || metodo,
    pagamento_valor: valor,
    pagamento_atualizado_em: new Date().toISOString(),
  };

  // O formulario nunca pediu e-mail; o Brick pede. Guardar aqui e a unica
  // forma de o CRM ficar com o e-mail de quem paga.
  if (!texto(payload.email, 120)) campos.email = pagador.email;

  try {
    await gravarNaInscricao(pg, inscricao.id, campos);
  } catch (err) {
    // O pagamento ja existe no MP; perder a gravacao aqui nao pode
    // devolver erro para quem pagou. O webhook grava de novo depois.
    console.error('Pagamento criado mas falhou ao gravar na inscricao:', inscricao.id, err);
  }

  res.status(200).json({ ok: true, pagamento: dados });
}

async function handler(req, res) {
  setCommonHeaders(res);

  const temOrigin = typeof req.headers.origin === 'string' && req.headers.origin.length > 0;
  const corsOk = applyCors(req, res);
  if (temOrigin && !corsOk) {
    res.status(403).json({ ok: false, error: 'Origem nao permitida.' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  try {
    if (getPayloadSize(req.body) > MAX_BODY_BYTES) {
      res.status(413).json({ ok: false, error: 'Payload muito grande.' });
      return;
    }

    const corpo = normalizePayload(req.body);
    const pg = getPool();

    if (texto(corpo._action, 32) === 'resumo') {
      await responderResumo(pg, corpo, res);
      return;
    }

    await criarPagamento(pg, corpo, res);
  } catch (err) {
    console.error('Erro ao processar pagamento:', err);
    res.status(500).json({ ok: false, error: 'Nao foi possivel processar o pagamento.' });
  }
}

module.exports = handler;
module.exports.default = handler;

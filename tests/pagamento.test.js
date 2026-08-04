// Testa api/pagamento.js e api/webhook-mercadopago.js com o Postgres e o
// Mercado Pago SIMULADOS: nenhum dado real é lido ou gravado, e nenhuma
// credencial é necessária.
const path = require('path');
const crypto = require('crypto');

const RAIZ = path.join(__dirname, '..');

process.env.MERCADOPAGO_ACCESS_TOKEN = 'TEST-token-falso';
process.env.MERCADOPAGO_WEBHOOK_SECRET = 'segredo-de-teste';
process.env.PRECO_ENCONTRO_ONLINE = '297.00';
process.env.ALLOWED_ORIGINS = 'https://exemplo.test';

// ---- Postgres falso -------------------------------------------------
const TOKEN_BOM = 'a'.repeat(32);
let banco = {};
let updates = [];

function resetBanco(){
  updates = [];
  banco = {
    10: { id: 10, payload: { nome: 'Maria Silva Souza', telefone: '11999998888', pagamento_token: TOKEN_BOM } },
    11: { id: 11, payload: { nome: 'Cortesia Teste', pagamento_token: TOKEN_BOM, cupom_aplicado: true } },
    12: { id: 12, payload: { nome: 'Ja Pagou', pagamento_token: TOKEN_BOM, pagamento_status: 'aprovado' } },
  };
}

const poolFalso = {
  async query(sql, params){
    if(/^SELECT id, payload/.test(sql.trim())){
      const linha = banco[params[0]];
      return { rows: linha ? [linha] : [], rowCount: linha ? 1 : 0 };
    }
    if(/^UPDATE/.test(sql.trim())){
      updates.push({ id: params[0], campos: JSON.parse(params[1]) });
      return { rows: [], rowCount: 1 };
    }
    throw new Error('SQL inesperado no teste: ' + sql);
  }
};

const dbPath = require.resolve(path.join(RAIZ, 'lib/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getPool: () => poolFalso } };

// ---- Mercado Pago falso ---------------------------------------------
let ultimaChamada = null;
let respostaMP = null;

globalThis.fetch = async (url, opts) => {
  ultimaChamada = { url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null };
  const r = respostaMP || { status: 201, body: {} };
  return {
    ok: r.status < 400,
    status: r.status,
    text: async () => JSON.stringify(r.body),
  };
};

const pagamento = require(path.join(RAIZ, 'api/pagamento.js'));
const webhook = require(path.join(RAIZ, 'api/webhook-mercadopago.js'));

// ---- Helpers de req/res ---------------------------------------------
function fakeRes(){
  const res = {
    _status: 0, _json: null, _headers: {},
    setHeader(k, v){ this._headers[k.toLowerCase()] = v; },
    getHeader(k){ return this._headers[k.toLowerCase()]; },
    status(c){ this._status = c; return this; },
    json(o){ this._json = o; return this; },
    end(){ return this; },
  };
  return res;
}

function req(body, extra = {}){
  return { method: 'POST', headers: { host: 'exemplo.test', ...(extra.headers || {}) }, body, query: extra.query || {} };
}

let falhas = 0;
function checar(nome, condicao, detalhe){
  if(condicao){ console.log('  ok   ', nome); }
  else { falhas++; console.log('  FALHA', nome, detalhe !== undefined ? '->' + JSON.stringify(detalhe) : ''); }
}

// =====================================================================
(async function rodar(){
  console.log('\n== api/pagamento.js: resumo ==');
  resetBanco();
  let res = fakeRes();
  await pagamento(req({ _action: 'resumo', ref: 10, token: TOKEN_BOM }), res);
  checar('resumo devolve o valor do SERVIDOR', res._json && res._json.valor === '297.00', res._json);
  checar('resumo devolve só o primeiro nome', res._json && res._json.nome === 'Maria', res._json);

  res = fakeRes();
  await pagamento(req({ _action: 'resumo', ref: 10, token: 'b'.repeat(32) }), res);
  checar('token errado é recusado', res._status === 404, res._status);

  res = fakeRes();
  await pagamento(req({ _action: 'resumo', ref: 999, token: TOKEN_BOM }), res);
  checar('inscrição inexistente é recusada', res._status === 404, res._status);

  res = fakeRes();
  await pagamento(req({ _action: 'resumo', ref: 11, token: TOKEN_BOM }), res);
  checar('cortesia por cupom não vira cobrança', res._json && res._json.cortesia === true, res._json);

  console.log('\n== api/pagamento.js: criação do pagamento ==');
  resetBanco();
  respostaMP = { status: 201, body: {
    id: 'ORD-1', external_reference: 'inscricao-10',
    transactions: { payments: [{ id: 'PAY-1', status: 'approved', status_detail: 'accredited',
      payment_method: { id: 'master', type: 'credit_card' } }] }
  }};
  res = fakeRes();
  await pagamento(req({
    ref: 10, token: TOKEN_BOM, metodo: 'credit_card',
    // O navegador tenta mandar R$ 1,00 e 12x:
    formData: { token: 'card-token-1', payment_method_id: 'master', transaction_amount: 1, installments: 12,
                payer: { email: 'maria@exemplo.com' } }
  }), res);
  checar('cobra o valor do servidor, não o do navegador', ultimaChamada.body.total_amount === '297.00', ultimaChamada.body.total_amount);
  checar('parcela em 1x, ignorando o que veio do cliente', ultimaChamada.body.transactions.payments[0].payment_method.installments === 1);
  checar('manda o external_reference da inscrição', ultimaChamada.body.external_reference === 'inscricao-10', ultimaChamada.body.external_reference);
  checar('manda X-Idempotency-Key', Boolean(ultimaChamada.opts.headers['X-Idempotency-Key']));
  checar('usa o endpoint de Orders', String(ultimaChamada.url).endsWith('/v1/orders'), ultimaChamada.url);
  checar('devolve aprovado', res._json && res._json.pagamento && res._json.pagamento.status === 'aprovado', res._json);
  checar('grava o status na inscrição', updates.some(u => u.id === 10 && u.campos.pagamento_status === 'aprovado'), updates);
  checar('guarda o e-mail que só o checkout coleta', updates.some(u => u.campos.email === 'maria@exemplo.com'), updates);

  resetBanco();
  respostaMP = { status: 201, body: {
    id: 'ORD-2', external_reference: 'inscricao-10',
    transactions: { payments: [{ id: 'PAY-2', status: 'pending',
      payment_method: { id: 'pix', type: 'bank_transfer', qr_code: '00020126...', qr_code_base64: 'iVBORw0K' } }] }
  }};
  res = fakeRes();
  await pagamento(req({ ref: 10, token: TOKEN_BOM, metodo: 'bank_transfer',
    formData: { payment_method_id: 'pix', payer: { email: 'maria@exemplo.com' } } }), res);
  checar('Pix devolve o copia-e-cola', res._json.pagamento.pixCopiaECola === '00020126...', res._json.pagamento);
  checar('Pix devolve o QR em base64', res._json.pagamento.pixQrBase64 === 'iVBORw0K');
  checar('Pix fica pendente até o webhook', res._json.pagamento.status === 'pendente');
  checar('Pix tem prazo de expiração', ultimaChamada.body.transactions.payments[0].expiration_time === 'PT30M');
  checar('QR não é gravado no banco', !updates.some(u => JSON.stringify(u.campos).includes('iVBORw0K')));

  resetBanco();
  res = fakeRes();
  await pagamento(req({ ref: 12, token: TOKEN_BOM, metodo: 'credit_card', formData: { payer: { email: 'a@b.com' } } }), res);
  checar('não cobra duas vezes quem já pagou', res._status === 409, res._status);

  resetBanco();
  res = fakeRes();
  await pagamento(req({ ref: 11, token: TOKEN_BOM, metodo: 'credit_card', formData: { payer: { email: 'a@b.com' } } }), res);
  checar('não cobra quem tem cortesia', res._status === 409, res._status);

  resetBanco();
  res = fakeRes();
  await pagamento(req({ ref: 10, token: TOKEN_BOM, metodo: 'boleto_falso', formData: {} }), res);
  checar('meio de pagamento desconhecido é recusado', res._status === 422, res._status);

  resetBanco();
  res = fakeRes();
  await pagamento(req({ ref: 10, token: TOKEN_BOM, metodo: 'credit_card', formData: { payer: {} } }), res);
  checar('sem e-mail não cria cobrança', res._status === 422, res._status);

  resetBanco();
  res = fakeRes();
  await pagamento(req({}, { headers: { origin: 'https://site-malicioso.test', host: 'exemplo.test' } }), res);
  checar('origem estranha é bloqueada (CORS)', res._status === 403, res._status);

  console.log('\n== api/webhook-mercadopago.js ==');
  function assinar(dataId, requestId, ts){
    // O MP assina o data.id alfanumérico em MINÚSCULAS
    // ("ORD01JQ4S..." vira "ord01jq4s..."), então o teste tem que imitar
    // exatamente isso — senão testaria um manifesto que nunca existe.
    const id = /[a-zA-Z]/.test(dataId) ? dataId.toLowerCase() : dataId;
    const manifesto = `id:${id};request-id:${requestId};ts:${ts};`;
    const v1 = crypto.createHmac('sha256', process.env.MERCADOPAGO_WEBHOOK_SECRET).update(manifesto).digest('hex');
    return `ts=${ts},v1=${v1}`;
  }

  resetBanco();
  respostaMP = { status: 200, body: {
    id: 'PAY-9', external_reference: 'inscricao-10', status: 'approved', status_detail: 'accredited',
    payment_method_id: 'pix', transaction_amount: 297
  }};
  const ts = Math.floor(Date.now() / 1000);
  res = fakeRes();
  await webhook({
    method: 'POST',
    headers: { 'x-signature': assinar('PAY-9', 'req-1', ts), 'x-request-id': 'req-1' },
    query: { 'data.id': 'PAY-9', type: 'payment' },
    body: { type: 'payment', action: 'payment.updated', data: { id: 'PAY-9' } }
  }, res);
  checar('assinatura válida é aceita', res._status === 200, res._status);
  checar('confirma o pagamento na inscrição certa',
    updates.some(u => u.id === 10 && u.campos.pagamento_status === 'aprovado'), updates);
  checar('registra a hora da confirmação', updates.some(u => u.campos.pagamento_confirmado_em), updates);

  resetBanco();
  res = fakeRes();
  await webhook({
    method: 'POST',
    headers: { 'x-signature': `ts=${ts},v1=${'0'.repeat(64)}`, 'x-request-id': 'req-1' },
    query: { 'data.id': 'PAY-9', type: 'payment' },
    body: {}
  }, res);
  checar('assinatura forjada é recusada', res._status === 401, res._status);
  checar('nada é gravado com assinatura inválida', updates.length === 0, updates);

  resetBanco();
  res = fakeRes();
  await webhook({
    method: 'POST',
    headers: { 'x-request-id': 'req-1' },
    query: { 'data.id': 'PAY-9', type: 'payment' },
    body: {}
  }, res);
  checar('sem assinatura nenhuma é recusado', res._status === 401, res._status);

  resetBanco();
  respostaMP = { status: 200, body: { id: 'PAY-8', external_reference: 'outra-coisa', status: 'approved' } };
  res = fakeRes();
  await webhook({
    method: 'POST',
    headers: { 'x-signature': assinar('PAY-8', 'req-2', ts), 'x-request-id': 'req-2' },
    query: { 'data.id': 'PAY-8', type: 'payment' },
    body: {}
  }, res);
  checar('pagamento de fora do formulário é ignorado sem erro', res._status === 200 && updates.length === 0, [res._status, updates]);

  resetBanco();
  respostaMP = { status: 200, body: {
    id: 'PAY-7', external_reference: 'inscricao-10', status: 'rejected', status_detail: 'cc_rejected_bad_filled'
  }};
  res = fakeRes();
  await webhook({
    method: 'POST',
    headers: { 'x-signature': assinar('PAY-7', 'req-3', ts), 'x-request-id': 'req-3' },
    query: { 'data.id': 'PAY-7', type: 'payment' },
    body: {}
  }, res);
  checar('recusa do MP vira status recusado',
    updates.some(u => u.campos.pagamento_status === 'recusado'), updates);

  console.log(falhas === 0 ? '\nTodos os testes passaram.\n' : `\n${falhas} teste(s) falharam.\n`);
  process.exit(falhas === 0 ? 0 : 1);
})();

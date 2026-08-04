// =====================================================================
// Webhook do Mercado Pago — confirmacao de pagamento
// ---------------------------------------------------------------------
// O que fecha o ciclo: sem esta rota, `pagamento_status` ficaria parado em
// "pendente" para todo Pix e todo boleto, porque esses meios so aprovam
// depois que a pessoa sai da nossa pagina.
//
// Configurar em: Mercado Pago > Suas integracoes > (aplicacao) > Webhooks
//   URL:     https://<dominio-do-formulario>/api/webhook-mercadopago
//   Eventos: Pagamentos (payment) e Pedidos (orders)
// A "Assinatura secreta" mostrada nessa tela vai para a variavel de
// ambiente MERCADOPAGO_WEBHOOK_SECRET na Vercel.
//
// Duas regras que sustentam a seguranca desta rota:
//
// 1. A notificacao e tratada como um AVISO, nunca como a verdade. Ela diz
//    "o pagamento X mudou"; quem diz qual e o status e a API do Mercado
//    Pago, consultada logo em seguida. Assim, mesmo que alguem consiga
//    forjar uma notificacao, nao consegue declarar um pagamento aprovado.
// 2. A assinatura e conferida antes de qualquer coisa (x-signature).
// =====================================================================
const { getPool } = require('../lib/db');
const {
  validarAssinaturaWebhook,
  buscarOrder,
  buscarPagamento,
  primeiroPagamento,
  classificarStatus,
} = require('../lib/mercadopago');

function texto(valor, max = 160) {
  return String(valor || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function normalizeBody(body) {
  if (!body) return {};
  if (Buffer.isBuffer(body)) return normalizeBody(body.toString('utf8'));
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return typeof body === 'object' ? body : {};
}

// O MP manda o id ora na querystring (`?data.id=`), ora no corpo. Nao dá
// para escolher um so: o mesmo painel dispara os dois formatos conforme o
// evento.
function extrairDataId(req, body) {
  const daQuery = req.query && (req.query['data.id'] || req.query.id);
  if (daQuery) return texto(Array.isArray(daQuery) ? daQuery[0] : daQuery, 64);
  if (body && body.data && body.data.id) return texto(body.data.id, 64);
  return texto(body && body.id, 64);
}

function extrairTipo(req, body) {
  const daQuery = req.query && (req.query.type || req.query.topic);
  const bruto = daQuery || (body && (body.type || body.topic));
  return texto(Array.isArray(bruto) ? bruto[0] : bruto, 32).toLowerCase();
}

// external_reference sai daqui como "inscricao-123"; devolve 123.
function idDaInscricao(externalReference) {
  const match = /^inscricao-(\d+)$/.exec(texto(externalReference, 64));
  if (!match) return 0;
  const id = Number.parseInt(match[1], 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

// Busca no Mercado Pago o estado real do que a notificacao mencionou.
async function consultarSituacao(tipo, dataId) {
  if (tipo === 'payment') {
    const pagamento = await buscarPagamento(dataId);
    return {
      externalReference: pagamento && pagamento.external_reference,
      status: pagamento && pagamento.status,
      statusDetalhe: pagamento && pagamento.status_detail,
      pagamentoId: pagamento && pagamento.id,
      orderId: pagamento && pagamento.order && pagamento.order.id,
      metodo: pagamento && pagamento.payment_method_id,
      valor: pagamento && pagamento.transaction_amount,
    };
  }

  const order = await buscarOrder(dataId);
  const pagamento = primeiroPagamento(order);
  return {
    externalReference: order && order.external_reference,
    status: pagamento && pagamento.status,
    statusDetalhe: pagamento && pagamento.status_detail,
    pagamentoId: pagamento && pagamento.id,
    orderId: order && order.id,
    metodo: pagamento && pagamento.payment_method && pagamento.payment_method.id,
    valor: pagamento && pagamento.amount,
  };
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false });
    return;
  }

  const body = normalizeBody(req.body);
  const dataId = extrairDataId(req, body);
  const tipo = extrairTipo(req, body);

  const assinatura = validarAssinaturaWebhook({
    xSignature: req.headers['x-signature'],
    xRequestId: req.headers['x-request-id'],
    dataId,
  });

  if (!assinatura.valido) {
    console.warn('Webhook do Mercado Pago recusado:', assinatura.motivo);
    // O motivo vai TAMBEM na resposta, de proposito: e a unica forma de
    // conferir de fora se MERCADOPAGO_WEBHOOK_SECRET chegou no ambiente
    // (os logs de runtime do Vercel duram pouco e somem). Nao ha o que
    // vazar: nenhum destes valores ajuda a forjar uma assinatura, e
    // "segredo_nao_configurado" so conta que o endpoint esta recusando
    // tudo — o que um atacante descobriria na primeira tentativa.
    res.status(401).json({ ok: false, motivo: assinatura.motivo });
    return;
  }

  // Tipos que nao tratamos (chargeback, reclamacao) sao respondidos com
  // 200 de proposito: 200 significa "recebi", e pedir retry de um evento
  // que vamos ignorar de novo so gera ruido.
  if (!dataId || (tipo !== 'payment' && tipo !== 'order' && tipo !== 'orders')) {
    res.status(200).json({ ok: true, ignorado: true });
    return;
  }

  try {
    const situacao = await consultarSituacao(tipo === 'payment' ? 'payment' : 'order', dataId);
    const inscricaoId = idDaInscricao(situacao.externalReference);

    if (!inscricaoId) {
      // Pagamento que nao nasceu deste formulario (teste no painel, outra
      // integracao). Nada a fazer, mas nao e erro.
      res.status(200).json({ ok: true, semInscricao: true });
      return;
    }

    const status = classificarStatus(situacao.status);
    const campos = {
      pagamento_status: status,
      pagamento_status_detalhe: texto(situacao.statusDetalhe, 60),
      pagamento_id: situacao.pagamentoId ? String(situacao.pagamentoId) : '',
      pagamento_order_id: situacao.orderId ? String(situacao.orderId) : '',
      pagamento_metodo: texto(situacao.metodo, 40),
      pagamento_atualizado_em: new Date().toISOString(),
    };

    if (situacao.valor !== undefined && situacao.valor !== null) {
      campos.pagamento_valor = String(situacao.valor);
    }
    if (status === 'aprovado') {
      campos.pagamento_confirmado_em = new Date().toISOString();
    }

    await getPool().query(
      'UPDATE inscricoes.inscricoes SET payload = payload || $2::jsonb WHERE id = $1',
      [inscricaoId, JSON.stringify(campos)]
    );

    res.status(200).json({ ok: true });
  } catch (err) {
    // 500 aqui e proposital: o Mercado Pago reenvia a notificacao, e é
    // isso que queremos quando o erro foi nosso (banco fora, timeout).
    console.error('Falha ao processar webhook do Mercado Pago:', err);
    res.status(500).json({ ok: false });
  }
}

module.exports = handler;
module.exports.default = handler;

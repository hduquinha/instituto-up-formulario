// =============================================================
// Checkout do Encontro Online (Instituto UP)
// -------------------------------------------------------------
// Configuração PÚBLICA do checkout. Carregado pelo formulário
// (index.html), pela tela de cupom aplicado (checkout.html) e pela
// página de pagamento (pagamento.html).
//
// O que NUNCA pode entrar aqui, porque este arquivo é servido para
// qualquer visitante:
//   - MERCADOPAGO_ACCESS_TOKEN (é ele que autoriza cobranças)
//   - MERCADOPAGO_WEBHOOK_SECRET
//   - os códigos de cupom (CUPONS_ENCONTRO_ONLINE)
// Tudo isso vive só em variável de ambiente na Vercel.
//
// A public key ABAIXO é diferente: o Mercado Pago a projetou para ficar
// exposta no navegador. Ela só serve para tokenizar cartão, não para
// mover dinheiro.
// =============================================================
window.CHECKOUT_CONFIG = {
  // Chave pública da aplicação do Mercado Pago.
  //   Teste:    TEST-xxxxxxxx-xxxx-...
  //   Produção: APP_USR-xxxxxxxx-xxxx-...
  // Precisa ser do MESMO ambiente do MERCADOPAGO_ACCESS_TOKEN na Vercel:
  // public key de teste com access token de produção (ou o contrário) faz
  // todo pagamento falhar com erro genérico, que é chato de diagnosticar.
  // Vazia, a página de pagamento avisa que o pagamento está indisponível
  // em vez de mostrar uma caixa quebrada.
  // ATENÇÃO: esta é a chave de TESTE. Nenhum pagamento feito com ela é real.
  // Ao virar para produção, trocar pela APP_USR-... E trocar junto o
  // MERCADOPAGO_ACCESS_TOKEN na Vercel — os dois têm que ser do mesmo ambiente.
  mercadoPagoPublicKey: 'TEST-df758204-c68f-4381-a9d4-0a7d75e03769',

  // Nossa página de pagamento (Checkout Transparente).
  paginaPagamento: 'pagamento.html',

  // Valor cheio do Encontro Online, exibido riscado na tela de cupom.
  // Precisa bater com o "Investimento" mostrado no topo do formulário
  // (index.html) — se um mudar, mude o outro.
  //
  // ATENÇÃO: isto é só exibição. O valor REALMENTE cobrado é decidido no
  // servidor, pela variável de ambiente PRECO_ENCONTRO_ONLINE (padrão
  // 297.00) — ver lib/mercadopago.js. Se o preço subir, mude nos dois
  // lugares; o servidor é quem manda.
  precoOriginal: 297,

  // Tela mostrada quando o servidor aceita o cupom.
  paginaCupom: 'checkout.html',

  // Contato para quem entra por cortesia (não passa pelo pagamento).
  whatsappUrl:
    'https://wa.me/5513997832766?text=' +
    encodeURIComponent('Olá! Acabei de me inscrever no Encontro UP usando um cupom e quero confirmar minha vaga.'),
};

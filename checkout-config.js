// =============================================================
// Checkout do Encontro Online (Instituto UP)
// -------------------------------------------------------------
// Fonte única do link de pagamento e do valor exibido. Carregado
// pelo formulário (index.html) e pela tela de cupom aplicado
// (checkout.html) — mudar aqui muda nos dois lugares.
//
// Os CÓDIGOS de cupom NÃO ficam neste arquivo. Eles são validados
// no servidor (api/inscricao.js, variável de ambiente
// CUPONS_ENCONTRO_ONLINE), porque esta página é pública: qualquer
// visitante que abrisse o código-fonte leria os códigos e teria
// entrada gratuita.
// =============================================================
window.CHECKOUT_CONFIG = {
  // Link de pagamento da Asaas — destino de quem NÃO tem cupom.
  asaasUrl: 'https://www.asaas.com/c/sditrjl7hbbjiar2',

  // Valor cheio do Encontro Online, exibido riscado na tela de cupom.
  // Precisa bater com o "Investimento" mostrado no topo do formulário
  // (index.html) — se um mudar, mude o outro.
  // Deixe null para a tela mostrar só "Total: R$ 0,00", sem valor riscado.
  precoOriginal: 297,

  // Tela mostrada quando o servidor aceita o cupom.
  paginaCupom: 'checkout.html',

  // Segundos até o redirecionamento automático para a Asaas.
  redirectDelaySeconds: 4,

  // Contato para quem entra por cortesia (não passa pela Asaas).
  whatsappUrl:
    'https://wa.me/5513997832766?text=' +
    encodeURIComponent('Olá! Acabei de me inscrever no Encontro UP usando um cupom e quero confirmar minha vaga.'),
};

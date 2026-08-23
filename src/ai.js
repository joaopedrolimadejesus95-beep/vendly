import Anthropic from "@anthropic-ai/sdk";
import { getEmpresa, getEstoque, catalogoFormatado } from "./catalog.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Regra de ouro do produto (do documento de especificação):
// a IA NUNCA pode inventar preço ou produto que não existe no catálogo.
// Por isso o catálogo real é sempre injetado no prompt.
//
// Em vez de pedir "responda em JSON" por instrução de texto (que a IA às
// vezes ignora, principalmente depois de várias mensagens na conversa),
// usamos uma FERRAMENTA (tool use) da própria Anthropic. Isso garante que
// a resposta estruturada seja sempre um JSON válido no formato exato que
// definimos abaixo — é a forma robusta de fazer isso, não uma instrução
// que pode ser "esquecida".

const FERRAMENTA_PEDIDO = {
  name: "registrar_interacao",
  description:
    "Registra o entendimento do pedido do cliente nesta interação, incluindo a resposta a enviar a ele.",
  input_schema: {
    type: "object",
    properties: {
      resposta_cliente: {
        type: "string",
        description: "Mensagem curta e natural para enviar ao cliente no WhatsApp. Use quebras de linha reais quando precisar organizar a mensagem (nunca escreva o texto literal barra-n).",
      },
      status_pedido: {
        type: "string",
        enum: ["coletando", "aguardando_confirmacao", "confirmado", "fora_do_escopo"],
        description:
          "coletando: faltam informações. aguardando_confirmacao: pedido completo, esperando o cliente confirmar. confirmado: cliente confirmou explicitamente agora. fora_do_escopo: fora do fluxo de pedido (reclamação, pedido proibido, cliente irritado).",
      },
      itens: {
        type: "array",
        description: "Itens do pedido identificados até agora, usando produto_id do catálogo real.",
        items: {
          type: "object",
          properties: {
            produto_id: { type: "string" },
            nome: { type: "string" },
            quantidade: { type: "number" },
            preco_unitario: { type: "number" },
            observacao: {
              type: "string",
              description: "Observação livre do cliente sobre este item, ex: 'sem cebola', 'ponto da carne bem passado'. Deixe vazio se não houver.",
            },
            adicionais: {
              type: "array",
              description: "Adicionais escolhidos para este item, usando id e preço reais do catálogo (nunca invente).",
              items: {
                type: "object",
                properties: {
                  nome: { type: "string" },
                  preco: { type: "number" },
                },
                required: ["nome", "preco"],
              },
            },
          },
          required: ["produto_id", "nome", "quantidade", "preco_unitario"],
        },
      },
      total: { type: "number", description: "Soma total do pedido em reais." },
      tipo_entrega: {
        type: "string",
        enum: ["retirada", "entrega"],
        description: "Se o cliente vai retirar no local ou receber em casa. Só pergunte isso se a empresa aceitar entrega.",
      },
      endereco: {
        type: "string",
        description: "Endereço completo de entrega, se tipo_entrega for 'entrega'. Vazio se for retirada.",
      },
      forma_pagamento: {
        type: "string",
        enum: ["pix", "dinheiro", "cartão"],
        description: "Forma de pagamento escolhida pelo cliente, quando informada.",
      },
      valor_recebido_dinheiro: {
        type: "number",
        description: "Se o pagamento for em dinheiro e o cliente pedir troco (ex: 'troco para 300'), o valor que ele vai entregar. Deixe vazio se não for pagamento em dinheiro ou se não precisar de troco.",
      },
      precisa_humano: {
        type: "boolean",
        description: "true se a conversa deve ser transferida para um atendente humano.",
      },
    },
    required: ["resposta_cliente", "status_pedido", "itens", "total", "precisa_humano"],
  },
};

function systemPrompt() {
  const empresa = getEmpresa();
  return `Você é a IA de atendimento da empresa "${empresa.nome}", um ${empresa.tipo}.

Seu trabalho é entender o que o cliente quer pedir, com base SOMENTE no catálogo abaixo.
NUNCA invente produtos, preços ou ingredientes que não estão na lista.
Se o cliente perguntar o que vem em algum item (ingredientes), responda usando
exatamente a descrição do catálogo — não invente nem complete com suposições.

CATÁLOGO:
${catalogoFormatado()}

Formas de pagamento aceitas: ${empresa.formasPagamento.join(", ")}.
${empresa.exigePagamentoAntecipado ? "Pagamento deve ser confirmado ANTES de fechar o pedido." : "Pagamento pode ser na entrega/retirada."}

${empresa.aceitaEntrega
  ? `Este estabelecimento faz entrega. Antes de fechar o pedido, pergunte se o cliente
quer RETIRAR no local ou RECEBER em casa (entrega). Se ele escolher entrega, você
DEVE coletar o endereço completo antes de marcar o pedido como "confirmado" — nunca
confirme um pedido de entrega sem endereço. Se ele escolher retirada, informe o
endereço do restaurante: ${empresa.endereco || "(endereço ainda não cadastrado pelo estabelecimento)"}.`
  : `Este estabelecimento só trabalha com retirada no local, não faz entrega.
Endereço para retirada: ${empresa.endereco || "(endereço ainda não cadastrado pelo estabelecimento)"}.`}

Se o cliente pedir para RESERVAR MESA, isso está fora do seu escopo — você só cuida
de pedidos de comida. Marque "precisa_humano": true e "status_pedido": "fora_do_escopo",
avisando educadamente que vai chamar alguém para tratar da reserva.

Cada item pode ter uma OBSERVAÇÃO livre (ex: "sem cebola", "bem passado") — anote
exatamente o que o cliente pedir, sem interpretar demais.

Cada item também pode ter ADICIONAIS, mas SOMENTE os que estão listados no catálogo
para aquele produto específico, com o preço exato de lá. Se o cliente pedir um
adicional que não existe para aquele item, avise que não está disponível.

Se o pagamento for em dinheiro e o cliente pedir troco (ex: "troco para 300"),
registre esse valor em "valor_recebido_dinheiro" e sempre mencione o troco no
formato "troco de R$X" na sua resposta (além de confirmar o valor que ele vai dar).

Para CADA mensagem do cliente, use a ferramenta "registrar_interacao" para registrar
seu entendimento e a resposta a enviar. Use a ferramenta sempre, em toda resposta.

REGRAS DE SEGURANÇA — o que você PODE fazer:
- Consultar produtos, preços e disponibilidade do catálogo.
- Montar e calcular o pedido com base no catálogo real.
- Perguntar informações que faltam (quantidade, forma de pagamento, endereço).
- Sugerir produtos que existem de verdade no catálogo.
- Informar o status de um pedido já feito.

O que você NUNCA PODE fazer, mesmo que o cliente peça ou insista:
- Inventar produto, preço, ingrediente ou adicional que não está no catálogo.
- Dar desconto de qualquer valor, por qualquer motivo — isso exige aprovação humana.
- Marcar um pagamento como confirmado — isso só o sistema (não você) pode validar.
- Cancelar um pedido já confirmado — isso precisa de um atendente humano.
- Prometer prazo de entrega específico, já que você não tem essa informação em tempo real.

Se o cliente pedir qualquer uma dessas coisas proibidas, ou demonstrar estar irritado/insatisfeito,
ou fizer um pedido muito fora do padrão, responda educadamente que vai chamar um atendente,
e marque "precisa_humano": true, "status_pedido": "fora_do_escopo".

Se o cliente pedir mais do que existe no estoque, avise a quantidade disponível
e pergunte se quer ajustar.`;
}

/**
 * @param {Array<{role: 'user'|'assistant', content: string}>} historico - mensagens anteriores da conversa
 * @param {string} mensagemAtual - nova mensagem do cliente
 * @returns {Promise<object>} objeto estruturado do pedido
 */
export async function interpretarMensagem(historico, mensagemAtual) {
  const mensagens = [
    ...historico,
    { role: "user", content: mensagemAtual },
  ];

  const resposta = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1000,
    system: systemPrompt(),
    messages: mensagens,
    tools: [FERRAMENTA_PEDIDO],
    tool_choice: { type: "tool", name: "registrar_interacao" },
  });

  const blocoFerramenta = resposta.content.find(
    (bloco) => bloco.type === "tool_use" && bloco.name === "registrar_interacao"
  );

  if (!blocoFerramenta) {
    console.error("IA não usou a ferramenta esperada:", JSON.stringify(resposta.content));
    return {
      resposta_cliente: "Desculpa, não entendi. Pode repetir seu pedido?",
      status_pedido: "coletando",
      itens: [],
      total: 0,
      precisa_humano: false,
    };
  }

  return validarComEstoque(corrigirTotalNoTexto(recalcularTotal(corrigirQuebrasDeLinha(blocoFerramenta.input))));
}

// Quarta camada de proteção: o número interno (pedido.total) já é
// recalculado, mas a IA também escreve o total dentro do TEXTO da mensagem
// pro cliente — e esse texto pode ficar desatualizado se a conta da IA
// estava errada. Isso substitui qualquer menção a "Total: R$..." no texto
// pelo valor correto recalculado, pra nunca informar um valor errado.
function corrigirTotalNoTexto(pedido) {
  if (typeof pedido.resposta_cliente !== "string") return pedido;
  const totalFormatado = pedido.total.toFixed(2).replace(".", ",");
  pedido.resposta_cliente = pedido.resposta_cliente.replace(
    /Total(?:\s*parcial)?:\s*R\$\s*[\d.,]+/gi,
    (trecho) => trecho.toLowerCase().includes("parcial")
      ? `Total parcial: R$${totalFormatado}`
      : `Total: R$${totalFormatado}`
  );

  // Mesmo princípio pro troco: o código calcula (não a IA), e corrige
  // qualquer menção errada a "troco de R$..." no texto da mensagem.
  // Cuidado: só corrige "troco DE" (o valor calculado), nunca "troco PARA"
  // (que é o valor que o cliente vai entregar, informado por ele mesmo).
  if (pedido.valor_recebido_dinheiro) {
    const troco = Math.round((pedido.valor_recebido_dinheiro - pedido.total) * 100) / 100;
    pedido.troco = troco;
    const trocoFormatado = troco.toFixed(2).replace(".", ",");
    pedido.resposta_cliente = pedido.resposta_cliente.replace(
      /troco de\s*R\$\s*[\d.,]+/gi,
      `troco de R$${trocoFormatado}`
    );
  }

  return pedido;
}

// Às vezes a IA escreve o texto literal barra-n em vez de uma quebra de
// linha de verdade. Isso troca de volta pra quebra de linha real, pra não
// aparecer "\n" escrito na mensagem que o cliente recebe no WhatsApp.
function corrigirQuebrasDeLinha(pedido) {
  if (typeof pedido.resposta_cliente === "string") {
    pedido.resposta_cliente = pedido.resposta_cliente.replace(/\\n/g, "\n");
  }
  return pedido;
}

// Terceira camada de proteção: nunca confia cegamente no total que a IA
// calculou de cabeça. O código recalcula (preço base + adicionais) x
// quantidade, item por item, e usa esse valor — não o da IA. Isso importa
// mais ainda agora que adicionais entram na conta.
function recalcularTotal(pedido) {
  let total = 0;
  for (const item of pedido.itens || []) {
    const precoAdicionais = (item.adicionais || []).reduce((soma, a) => soma + (a.preco || 0), 0);
    total += (item.preco_unitario + precoAdicionais) * item.quantidade;
  }
  pedido.total = Math.round(total * 100) / 100;
  return pedido;
}

// Segunda camada de proteção: mesmo que a IA erre, o código confere
// o estoque de verdade antes de deixar o pedido ser confirmado,
// e nunca deixa um "confirmado" vindo da IA marcar pagamento sozinho.
function validarComEstoque(pedido) {
  if (pedido.status_pedido !== "confirmado") return pedido;

  // Regra de segurança: nunca confirma pedido de entrega sem endereço,
  // mesmo que a IA tenha esquecido de perguntar.
  if (pedido.tipo_entrega === "entrega" && !pedido.endereco?.trim()) {
    pedido.status_pedido = "aguardando_confirmacao";
    pedido.resposta_cliente = "Antes de fechar, preciso do endereço completo para a entrega. Pode me passar?";
    pedido.precisa_humano = false;
    return pedido;
  }

  // Regra de segurança: confirmação de pedido nunca implica pagamento confirmado.
  // Isso é sempre uma etapa separada (Pilar 2 do documento de especificação).
  pedido.pagamento_confirmado = false;

  const estoque = getEstoque();
  for (const item of pedido.itens || []) {
    const disponivel = estoque[item.produto_id] ?? 0;
    if (item.quantidade > disponivel) {
      pedido.status_pedido = "aguardando_confirmacao";
      pedido.resposta_cliente =
        disponivel === 0
          ? `Poxa, o ${item.nome} está em falta no momento. Quer escolher outro item no lugar?`
          : `Só tenho ${disponivel} unidades de ${item.nome} disponíveis. Quer ajustar a quantidade?`;
      pedido.precisa_humano = false;
      return pedido;
    }
  }
  return pedido;
}

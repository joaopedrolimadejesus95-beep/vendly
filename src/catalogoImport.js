// Leitura do cardápio a partir de foto(s) ou PDF, usando a mesma IA que
// atende no WhatsApp — só que aqui a "mensagem" do cliente é a imagem do
// cardápio, e a "ferramenta" devolve os produtos em vez de um pedido.
//
// IMPORTANTE: isso só EXTRAI e devolve a lista. Nada é salvo no banco
// aqui — quem decide o que salvar é o dono, na tela de revisão do painel
// (ver rota /api/cardapio/importar-confirmar em server.js).

import Anthropic from "@anthropic-ai/sdk";
import { sanitizarTamanhos } from "./catalog.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CATEGORIAS_VALIDAS = ["comida", "salada", "bebida", "sobremesa"];

const FERRAMENTA_CARDAPIO = {
  name: "registrar_itens_cardapio",
  description: "Registra os itens de cardápio identificados nas imagens/PDF enviados.",
  input_schema: {
    type: "object",
    properties: {
      itens: {
        type: "array",
        description: "Um item por produto do cardápio encontrado nas imagens/PDF.",
        items: {
          type: "object",
          properties: {
            nome: { type: "string", description: "Nome do produto, exatamente como está escrito no cardápio." },
            descricao: { type: "string", description: "Ingredientes/descrição do item, se houver no cardápio. Vazio se não houver." },
            preco: {
              type: "number",
              description: "Preço da porção inteira, em reais. Só use isso se o item tem UM preço só — se tiver vários tamanhos (ex: pizza PP/P/M/G), deixe vazio e use 'tamanhos' em vez disso. NUNCA invente — se o preço estiver ilegível/cortado, deixe este campo de fora e explique em 'duvida'.",
            },
            categoria: { type: "string", enum: CATEGORIAS_VALIDAS },
            unidade: { type: "string", description: "Ex: '350ml', '1kg'. Vazio se não se aplicar." },
            temMeiaPorcao: { type: "boolean" },
            precoMeia: { type: "number", description: "Preço da meia porção, só se temMeiaPorcao for true e o cardápio mostrar esse preço." },
            tamanhos: {
              type: "array",
              description:
                "Use isso quando o item tem MAIS DE UM preço por tamanho (ex: pizza 'PP R$10 - P R$20 - M R$25 - G R$30', bebida 'lata R$6 / garrafa R$12'). Um objeto por tamanho, com o nome EXATAMENTE como está escrito no cardápio (PP, P, M, G, Broto, Pequena, Média, Grande, Família, Individual, lata, garrafa, etc — copie a abreviação do cardápio, não troque por um nome 'completo' inventado). Deixe vazio (não preencha) se o item tem um preço só — nesse caso use o campo 'preco'.",
              items: {
                type: "object",
                properties: {
                  nome: { type: "string" },
                  preco: { type: "number", description: "NUNCA invente — se o preço desse tamanho específico estiver ilegível, não inclua esse tamanho na lista e explique em 'duvida'." },
                },
                required: ["nome", "preco"],
              },
            },
            adicionais: {
              type: "array",
              items: {
                type: "object",
                properties: { nome: { type: "string" }, preco: { type: "number" } },
                required: ["nome", "preco"],
              },
            },
            duvida: {
              type: "string",
              description: "Preencha SOMENTE se algo nesse item ficou incerto na leitura (preço borrado, letra ilegível, ambiguidade). Vazio caso contrário.",
            },
          },
          required: ["nome"],
        },
      },
    },
    required: ["itens"],
  },
};

const SYSTEM_PROMPT = `Você lê fotos ou PDFs de cardápios impressos de restaurante e extrai cada
item como um produto estruturado, usando a ferramenta "registrar_itens_cardapio".

REGRAS:
- Leia cada item do cardápio, mesmo que a formatação das imagens seja ruim
  (foto torta, luz ruim, letra apertada) — faça o melhor possível.
- NUNCA invente preço. Se não conseguir ler um preço com confiança, deixe o
  campo "preco" de fora desse item e explique o motivo em "duvida" (ex:
  "preço cortado na foto").
- Categoria: escolha entre comida, salada, bebida ou sobremesa — a que
  melhor descreve o item, mesmo que o cardápio use outro nome de seção.
- Se dois preços aparecem pro mesmo item e são claramente "porção inteira"
  e "meia porção" (ex: "inteira R$40 / meia R$25"), use preco = inteira,
  temMeiaPorcao = true, precoMeia = meia.
- Se um item tem TRÊS OU MAIS preços, ou os rótulos não são "inteira/meia"
  (ex: pizza "PP 10,00 - P 20,00 - M 25,00 - G 30,00", bebida "lata/garrafa",
  sorvete "1 bola/2 bolas/3 bolas"), isso é um produto com TAMANHOS — use o
  campo "tamanhos" (um nome + preço por tamanho, copiando a abreviação exata
  do cardápio) e deixe "preco" e "temMeiaPorcao" vazios para esse item. Isso
  é comum em pizzarias — preste atenção especial em cardápios de pizza.
- Se a imagem não for um cardápio (ou não tiver nenhum item legível), devolva
  itens: [] — não invente itens pra preencher.
- Use a ferramenta sempre, em toda resposta.`;

const EXTENSOES_PERMITIDAS = {
  "image/jpeg": "image",
  "image/png": "image",
  "application/pdf": "document",
};

/**
 * @param {Array<{buffer: Buffer, mimetype: string}>} arquivos - até 5 imagens OU 1 PDF
 * @returns {Promise<Array<object>>} itens extraídos, SEM salvar nada
 */
export async function extrairItensCardapio(arquivos) {
  if (!arquivos || arquivos.length === 0) {
    throw new Error("Nenhum arquivo enviado.");
  }

  const blocos = arquivos.map((arquivo) => {
    const tipo = EXTENSOES_PERMITIDAS[arquivo.mimetype];
    if (!tipo) {
      throw new Error(`Tipo de arquivo não suportado: ${arquivo.mimetype}. Envie JPG, PNG ou PDF.`);
    }
    return tipo === "image"
      ? { type: "image", source: { type: "base64", media_type: arquivo.mimetype, data: arquivo.buffer.toString("base64") } }
      : { type: "document", source: { type: "base64", media_type: arquivo.mimetype, data: arquivo.buffer.toString("base64") } };
  });

  const resposta = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          ...blocos,
          { type: "text", text: "Extraia todos os itens de cardápio dessas imagens/PDF." },
        ],
      },
    ],
    tools: [FERRAMENTA_CARDAPIO],
    tool_choice: { type: "tool", name: "registrar_itens_cardapio" },
  });

  const blocoFerramenta = resposta.content.find(
    (bloco) => bloco.type === "tool_use" && bloco.name === "registrar_itens_cardapio"
  );

  if (!blocoFerramenta) {
    throw new Error("Não consegui ler o cardápio dessas imagens. Tente fotos mais nítidas.");
  }

  return (blocoFerramenta.input.itens || []).map(sanitizarItemExtraido);
}

// Mesmo princípio das camadas de proteção do ai.js: nunca confia cegamente
// no que a IA devolveu — trava categoria inválida, preço negativo, etc.
// Exportada pra poder testar sem precisar chamar a IA de verdade.
export function sanitizarItemExtraido(item) {
  const precoValido = typeof item.preco === "number" && item.preco >= 0;
  const precoMeiaValido = typeof item.precoMeia === "number" && item.precoMeia >= 0;
  const tamanhos = sanitizarTamanhos(item.tamanhos);
  const temTamanhos = tamanhos.length > 0;
  return {
    nome: String(item.nome || "").trim().slice(0, 200),
    descricao: String(item.descricao || "").trim().slice(0, 500),
    // Com tamanhos, o preço único não se aplica — zera pra não confundir a
    // tela de revisão (mesma regra de catalog.js: quem manda é "tamanhos").
    preco: temTamanhos ? null : precoValido ? item.preco : null,
    categoria: CATEGORIAS_VALIDAS.includes(item.categoria) ? item.categoria : "comida",
    unidade: String(item.unidade || "").trim().slice(0, 50),
    temMeiaPorcao: !temTamanhos && Boolean(item.temMeiaPorcao) && precoMeiaValido,
    precoMeia: !temTamanhos && Boolean(item.temMeiaPorcao) && precoMeiaValido ? item.precoMeia : null,
    tamanhos,
    adicionais: Array.isArray(item.adicionais)
      ? item.adicionais
          .filter((a) => a && typeof a.nome === "string" && typeof a.preco === "number" && a.preco >= 0)
          .map((a) => ({ nome: a.nome.trim().slice(0, 100), preco: a.preco }))
      : [],
    duvida: String(item.duvida || "").trim().slice(0, 300) || (precoValido || temTamanhos ? "" : "preço não identificado"),
  };
}

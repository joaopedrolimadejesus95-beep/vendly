// validarPrecosComCatalogo (ai.js) — a camada que decide o preço de
// verdade de cada item do pedido e trava a confirmação de produto com
// tamanho inválido/não escolhido. Testa direto, sem chamar a IA de
// verdade (monta o "pedido" na mão, do jeito que a ferramenta devolveria).
import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { TEM_DB, prepararBanco, limparBanco, fecharBanco, criarEmpresaCrua } from "../helpers/db.mjs";
import { salvarProduto } from "../../src/catalog.js";

process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-dummy";
const { validarPrecosComCatalogo } = await import("../../src/ai.js");

const itemPizza = (over = {}) => ({
  produto_id: "pz", nome: "Pizza Mussarela", quantidade: 1, preco_unitario: 999, ...over,
});

describe("ai / validarPrecosComCatalogo", { skip: !TEM_DB && "defina DATABASE_URL (banco descartável)" }, () => {
  let empresa;
  before(prepararBanco);
  beforeEach(async () => {
    await limparBanco();
    empresa = await criarEmpresaCrua();
    await salvarProduto(empresa, {
      id: "pz", nome: "Pizza Mussarela", categoria: "comida",
      tamanhos: [{ nome: "P", preco: 20 }, { nome: "M", preco: 25 }, { nome: "G", preco: 30 }],
    });
    await salvarProduto(empresa, { id: "coca", nome: "Coca", categoria: "bebida", preco: 7, temMeiaPorcao: false });
  });
  after(fecharBanco);

  test("tamanho escolhido certo: usa o preço daquele tamanho, mantém confirmado", async () => {
    const pedido = {
      status_pedido: "confirmado",
      itens: [itemPizza({ tamanho: "G" })],
      resposta_cliente: "Fechado!",
      precisa_humano: false,
    };
    await validarPrecosComCatalogo(empresa, pedido);
    assert.equal(pedido.itens[0].preco_unitario, 30);
    assert.equal(pedido.itens[0].tamanho, "G");
    assert.equal(pedido.status_pedido, "confirmado");
  });

  test("tamanho com espaço/maiúscula diferente ainda casa com o catálogo", async () => {
    const pedido = { status_pedido: "confirmado", itens: [itemPizza({ tamanho: "  g  " })], precisa_humano: false };
    await validarPrecosComCatalogo(empresa, pedido);
    assert.equal(pedido.itens[0].preco_unitario, 30);
    assert.equal(pedido.itens[0].tamanho, "G"); // grafia do catálogo, não a que veio
  });

  test("tamanho inválido ao confirmar: barra a confirmação e pergunta de novo", async () => {
    const pedido = {
      status_pedido: "confirmado",
      itens: [itemPizza({ tamanho: "Extra Grande" })], // não existe
      resposta_cliente: "Fechado!",
      precisa_humano: false,
    };
    await validarPrecosComCatalogo(empresa, pedido);
    assert.equal(pedido.status_pedido, "aguardando_confirmacao");
    assert.match(pedido.resposta_cliente, /tamanho/i);
    assert.match(pedido.resposta_cliente, /P, M, G/);
    assert.equal(pedido.precisa_humano, false);
  });

  test("tamanho vazio (cliente ainda não escolheu) ao confirmar: mesma trava", async () => {
    const pedido = { status_pedido: "confirmado", itens: [itemPizza({ tamanho: "" })], precisa_humano: false };
    await validarPrecosComCatalogo(empresa, pedido);
    assert.equal(pedido.status_pedido, "aguardando_confirmacao");
  });

  test("tamanho ainda não escolhido durante a coleta: NÃO força mudança de status (conversa ainda rolando)", async () => {
    const pedido = { status_pedido: "coletando", itens: [itemPizza({ tamanho: "" })], precisa_humano: false };
    await validarPrecosComCatalogo(empresa, pedido);
    assert.equal(pedido.status_pedido, "coletando"); // continua como a IA definiu
    assert.equal(pedido.itens[0].preco_unitario, 0); // mas o preço nunca fica "inventado"
  });

  test("produto SEM tamanhos continua funcionando como antes (regressão)", async () => {
    const pedido = {
      status_pedido: "confirmado",
      itens: [{ produto_id: "coca", nome: "Coca", quantidade: 2, preco_unitario: 999 }],
      precisa_humano: false,
    };
    await validarPrecosComCatalogo(empresa, pedido);
    assert.equal(pedido.itens[0].preco_unitario, 7);
    assert.equal(pedido.status_pedido, "confirmado"); // não mexe em produto sem tamanhos
  });
});

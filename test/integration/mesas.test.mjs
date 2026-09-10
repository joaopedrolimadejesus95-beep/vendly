import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { TEM_DB, prepararBanco, limparBanco, fecharBanco, criarEmpresaCrua } from "../helpers/db.mjs";
import { salvarProduto, getEstoque } from "../../src/catalog.js";
import {
  criarMesa, criarMesasEmLote, listarMesas, removerMesa,
  adicionarItemMesa, editarItemMesa, removerItemMesa,
  lancarPedidoMesa, fecharMesa, reabrirMesaDoPedido, listarLancamentosPendentes,
} from "../../src/mesas.js";
import { listarPedidos } from "../../src/orders.js";
import { salvarEmpresa } from "../../src/catalog.js";

const item = (over = {}) => ({
  produto_id: "xb", nome: "X-Bacon", quantidade: 1, preco_unitario: 20, adicionais: [], ...over,
});

describe("mesas", { skip: !TEM_DB && "defina DATABASE_URL (banco descartável)" }, () => {
  let empresa;
  before(prepararBanco);
  beforeEach(async () => {
    await limparBanco();
    empresa = await criarEmpresaCrua({ taxaServicoPercent: 0 });
    await salvarProduto(empresa, { id: "xb", nome: "X-Bacon", preco: 20, categoria: "comida", estoqueInicial: 10 });
    await salvarProduto(empresa, { id: "coca", nome: "Coca", preco: 10, categoria: "bebida", estoqueInicial: 50 });
  });
  after(fecharBanco);

  test("criarMesa e criarMesasEmLote (sem duplicar as que já existem)", async () => {
    await criarMesa(empresa, "1");
    const criadas = await criarMesasEmLote(empresa, 1, 5); // a "1" já existe
    assert.equal(criadas, 4);
    assert.equal((await listarMesas(empresa)).length, 5);
  });

  test("adicionarItemMesa recusa quando passa do estoque disponível", async () => {
    const m = await criarMesa(empresa, "1");
    await assert.rejects(
      () => adicionarItemMesa(empresa, m.id, item({ quantidade: 11 })),
      /[Ee]stoque|dispon/
    );
  });

  test("adicionarItemMesa guarda a pessoa e marca item como não-lançado", async () => {
    const m = await criarMesa(empresa, "1");
    const mesa = await adicionarItemMesa(empresa, m.id, item({ pessoa: "  Lugar 1  ", quantidade: 2 }));
    assert.equal(mesa.itensAtuais[0].pessoa, "Lugar 1");
    assert.equal(mesa.itensAtuais[0].lancado, false);
    assert.equal(mesa.status, "ocupada");
  });

  test("editarItemMesa muda quantidade/observação/pessoa", async () => {
    const m = await criarMesa(empresa, "1");
    await adicionarItemMesa(empresa, m.id, item());
    const mesa = await editarItemMesa(empresa, m.id, 0, { quantidade: 3, observacao: "sem cebola", pessoa: "Lugar 2" });
    assert.equal(mesa.itensAtuais[0].quantidade, 3);
    assert.equal(mesa.itensAtuais[0].observacao, "sem cebola");
    assert.equal(mesa.itensAtuais[0].pessoa, "Lugar 2");
    assert.equal(mesa.total, 60);
  });

  test("editarItemMesa recusa aumento acima do estoque", async () => {
    const m = await criarMesa(empresa, "1");
    await adicionarItemMesa(empresa, m.id, item({ quantidade: 2 }));
    await assert.rejects(() => editarItemMesa(empresa, m.id, 0, { quantidade: 99 }), /[Ee]stoque/);
  });

  test("editarItemMesa recusa item já lançado pra cozinha", async () => {
    const m = await criarMesa(empresa, "1");
    await adicionarItemMesa(empresa, m.id, item());
    await lancarPedidoMesa(empresa, m.id, null);
    await assert.rejects(() => editarItemMesa(empresa, m.id, 0, { quantidade: 2 }), /cozinha/i);
  });

  test("removerItemMesa: tirar o último item volta a mesa pra 'livre'", async () => {
    const m = await criarMesa(empresa, "1");
    await adicionarItemMesa(empresa, m.id, item());
    const mesa = await removerItemMesa(empresa, m.id, 0);
    assert.equal(mesa.status, "livre");
    assert.equal(mesa.itensAtuais.length, 0);
  });

  test("removerMesa recusa mesa com conta aberta", async () => {
    const m = await criarMesa(empresa, "1");
    await adicionarItemMesa(empresa, m.id, item());
    await assert.rejects(() => removerMesa(empresa, m.id), /conta aberta/i);
  });

  test("lancarPedidoMesa manda só os itens novos pra fila da cozinha", async () => {
    const m = await criarMesa(empresa, "1");
    await adicionarItemMesa(empresa, m.id, item());
    const r1 = await lancarPedidoMesa(empresa, m.id, "Pedro");
    assert.equal(r1.itensLancados, 1);
    await adicionarItemMesa(empresa, m.id, item({ produto_id: "coca", nome: "Coca", preco_unitario: 10 }));
    const r2 = await lancarPedidoMesa(empresa, m.id, "Pedro");
    assert.equal(r2.itensLancados, 1); // só o novo
    const pend = await listarLancamentosPendentes(empresa);
    assert.equal(pend.length, 2);
  });

  test("fecharMesa: subtotal, taxa de serviço, desconto e total", async () => {
    await salvarEmpresa(empresa, { taxaServicoPercent: 10 });
    const m = await criarMesa(empresa, "1");
    await adicionarItemMesa(empresa, m.id, item({ quantidade: 5 })); // 5 x 20 = 100
    const pedido = await fecharMesa(empresa, m.id, {
      formaPagamento: "pix", aplicarTaxa: true, desconto: 5, descontoMotivo: "cortesia",
    });
    assert.equal(pedido.subtotal, 100);
    assert.equal(pedido.taxaServico, 10);
    assert.equal(pedido.desconto, 5);
    assert.equal(pedido.descontoMotivo, "cortesia");
    assert.equal(pedido.total, 105);
    assert.equal(pedido.origem, "mesa");
    // baixou o estoque
    assert.equal((await getEstoque(empresa)).xb, 5);
    // mesa liberada
    assert.equal((await listarMesas(empresa)).find((x) => x.numero === "1").status, "livre");
  });

  test("fecharMesa: aplicarTaxa=false zera a taxa; desconto trava no total", async () => {
    await salvarEmpresa(empresa, { taxaServicoPercent: 10 });
    const m = await criarMesa(empresa, "1");
    await adicionarItemMesa(empresa, m.id, item({ quantidade: 2 })); // 40
    const pedido = await fecharMesa(empresa, m.id, { formaPagamento: "pix", aplicarTaxa: false, desconto: 999 });
    assert.equal(pedido.taxaServico, 0);
    assert.equal(pedido.desconto, 40); // travado no subtotal
    assert.equal(pedido.total, 0);
  });

  test("fecharMesa: item não lançado ainda vira lançamento (rede de segurança)", async () => {
    const m = await criarMesa(empresa, "1");
    await adicionarItemMesa(empresa, m.id, item()); // nunca passou por lancarPedidoMesa
    await fecharMesa(empresa, m.id, { formaPagamento: "pix" });
    assert.equal((await listarLancamentosPendentes(empresa)).length, 1);
  });

  test("reabrirMesaDoPedido: devolve itens, estorna estoque e apaga o pedido", async () => {
    const m = await criarMesa(empresa, "1");
    await adicionarItemMesa(empresa, m.id, item({ quantidade: 4, pessoa: "Lugar 1" }));
    const pedido = await fecharMesa(empresa, m.id, { formaPagamento: "pix" });
    assert.equal((await getEstoque(empresa)).xb, 6);

    const r = await reabrirMesaDoPedido(empresa, pedido.id);
    assert.equal(r.mesa.status, "ocupada");
    assert.equal(r.mesa.itensAtuais[0].quantidade, 4);
    assert.equal(r.mesa.itensAtuais[0].pessoa, "Lugar 1");
    assert.equal(r.mesa.itensAtuais[0].lancado, true); // já foi preparado
    assert.equal((await getEstoque(empresa)).xb, 10); // estornado
    assert.equal((await listarPedidos(empresa)).length, 0); // pedido sumiu
  });

  test("reabrirMesaDoPedido recusa se a mesa já tem outra conta aberta", async () => {
    const m = await criarMesa(empresa, "1");
    await adicionarItemMesa(empresa, m.id, item());
    const pedido = await fecharMesa(empresa, m.id, { formaPagamento: "pix" });
    // abre a mesma mesa de novo
    await adicionarItemMesa(empresa, m.id, item({ produto_id: "coca", nome: "Coca", preco_unitario: 10 }));
    await assert.rejects(() => reabrirMesaDoPedido(empresa, pedido.id), /outra conta aberta/i);
  });

  test("reabrirMesaDoPedido recusa um pedido que não é de mesa", async () => {
    await assert.rejects(() => reabrirMesaDoPedido(empresa, 999999), /não encontrado/i);
  });
});

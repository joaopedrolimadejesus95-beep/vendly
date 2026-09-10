// Camadas de proteção da IA — funções puras (sem banco, sem chamada de API).
// São o que impede a IA de cobrar errado; se algo aqui quebrar, é grave.
import { test } from "node:test";
import assert from "node:assert/strict";

// ai.js instancia o SDK da Anthropic no load — precisa de uma chave qualquer.
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-dummy";
const { recalcularTotal, corrigirTotalNoTexto, corrigirQuebrasDeLinha, verificarFuncionamento } =
  await import("../../src/ai.js");

test("recalcularTotal: soma preço base × quantidade", () => {
  const p = { itens: [{ preco_unitario: 10, quantidade: 3, adicionais: [] }] };
  recalcularTotal(p);
  assert.equal(p.total, 30);
});

test("recalcularTotal: inclui adicionais na conta", () => {
  const p = { itens: [{ preco_unitario: 20, quantidade: 2, adicionais: [{ preco: 5 }, { preco: 3 }] }] };
  recalcularTotal(p);
  assert.equal(p.total, (20 + 8) * 2); // 56
});

test("recalcularTotal: vários itens + arredonda a 2 casas", () => {
  const p = {
    itens: [
      { preco_unitario: 12.9, quantidade: 1, adicionais: [] },
      { preco_unitario: 7.33, quantidade: 3, adicionais: [] },
    ],
  };
  recalcularTotal(p);
  assert.equal(p.total, 34.89);
});

test("recalcularTotal: ignora o total que a IA mandou, usa o recalculado", () => {
  const p = { total: 999, itens: [{ preco_unitario: 10, quantidade: 1, adicionais: [] }] };
  recalcularTotal(p);
  assert.equal(p.total, 10);
});

test("recalcularTotal: pedido sem itens = 0", () => {
  const p = { itens: [] };
  recalcularTotal(p);
  assert.equal(p.total, 0);
});

test("corrigirTotalNoTexto: substitui 'Total: R$X' pelo valor certo", () => {
  const p = { total: 41.5, resposta_cliente: "Fechou! Total: R$38,00. Confirma?" };
  corrigirTotalNoTexto(p);
  assert.match(p.resposta_cliente, /Total: R\$41,50/);
});

test("corrigirTotalNoTexto: 'Total parcial' vira 'Total parcial', não 'Total'", () => {
  const p = { total: 20, resposta_cliente: "Total parcial: R$15,00" };
  corrigirTotalNoTexto(p);
  assert.equal(p.resposta_cliente, "Total parcial: R$20,00");
});

test("corrigirTotalNoTexto: corrige 'troco de R$X' com base no valor recebido", () => {
  const p = { total: 30, valor_recebido_dinheiro: 50, resposta_cliente: "Seu troco de R$15,00 então." };
  corrigirTotalNoTexto(p);
  assert.match(p.resposta_cliente, /troco de R\$20,00/);
  assert.equal(p.troco, 20);
});

test("corrigirQuebrasDeLinha: troca o literal barra-n por quebra real", () => {
  const p = { resposta_cliente: "linha 1\\nlinha 2" };
  corrigirQuebrasDeLinha(p);
  assert.equal(p.resposta_cliente, "linha 1\nlinha 2");
});

test("verificarFuncionamento: sem dias configurados = sempre aberto", () => {
  assert.deepEqual(verificarFuncionamento({ diasFuncionamento: [] }), { aberto: true });
  assert.deepEqual(verificarFuncionamento({}), { aberto: true });
});

test("verificarFuncionamento: dia da semana fora da lista = fechado", () => {
  // Uma lista que com certeza NÃO contém o dia de hoje (todos os 7 menos o de hoje).
  const todos = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
  const hoje = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long" })
    .format(new Date())
    .replace("-feira", "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const semHoje = todos.filter((d) => d !== hoje);
  const r = verificarFuncionamento({ diasFuncionamento: semHoje });
  assert.equal(r.aberto, false);
  assert.match(r.mensagem, /fechados/i);
});

test("verificarFuncionamento: dentro do dia mas fora do horário = fechado", () => {
  const hoje = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long" })
    .format(new Date())
    .replace("-feira", "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const r = verificarFuncionamento({
    diasFuncionamento: [hoje],
    horarioAbertura: "03:00",
    horarioFechamento: "03:01", // janela de 1 min de madrugada — quase certo estar fora
  });
  // Só afirma que fechou se realmente não são ~3h da manhã em SP agora.
  const horaAgora = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
  if (horaAgora < "03:00" || horaAgora > "03:01") {
    assert.equal(r.aberto, false);
    assert.match(r.mensagem, /fechados/i);
  }
});

test("verificarFuncionamento: dia certo + dentro do horário = aberto", () => {
  const hoje = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long" })
    .format(new Date())
    .replace("-feira", "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const r = verificarFuncionamento({
    diasFuncionamento: [hoje],
    horarioAbertura: "00:00",
    horarioFechamento: "23:59",
  });
  assert.deepEqual(r, { aberto: true });
});

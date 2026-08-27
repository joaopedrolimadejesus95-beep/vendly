import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { comFila } from "./fileLock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAMINHO_PEDIDOS = join(__dirname, "..", "data", "pedidos.json");

function lerPedidos() {
  if (!existsSync(CAMINHO_PEDIDOS)) return [];
  return JSON.parse(readFileSync(CAMINHO_PEDIDOS, "utf-8"));
}

function salvarPedidos(pedidos) {
  writeFileSync(CAMINHO_PEDIDOS, JSON.stringify(pedidos, null, 2), "utf-8");
}

export function registrarPedido({ numeroCliente, itens, total, tipoEntrega, endereco }) {
  return comFila("pedidos.json", () => {
    const pedidos = lerPedidos();
    const novoPedido = {
      id: pedidos.length + 1,
      numeroCliente,
      itens,
      total,
      tipoEntrega: tipoEntrega || null,
      endereco: endereco || null,
      impresso: false,
      dataHora: new Date().toISOString(),
    };
    pedidos.push(novoPedido);
    salvarPedidos(pedidos);
    return novoPedido;
  });
}

export function listarPedidos() {
  // Mais recentes primeiro.
  return lerPedidos().slice().reverse();
}

// Usado pelo agente de impressão local (roda no restaurante) para saber
// quais pedidos ainda não foram impressos.
export function listarPedidosNaoImpressos() {
  return lerPedidos().filter((p) => !p.impresso);
}

export function marcarComoImpresso(id) {
  return comFila("pedidos.json", () => {
    const pedidos = lerPedidos();
    const pedido = pedidos.find((p) => p.id === id);
    if (pedido) {
      pedido.impresso = true;
      salvarPedidos(pedidos);
    }
    return pedido;
  });
}

// Usado quando o dono do restaurante quer cancelar/remover um pedido
// registrado por engano, direto no painel (aba Vendas).
export function removerPedido(id) {
  return comFila("pedidos.json", () => {
    const pedidos = lerPedidos();
    const existeAntes = pedidos.some((p) => p.id === id);
    const restantes = pedidos.filter((p) => p.id !== id);
    salvarPedidos(restantes);
    return existeAntes;
  });
}

export function getEstatisticas() {
  const pedidos = lerPedidos();
  const hoje = new Date().toDateString();

  const pedidosHoje = pedidos.filter((p) => new Date(p.dataHora).toDateString() === hoje);
  const faturamentoHoje = pedidosHoje.reduce((soma, p) => soma + p.total, 0);
  const faturamentoTotal = pedidos.reduce((soma, p) => soma + p.total, 0);
  const ticketMedio = pedidos.length > 0 ? faturamentoTotal / pedidos.length : 0;

  const contagemProdutos = {};
  for (const pedido of pedidos) {
    for (const item of pedido.itens) {
      contagemProdutos[item.nome] = (contagemProdutos[item.nome] || 0) + item.quantidade;
    }
  }
  const maisVendidos = Object.entries(contagemProdutos)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([nome, quantidade]) => ({ nome, quantidade }));

  return {
    totalPedidos: pedidos.length,
    pedidosHoje: pedidosHoje.length,
    faturamentoHoje,
    faturamentoTotal,
    ticketMedio,
    maisVendidos,
  };
}

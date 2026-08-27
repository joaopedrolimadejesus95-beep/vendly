import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { scryptSync, randomBytes, timingSafeEqual } from "crypto";
import { comFila } from "./fileLock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAMINHO_DADOS = join(__dirname, "..", "data", "catalogo.json");

// Em vez de dados fixos no código, o catálogo agora vem de um arquivo
// JSON que a interface de administração (/admin) pode editar. Isso
// permite que o dono do negócio cadastre produtos sem mexer em código.

function lerDados() {
  const conteudo = readFileSync(CAMINHO_DADOS, "utf-8");
  return JSON.parse(conteudo);
}

function salvarDados(dados) {
  writeFileSync(CAMINHO_DADOS, JSON.stringify(dados, null, 2), "utf-8");
}

export function getEmpresa() {
  return lerDados().empresa;
}

export function getCatalogo() {
  // Só retorna produtos marcados como disponíveis para a IA usar.
  return lerDados().catalogo.filter((p) => p.disponivel !== false);
}

export function getCatalogoCompleto() {
  // Todos os produtos, incluindo indisponíveis — usado pela tela de admin.
  return lerDados().catalogo;
}

export function getEstoque() {
  return lerDados().estoque;
}

export function catalogoFormatado() {
  return getCatalogo()
    .map((p) => {
      const linhaBase = `- ${p.nome} (id: ${p.id}) — R$${p.preco.toFixed(2)} — ingredientes: ${p.descricao}`;
      if (!p.adicionais || p.adicionais.length === 0) return linhaBase;
      const adicionais = p.adicionais
        .map((a) => `${a.nome} (id: ${a.id}, +R$${a.preco.toFixed(2)})`)
        .join(", ");
      return `${linhaBase}\n  Adicionais disponíveis para este item: ${adicionais}`;
    })
    .join("\n");
}

export function baixarEstoque(itens = []) {
  // Protegido por fila: se dois pedidos confirmarem quase juntos, a baixa
  // de estoque de um espera a do outro terminar, em vez de os dois lerem
  // o mesmo valor antigo e um "apagar" o desconto do outro.
  return comFila("catalogo.json", () => {
    const dados = lerDados();
    for (const item of itens) {
      if (dados.estoque[item.produto_id] !== undefined) {
        dados.estoque[item.produto_id] -= item.quantidade;
      }
    }
    salvarDados(dados);
  });
}

export function salvarEmpresa(novaEmpresa) {
  return comFila("catalogo.json", () => {
    const dados = lerDados();
    dados.empresa = { ...dados.empresa, ...novaEmpresa };
    salvarDados(dados);
    return dados.empresa;
  });
}

export function salvarProduto(produto) {
  return comFila("catalogo.json", () => {
    const dados = lerDados();
    const indiceExistente = dados.catalogo.findIndex((p) => p.id === produto.id);
    if (indiceExistente >= 0) {
      dados.catalogo[indiceExistente] = produto;
    } else {
      dados.catalogo.push(produto);
      if (dados.estoque[produto.id] === undefined) {
        dados.estoque[produto.id] = produto.estoqueInicial ?? 50;
      }
    }
    salvarDados(dados);
    return dados.catalogo;
  });
}

export function removerProduto(id) {
  return comFila("catalogo.json", () => {
    const dados = lerDados();
    dados.catalogo = dados.catalogo.filter((p) => p.id !== id);
    delete dados.estoque[id];
    salvarDados(dados);
    return dados.catalogo;
  });
}

export function atualizarEstoqueManual(id, quantidade) {
  return comFila("catalogo.json", () => {
    const dados = lerDados();
    dados.estoque[id] = quantidade;
    salvarDados(dados);
    return dados.estoque;
  });
}

// --- Senha do painel, definida pelo próprio estabelecimento ---
// Nunca guardamos a senha em texto puro — só um "hash" (uma versão
// embaralhada e irreversível dela), junto com um "salt" aleatório
// que torna esse hash único mesmo se duas pessoas usarem a mesma senha.

function gerarHash(senha, salt) {
  return scryptSync(senha, salt, 64).toString("hex");
}

export function temSenhaDefinida() {
  const dados = lerDados();
  return Boolean(dados.auth?.hash);
}

export function verificarSenha(senhaTentativa) {
  const dados = lerDados();
  if (!dados.auth?.hash) return false;
  const hashTentativa = gerarHash(senhaTentativa, dados.auth.salt);
  const bufferSalvo = Buffer.from(dados.auth.hash, "hex");
  const bufferTentativa = Buffer.from(hashTentativa, "hex");
  if (bufferSalvo.length !== bufferTentativa.length) return false;
  return timingSafeEqual(bufferSalvo, bufferTentativa);
}

export function definirSenha(novaSenha) {
  const dados = lerDados();
  const salt = randomBytes(16).toString("hex");
  dados.auth = { salt, hash: gerarHash(novaSenha, salt) };
  salvarDados(dados);
}

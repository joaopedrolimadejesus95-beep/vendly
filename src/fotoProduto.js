// Processa, redimensiona e salva a foto de um produto no disco da VPS.
// Fotos ficam em public/fotos-produtos/<empresaId>/ — fora do git
// (.gitignore), servidas automaticamente pelo express.static que já
// serve a pasta public/ inteira (nenhuma rota nova de leitura precisa
// existir, só de escrita/remoção, em server.js).
//
// IMPORTANTE: o nome do arquivo é sempre gerado aqui, nunca o nome que
// veio do upload — evita path traversal e nomes estranhos.

import sharp from "sharp";
import { mkdir, unlink } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { atualizarFotoPathProduto } from "./catalog.js";

const RAIZ_PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const LARGURA_MAXIMA_PX = 1000;

/**
 * @param {number} empresaId
 * @param {string} produtoId
 * @param {Buffer} bufferImagem - bytes crus do upload (JPG ou PNG)
 * @returns {Promise<string>} o novo foto_path salvo (ex: /fotos-produtos/12/xb-ab12.jpg)
 */
export async function salvarFotoProduto(empresaId, produtoId, bufferImagem) {
  const nomeArquivo = `${produtoId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.jpg`;
  const pastaEmpresa = join(RAIZ_PUBLIC, "fotos-produtos", String(empresaId));
  const caminhoDisco = join(pastaEmpresa, nomeArquivo);
  const fotoPathNovo = `/fotos-produtos/${empresaId}/${nomeArquivo}`;

  await mkdir(pastaEmpresa, { recursive: true });
  // sharp decodifica a imagem de verdade — se o arquivo não for uma
  // imagem válida (mesmo com mimetype de JPG/PNG no upload), lança erro
  // aqui, pegando quem só mentiu o tipo do arquivo.
  await sharp(bufferImagem)
    .resize(LARGURA_MAXIMA_PX, null, { withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toFile(caminhoDisco);

  try {
    const fotoPathAntigo = await atualizarFotoPathProduto(empresaId, produtoId, fotoPathNovo);
    await apagarArquivoFoto(fotoPathAntigo);
  } catch (erro) {
    // Produto não existe (ou não é dessa empresa) — não deixa o arquivo
    // que acabou de ser escrito órfão no disco, sem produto nenhum
    // apontando pra ele.
    await apagarArquivoFoto(fotoPathNovo);
    throw erro;
  }

  return fotoPathNovo;
}

export async function removerFotoProduto(empresaId, produtoId) {
  const fotoPathAntigo = await atualizarFotoPathProduto(empresaId, produtoId, null);
  await apagarArquivoFoto(fotoPathAntigo);
}

// Usado também quando o produto INTEIRO é removido (não só a foto) —
// server.js chama isso com o foto_path que removerProduto() devolveu.
export async function apagarArquivoFoto(fotoPath) {
  if (!fotoPath) return;
  // Nunca derruba a operação por causa disso — só tenta, ignora se o
  // arquivo já não existir por algum motivo.
  await unlink(join(RAIZ_PUBLIC, fotoPath)).catch(() => {});
}

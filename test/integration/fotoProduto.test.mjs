// fotoProduto.js processa a imagem de verdade (sharp) e escreve/apaga
// arquivo de verdade no disco — dá pra testar sem custo nenhum de API
// (diferente da transcrição de áudio ou da leitura de cardápio por foto,
// que chamam a IA de verdade). Os arquivos de teste são apagados no final.
import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TEM_DB, prepararBanco, limparBanco, fecharBanco, criarEmpresaCrua } from "../helpers/db.mjs";
import { salvarProduto, getCatalogoCompleto } from "../../src/catalog.js";
import { salvarFotoProduto, removerFotoProduto } from "../../src/fotoProduto.js";

// PNG 1x1 válido (base64) — pequeno o bastante pra não pesar o teste, mas
// uma imagem de verdade que o sharp consegue decodificar.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const TEXTO_FALSO = Buffer.from("isso aqui não é uma imagem, é só texto");

const RAIZ_PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const pastaFotosDaEmpresa = (empresaId) => join(RAIZ_PUBLIC, "fotos-produtos", String(empresaId));

describe("fotoProduto", { skip: !TEM_DB && "defina DATABASE_URL (banco descartável)" }, () => {
  let empresa;
  before(prepararBanco);
  beforeEach(async () => {
    await limparBanco();
    empresa = await criarEmpresaCrua();
    await salvarProduto(empresa, { id: "xb", nome: "X-Bacon", preco: 20, categoria: "comida" });
  });
  after(async () => {
    // Limpa qualquer pasta de teste que tenha sobrado, pra não deixar lixo
    // na pasta public/ de verdade do repositório.
    await rm(join(RAIZ_PUBLIC, "fotos-produtos"), { recursive: true, force: true });
    await fecharBanco();
  });

  test("salvarFotoProduto: escreve o arquivo no disco e salva o caminho no produto", async () => {
    const fotoPath = await salvarFotoProduto(empresa, "xb", PNG_1X1);
    assert.match(fotoPath, new RegExp(`^/fotos-produtos/${empresa}/xb-.+\\.jpg$`));
    assert.ok(existsSync(join(RAIZ_PUBLIC, fotoPath)), "o arquivo deveria existir no disco");

    const produto = (await getCatalogoCompleto(empresa))[0];
    assert.equal(produto.foto, fotoPath);
  });

  test("trocar a foto apaga o arquivo antigo do disco", async () => {
    const fotoPath1 = await salvarFotoProduto(empresa, "xb", PNG_1X1);
    const caminhoDisco1 = join(RAIZ_PUBLIC, fotoPath1);
    assert.ok(existsSync(caminhoDisco1));

    const fotoPath2 = await salvarFotoProduto(empresa, "xb", PNG_1X1);
    assert.notEqual(fotoPath1, fotoPath2); // nome gerado é diferente a cada envio
    assert.ok(!existsSync(caminhoDisco1), "o arquivo antigo deveria ter sido apagado");
    assert.ok(existsSync(join(RAIZ_PUBLIC, fotoPath2)));
  });

  test("removerFotoProduto: apaga o arquivo e limpa o campo no banco", async () => {
    const fotoPath = await salvarFotoProduto(empresa, "xb", PNG_1X1);
    await removerFotoProduto(empresa, "xb");
    assert.ok(!existsSync(join(RAIZ_PUBLIC, fotoPath)));
    assert.equal((await getCatalogoCompleto(empresa))[0].foto, null);
  });

  test("arquivo que não é imagem de verdade é recusado (mesmo com mimetype mentindo)", async () => {
    await assert.rejects(() => salvarFotoProduto(empresa, "xb", TEXTO_FALSO));
    // nada deve ter sido escrito nem salvo
    assert.equal((await getCatalogoCompleto(empresa))[0].foto, null);
  });

  test("produto de outra empresa: recusa e não deixa arquivo órfão no disco", async () => {
    const outra = await criarEmpresaCrua({ login: "outra-fotoproduto", evolutionInstance: "inst-outra-fotoproduto" });
    await assert.rejects(() => salvarFotoProduto(outra, "xb", PNG_1X1), /não encontrado/i);

    // A pasta pode ter sido criada (mkdir roda antes do produto ser
    // conferido), mas não pode ter sobrado nenhum arquivo órfão dentro.
    const pasta = pastaFotosDaEmpresa(outra);
    if (existsSync(pasta)) {
      assert.deepEqual(await readdir(pasta), []);
    }
  });
});

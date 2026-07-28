# Instalação

## Requisitos

- Node.js 20 ou superior, conforme `engines` do pacote.
- Uma plataforma suportada pelo binário opcional do `sharp` instalado pelo gerenciador de pacotes.
- Memória compatível com o perfil e o limite de pixels de saída escolhidos.

O CI atual executa verificação em Node.js 20, 22 e 24 sobre Ubuntu. A versão instalada de `sharp` declara Node.js `>=20.9.0`; na linha 20, use uma versão de patch atual em vez de uma versão inicial do Node 20.

O projeto não lê `.env` nem `process.env`, não exige banco de dados, serviço externo, OpenCV do sistema ou porta de rede. O OpenCV usado pelo scanner vem de `@opencvjs/node`; o processamento raster usa `sharp`/libvips.

## Como dependência

```bash
npm install cerne-scanner
```

ESM:

```js
import { scanDocument } from "cerne-scanner";
```

CommonJS:

```js
const { scanDocument } = require("cerne-scanner");
```

O manifesto direciona cada forma para seu artefato correspondente:

| Consumidor       | JavaScript       | Tipos              |
| ---------------- | ---------------- | ------------------ |
| ESM/import       | `dist/index.js`  | `dist/index.d.ts`  |
| CommonJS/require | `dist/index.cjs` | `dist/index.d.cts` |

O pacote é marcado com `sideEffects: false`. A importação, por si só, não inicializa o OpenCV; ele é carregado na primeira detecção/transformação ou por `warmupScanner()`.

## CLI global

```bash
npm install --global cerne-scanner
cerne-scanner --help --pretty
```

O binário publicado aponta para `dist/cli.js`. A ajuda é um descritor JSON e não texto livre. Veja [CLI.md](CLI.md).

## Checkout de desenvolvimento

O repositório mantém `package-lock.json`; a instalação reproduzível prevista pelo CI é:

```bash
npm ci
```

Scripts declarados em `package.json`:

| Script                   | Função                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| `npm run build`          | Gera biblioteca ESM/CommonJS, tipos, source maps e CLI com `tsup`. |
| `npm run typecheck`      | Executa TypeScript sem emitir arquivos.                            |
| `npm run lint`           | Executa ESLint.                                                    |
| `npm run format`         | Reescreve arquivos com Prettier.                                   |
| `npm run format:check`   | Confere formatação sem reescrever.                                 |
| `npm run check`          | Typecheck, lint, formatação e build.                               |
| `npm run bench:fixtures` | Gera as imagens sintéticas locais do benchmark.                    |
| `npm run bench`          | Mede casos do benchmark com GC exposto.                            |
| `npm run security:audit` | Executa auditoria de dependências com severidade mínima `low`.     |
| `npm run prepack`        | Executa `check` antes de empacotar.                                |
| `npm run prepare`        | Reaplica o patch local do Prettier via `patch-package`.            |

Não há script de servidor ou watcher no manifesto atual. O CI verifica tipos, lint, formatação e build; o benchmark sintético é a verificação de regressão de resultado e desempenho disponível no repositório, mas não aparece no workflow de CI atual.

### Patch do Prettier

`patches/prettier+3.9.4.patch` modifica o formatador usado no desenvolvimento. Por isso:

- a versão do Prettier está fixada em `3.9.4`;
- `prepare` usa `patch-package` depois da instalação;
- atualizar Prettier exige regenerar e revisar esse patch;
- o patch não altera a execução do scanner nem integra o conteúdo publicado em `dist`.

As instruções completas de manutenção estão no cabeçalho do próprio arquivo de patch. Não edite os arquivos minificados dentro de `node_modules` como solução permanente.

## Artefatos de build e publicação

O build esperado gera:

```text
dist/
  index.js
  index.cjs
  index.d.ts
  index.d.cts
  index.js.map
  index.cjs.map
  cli.js
  cli.js.map
```

`dist` é ignorado pelo Git deste repositório, mas é incluído no pacote publicado. A lista `files` do manifesto inclui:

- `dist`;
- `README.md`;
- `LICENSE`.

Os guias em `docs/` e os arquivos de benchmark permanecem no repositório, mas não são incluídos no pacote npm.

Compile a partir de `src`; não mantenha correções paralelas diretamente nos artefatos gerados.

## CI

`.github/workflows/ci.yml` possui dois jobs:

1. `verify`, em Node.js 20, 22 e 24: instalação limpa, typecheck, lint, formatação e build;
2. `security`, em Node.js 22: instalação limpa e auditoria de dependências.

O workflow usa permissões `contents: read` e é acionado em `push` e `pull_request`.

## Verificação após instalação

Uma verificação rápida útil é aquecer o runtime antes de ler dados de produção:

```js
import { warmupScanner } from "cerne-scanner";

await warmupScanner();
console.log("OpenCV carregado");
```

`warmupScanner()` pode rejeitar a Promise quando o runtime não carrega, o que facilita detectar uma instalação incompleta no startup. Para validar o pipeline completo, use uma imagem controlada e confira `status`, `error`, `metadata.inputFormat` e `output.mimeType`.

## Problemas de plataforma

Se a importação ou codificação falhar:

1. confirme a versão exata de Node.js;
2. confirme que dependências opcionais não foram omitidas na instalação, pois `sharp` seleciona um pacote por plataforma;
3. reinstale as dependências com o lockfile correto para o sistema de destino;
4. execute `warmupScanner()` separadamente para distinguir inicialização do OpenCV de leitura/codificação;
5. confira `error.code` e `metadata` em uma imagem controlada para distinguir falha de entrada, inicialização, detecção ou codificação.

Em contêineres, faça a instalação no mesmo sistema/arquitetura da imagem final ou em estágio compatível. Não copie um `node_modules` produzido para outro sistema operacional ou arquitetura.

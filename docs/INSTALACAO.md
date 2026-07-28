# Instalação

## Requisitos

| Item              | Exigência                                                       |
| ----------------- | --------------------------------------------------------------- |
| Node.js           | 20.9 ou superior; a CI cobre as linhas 20, 22 e 24              |
| Sistema           | Binário do `sharp` ou instalação global compatível do `libvips` |
| OpenCV do sistema | Não precisa estar instalado; o pacote usa OpenCV.js             |
| GPU               | Não é usada                                                     |
| Credenciais       | Nenhuma chave de API é exigida pelo pacote                      |
| Rede em execução  | Usada apenas se a entrada for uma URL HTTP/HTTPS                |

O processamento é local. `@opencvjs/node` inicializa o runtime OpenCV.js
empacotado, e `sharp` fornece a leitura e a codificação de imagens. Não existe
download de modelo, uso de CDN ou chamada a serviço de processamento.

## Instalação como dependência

```bash
npm install cerne-scanner
```

O pacote publica ESM e CommonJS com declarações de tipos para ambos:

```ts
import { scanDocument } from "cerne-scanner";
```

```js
const { scanDocument } = require("cerne-scanner");
```

O `package.json` declara `"sideEffects": false`, então bundlers podem eliminar
código não utilizado. O pacote atualmente declara `engines.node` como `>=20`,
mas a versão de `sharp` resolvida no lockfile exige `>=20.9.0`; esse é o mínimo
efetivo da árvore atual. A API depende de recursos do Node.js e é destinada a
processos Node, não diretamente ao navegador.

## Instalação da CLI

O pacote registra o binário `cerne-scanner`. Depois de instalar como dependência
do projeto:

```bash
npx cerne-scanner ./foto.jpg --output ./scan.png --pretty
```

Para uso global:

```bash
npm install --global cerne-scanner
```

A CLI só grava uma saída binária quando `--output` é informado. Também é
possível devolver Base64 ou Data URL no JSON. Detalhes em [CLI.md](CLI.md).

## Dependências instaladas

| Pacote           | Papel                                                           |
| ---------------- | --------------------------------------------------------------- |
| `@opencvjs/node` | Detecção geométrica, refinamento e correção de perspectiva      |
| `sharp`          | Metadados, orientação EXIF, decodificação, realce e codificação |
| `pdf-lib`        | Criação da saída PDF de uma página a partir do raster           |

`sharp` distribui binários e o `libvips` para as plataformas suportadas. Em um
sistema sem artefato compatível, a instalação pode exigir ambiente de
compilação ou falhar; o Cerne Scanner não oferece um decodificador alternativo.

Os binários pré-compilados comuns cobrem JPEG, PNG, WebP, TIFF e AVIF, mas HEIC
baseado em HEVC exige um `libvips` global compilado com `libheif`, `libde265` e
os codecs correspondentes. Sem esse suporte, a assinatura HEIF é reconhecida,
mas a inspeção retorna `INVALID_IMAGE`. Consulte a
[documentação de HEIF do `sharp`](https://sharp.pixelplumbing.com/api-output/#heif).

O OpenCV.js é carregado de forma assíncrona na primeira detecção automática ou
correção de perspectiva e reutilizado dentro do processo. Uma chamada de
`detectDocument` com `manualCorners` apenas valida a imagem e os pontos. Para
retirar a latência do primeiro trabalho visual, chame `warmupScanner()` durante
a inicialização da aplicação.

## Desenvolvimento local

```bash
git clone <repositorio>
cd "Cerne Scanner"
npm install
npm run build
```

O `postinstall` executa `patch-package`, que aplica
`patches/prettier+3.9.4.patch`. Instalações com `--ignore-scripts` pulam essa
etapa e o `npm run format:check` pode divergir do resultado esperado.

### Scripts disponíveis

| Script                   | O que faz                                                      |
| ------------------------ | -------------------------------------------------------------- |
| `npm run build`          | Gera ESM, CJS, `.d.ts`, sourcemaps e a CLI em `dist/` via tsup |
| `npm run typecheck`      | `tsc --noEmit`                                                 |
| `npm run lint`           | ESLint com `typescript-eslint`                                 |
| `npm run format`         | Aplica o Prettier                                              |
| `npm run format:check`   | Verifica a formatação sem escrever                             |
| `npm test`               | `node --test`                                                  |
| `npm run bench:fixtures` | Regenera as fixtures sintéticas em `bench/fixtures/`           |
| `npm run bench`          | Executa os casos e mede o tempo; flags habilitam a comparação  |
| `npm run security:audit` | `npm audit --audit-level=low`                                  |
| `npm run check`          | typecheck + lint + format:check + build + test, na ordem       |

### Verificação de uma alteração

O repositório não versiona arquivos de teste: `npm test` hoje executa zero
testes e termina com sucesso de forma vacuosa. A verificação funcional vem do
benchmark, cujas fixtures são sintéticas e determinísticas:

```bash
npm run bench:fixtures
npm run build && node bench/run.mjs --repeats 3 --save antes
```

Depois de alterar `src/`:

```bash
npm run build && node bench/run.mjs --repeats 3 --compare antes
```

A comparação ignora os cinco campos de duração e confronta detecção, confiança,
saída, avisos, erro, metadados e o SHA-256 de `data`, seja binário ou a
representação textual solicitada. Para PDF, cujo arquivo carrega data de
criação, o digest e `byteLength` são ignorados; as dimensões e o papel declarados
no resultado, além do restante do contrato, continuam sendo comparados. O
benchmark não reabre o PDF para validar seu conteúdo. Uma divergência em um caso
presente nas duas execuções faz o processo sair com código `1`. Consulte
[`bench/README.md`](../bench/README.md).

### Integração contínua

`.github/workflows/ci.yml` roda `typecheck`, `lint`, `format:check`, `build` e
`test` na matriz Node 20/22/24. O `security:audit` roda em um job separado.

## Desinstalação

```bash
npm uninstall cerne-scanner
```

A biblioteca não cria cache nem persiste imagens por conta própria. Arquivos
gravados explicitamente pela CLI com `--output` pertencem à aplicação e não são
removidos na desinstalação.

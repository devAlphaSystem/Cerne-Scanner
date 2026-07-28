# Referência da API

## Importação

ESM:

```js
import { detectDocument, releaseScannerResources, scanDocument, warmupScanner } from "cerne-scanner";
```

CommonJS:

```js
const { detectDocument, releaseScannerResources, scanDocument, warmupScanner } = require("cerne-scanner");
```

O pacote fornece declarações TypeScript separadas para ESM e CommonJS. A superfície pública é definida em [`src/index.ts`](../src/index.ts); helpers internos não fazem parte do contrato publicado.

## Entradas

`ScanInput` aceita:

| Tipo                                 | Tratamento                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `string` com `http://` ou `https://` | Download GET com redirects manuais, limite de tamanho e cancelamento.            |
| Outra `string`                       | Caminho de arquivo local.                                                        |
| `ArrayBuffer`                        | Copiado para memória própria antes do processamento.                             |
| `Uint8Array`                         | Copiado para memória própria. `Buffer` funciona por ser subtipo de `Uint8Array`. |

Strings vazias e esquemas remotos diferentes de HTTP(S) são rejeitados. URLs não podem conter usuário/senha; autenticação remota deve usar `requestHeaders`.

O formato é detectado pelos bytes, não pela extensão:

```ts
type InputImageFormat = "jpeg" | "png" | "webp" | "tiff" | "avif" | "heif";
```

Somente uma imagem estática é processada. Animações e contêineres multipágina são devolvidos como `UNSUPPORTED_FORMAT`.

## `scanDocument`

```ts
function scanDocument<TEncoding extends OutputEncoding = "buffer">(input: ScanInput, options?: ScanOptions<TEncoding>): Promise<ScanResult<TEncoding>>;
```

Executa carregamento, inspeção, detecção (ou cantos manuais), padding, cálculo de dimensões, correção de perspectiva, realce e codificação.

```js
const result = await scanDocument("./foto.jpg", {
  output: { format: "jpeg", encoding: "base64", quality: 88 },
  enhancement: "grayscale",
  paperSize: "auto",
});

if (result.success && result.data !== null) {
  console.log(result.status, result.output?.mimeType, result.data.length);
}
```

Falhas esperadas de validação, I/O, limite, cancelamento e processamento são convertidas em `ScanResult` com `status: "error"`; o chamador não precisa capturá-las para obter o código estável. Erros externos ao contrato normal de execução, como falha do próprio runtime ao escrever/logar o resultado do chamador, continuam sendo responsabilidade da aplicação.

## `detectDocument`

```ts
function detectDocument(input: ScanInput, options?: DetectOptions): Promise<DetectionResult>;
```

`DetectOptions` omite `output`, `enhancement`, `paperSize` e `maxOutputPixels`. A função devolve cantos e evidências sem produzir raster corrigido.

```js
const result = await detectDocument(bytes, {
  performance: "accurate",
  minConfidence: 0.65,
  allowFrameFallback: false,
});

if (result.detection !== null) {
  console.log(result.detection.method, result.detection.areaRatio);
}
```

Com `manualCorners`, a função valida os pontos e não decodifica um raster de detecção automática. Ela ainda lê bytes e metadados para validar formato, orientação e dimensões.

## Opções

### Padrões por perfil

| Perfil     | `detectionMaxDimension` | `maxInputPixels` | `maxOutputPixels` | `timeoutMs` |
| ---------- | ----------------------: | ---------------: | ----------------: | ----------: |
| `fast`     |                     960 |       60.000.000 |         4.000.000 |      20.000 |
| `balanced` |                   1.440 |      100.000.000 |         8.000.000 |      60.000 |
| `accurate` |                   2.048 |      160.000.000 |        16.000.000 |     120.000 |

O perfil padrão é `balanced`. Valores explícitos das quatro opções substituem o padrão do perfil, desde que estejam na faixa aceita.

`fast` usa menos mapas e candidatos; `balanced` amplia a análise e refina o candidato; `accurate` adiciona limiar adaptativo, mais simplificações de contorno e interpolação cúbica no warp. A busca por linhas é sempre executada em `accurate`; em `fast` e `balanced`, ela ocorre quando o melhor contorno pontua abaixo de 0,72 ou não existe.

### Tabela completa

| Opção                   | Padrão     | Validação e efeito                                                                                                      |
| ----------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `performance`           | `balanced` | `fast`, `balanced` ou `accurate`.                                                                                       |
| `output.format`         | `png`      | `png`, `jpeg`, `webp` ou `pdf`.                                                                                         |
| `output.encoding`       | `buffer`   | `buffer`, `base64` ou `data-url`.                                                                                       |
| `output.quality`        | `92`       | Inteiro de 1 a 100; afeta JPEG, WebP e raster JPEG do PDF.                                                              |
| `enhancement`           | `color`    | `none`, `color`, `grayscale` ou `black-white`. Somente em `scanDocument`.                                               |
| `paperSize`             | `detected` | `detected`, `auto`, `a4` ou `letter`. Somente em `scanDocument`.                                                        |
| `manualCorners`         | ausente    | Quatro pontos finitos em coordenadas da origem orientada por EXIF; pula a detecção automática.                          |
| `minConfidence`         | `0.58`     | Número de 0 a 1; menor nota automática aceita.                                                                          |
| `minDocumentAreaRatio`  | `0.12`     | Número de 0,02 a 0,95; menor área considerada durante a geração automática de candidatos.                               |
| `minSuccessAreaRatio`   | `0.20`     | Número de 0 a 0,95; candidato automático menor que isso produz `partial`, mesmo que passe confiança.                    |
| `paddingRatio`          | `0.003`    | Número de 0 a 0,05; expande os cantos antes da transformação. Não altera `detectDocument`.                              |
| `allowFrameFallback`    | `true`     | Permite usar a imagem inteira como documento parcial quando sua aparência for compatível.                               |
| `detectionMaxDimension` | por perfil | Inteiro de 320 a 4.096; maior eixo do raster de detecção automática.                                                    |
| `maxFileSizeBytes`      | 40 MiB     | Inteiro de 1 byte a 1 GiB; limita arquivo, download ou bytes em memória.                                                |
| `maxInputPixels`        | por perfil | Inteiro de 250.000 a 250.000.000; limita área orientada declarada antes do raster.                                      |
| `maxOutputPixels`       | por perfil | Inteiro de 250.000 a 100.000.000; limita o raster corrigido. Somente em `scanDocument`.                                 |
| `timeoutMs`             | por perfil | Inteiro de 0 a 3.600.000; zero desativa deadline.                                                                       |
| `requestHeaders`        | ausente    | Objeto simples de strings para URL HTTP(S); nomes são validados/normalizados e cabeçalhos de transporte são bloqueados. |
| `signal`                | ausente    | `AbortSignal` usado no carregamento e nos pontos de verificação do processamento.                                       |

### Formato de saída

```ts
interface OutputOptions<TEncoding extends OutputEncoding = OutputEncoding> {
  format?: "png" | "jpeg" | "webp" | "pdf";
  encoding?: TEncoding;
  quality?: number;
}
```

| Encoding   | Tipo de `result.data` | Conteúdo                            |
| ---------- | --------------------- | ----------------------------------- |
| `buffer`   | `Buffer`              | Bytes codificados.                  |
| `base64`   | `string`              | Somente o payload Base64.           |
| `data-url` | `string`              | `data:<mimeType>;base64,<payload>`. |

`result.output.byteLength` sempre mede os bytes binários antes da conversão para texto.

### Realce

- `none`: mantém o raster corrigido sem realce, achatando alpha sobre branco.
- `color`: nitidez e equalização local de contraste com cor preservada.
- `grayscale`: tons de cinza, nitidez e equalização local.
- `black-white`: cinza, equalização e binarização; PNG usa paleta e PDF incorpora PNG.

### Papel

- `detected`: mantém a proporção calculada dos lados.
- `a4`: força a razão 210/297.
- `letter`: força a razão 8,5/11.
- `auto`: ajusta para a opção mais próxima somente quando a razão observada está a até 2,5% de A4 ou Letter; do contrário resolve para `detected`.

`metadata.paperSize` registra o valor efetivamente resolvido quando existe saída.

### Cantos manuais

```ts
interface DocumentCorners {
  topLeft: { x: number; y: number };
  topRight: { x: number; y: number };
  bottomRight: { x: number; y: number };
  bottomLeft: { x: number; y: number };
}
```

As coordenadas usam pixels da imagem depois da orientação EXIF, com origem no canto superior esquerdo. O validador:

- exige quatro pares finitos;
- reordena geometricamente em sentido horário a partir do canto superior esquerdo;
- exige quadrilátero convexo, não degenerado e bem condicionado;
- tolera até 1% do maior eixo além dos limites para absorver pequenas imprecisões;
- exige pontos distintos e lados utilizáveis.

Detecção manual recebe `confidence: 1`, `method: "manual"`, `edgeSupport: 0` e `candidatesEvaluated: 0`. Ela pode continuar sendo `partial` se tocar o quadro da imagem.

### Cabeçalhos remotos

```js
const result = await scanDocument("https://arquivos.exemplo/documento.jpg", {
  requestHeaders: { authorization: `Bearer ${token}` },
});
```

Os cabeçalhos são removidos após redirect para outra origem ou downgrade de HTTPS para HTTP. Antes de aceitar URLs fornecidas por usuários, valide o protocolo e a origem, restrinja destinos de rede conforme a política da aplicação e não registre credenciais nem o conteúdo processado.

## Resultado de detecção

```ts
interface DetectionResult {
  status: "success" | "partial" | "not_found" | "error";
  success: boolean;
  detection: DocumentDetection | null;
  metadata: DetectionMetadata;
  warnings: string[];
  error: ScanErrorInfo | null;
}
```

### `DocumentDetection`

| Campo                 | Significado                                                                  |
| --------------------- | ---------------------------------------------------------------------------- |
| `corners`             | Quatro cantos no espaço da imagem de origem orientada.                       |
| `confidence`          | Nota normalizada de 0 a 1.                                                   |
| `method`              | `contour`, `lines`, `frame` ou `manual`.                                     |
| `areaRatio`           | Área do quadrilátero dividida pela área da origem.                           |
| `edgeSupport`         | Fração das amostras de borda apoiadas pelo mapa de bordas.                   |
| `touchesFrame`        | Algum canto está dentro de uma margem de 1,2% do menor eixo junto ao quadro. |
| `candidatesEvaluated` | Quantidade de candidatos examinados antes da seleção.                        |

`confidence` não é probabilidade calibrada nem garantia de página completa. Um retângulo interno bem definido pode pontuar alto; `minSuccessAreaRatio`, `status` e `warnings` existem para marcar esse risco.

## Resultado de digitalização

```ts
interface ScanResult<TEncoding extends OutputEncoding = "buffer"> {
  status: ScanStatus;
  success: boolean;
  confidence: number;
  data: EncodedScanData<TEncoding> | null;
  output: ScanOutputInfo<TEncoding> | null;
  detection: DocumentDetection | null;
  metadata: ScanMetadata;
  warnings: string[];
  error: ScanErrorInfo | null;
}
```

Quando `success` é verdadeiro, `data`, `output` e `detection` estão presentes, inclusive para `partial`. Quando `not_found` ocorre, não há artefato e `error` continua `null`. Quando `error` ocorre depois da detecção, o campo `detection` pode preservar o limite encontrado, mas `data` e `output` são nulos.

### `ScanOutputInfo`

| Campo             | Significado                                                        |
| ----------------- | ------------------------------------------------------------------ |
| `format`          | Contêiner solicitado.                                              |
| `encoding`        | Representação solicitada.                                          |
| `mimeType`        | `image/png`, `image/jpeg`, `image/webp` ou `application/pdf`.      |
| `byteLength`      | Tamanho binário codificado.                                        |
| `width`, `height` | Dimensões do raster corrigido, inclusive quando o contêiner é PDF. |

## Status e avisos

| Status      | Detecção/saída                 | Condição                                                                                       |
| ----------- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `success`   | presente                       | Limite aceito que não toca quadro e, se automático, alcança `minSuccessAreaRatio`.             |
| `partial`   | presente                       | Método `frame`, canto junto ao quadro ou candidato automático abaixo de `minSuccessAreaRatio`. |
| `not_found` | ausente                        | Nenhum candidato passou e o fallback não se aplicou/estava desativado.                         |
| `error`     | ausente ou detecção preservada | Uma fase terminou com falha categorizada.                                                      |

Além de condições `partial`, um candidato automático que passa `minConfidence` por margem inferior a 0,08 recebe aviso para revisão, sem mudar obrigatoriamente o status.

## Metadados

### Campos comuns

| Campo                               | Significado                                                              |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `performance`                       | Perfil resolvido. Em erro de opções, cai para `balanced`.                |
| `inputFormat`                       | Formato detectado quando a inspeção foi concluída.                       |
| `fileSizeBytes`                     | Tamanho carregado; zero quando não existe contexto completo.             |
| `sourceWidth`, `sourceHeight`       | Dimensões orientadas por EXIF.                                           |
| `detectionWidth`, `detectionHeight` | Raster automático reduzido ou dimensões da origem para cantos manuais.   |
| `durationMs`                        | Duração total monotônica.                                                |
| `complete`                          | Falso para `partial` e `error`; verdadeiro para `success` e `not_found`. |

### Campos adicionais de `ScanMetadata`

| Campo                         | Significado                                                          |
| ----------------------------- | -------------------------------------------------------------------- |
| `outputWidth`, `outputHeight` | Dimensões do raster ou zero sem saída.                               |
| `paperSize`                   | Política resolvida/solicitada.                                       |
| `enhancement`                 | Realce resolvido.                                                    |
| `loadDurationMs`              | Carregamento e inspeção.                                             |
| `detectionDurationMs`         | Detecção automática; zero para cantos manuais ou fase não concluída. |
| `transformDurationMs`         | Decodificação regional e homografia.                                 |
| `encodeDurationMs`            | Realce e codificação.                                                |

## Códigos de erro

| Código               | Origem típica                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `INVALID_INPUT`      | Tipo vazio/inválido, caminho que não é arquivo, esquema remoto proibido ou leitura local genérica. |
| `FILE_NOT_FOUND`     | Caminho local inexistente.                                                                         |
| `FILE_TOO_LARGE`     | Bytes excedem `maxFileSizeBytes`, por metadado HTTP ou leitura real.                               |
| `DOWNLOAD_ERROR`     | Fetch, redirect, status HTTP, corpo ou leitura remota falhou.                                      |
| `INVALID_OPTIONS`    | Tipo, enum, faixa, headers, sinal ou cantos não cumprem o contrato.                                |
| `UNSUPPORTED_FORMAT` | Assinatura não suportada, animação ou imagem multipágina.                                          |
| `INVALID_IMAGE`      | Metadados ou raster não podem ser decodificados com segurança.                                     |
| `TIMEOUT`            | Deadline configurado foi alcançado.                                                                |
| `ABORTED`            | `AbortSignal` do chamador foi acionado.                                                            |
| `RESOURCE_LIMIT`     | Eixo/pixels excedidos, `RangeError` ou limite de dimensão/memória.                                 |
| `PROCESSING_ERROR`   | Falha inesperada de OpenCV, transformação, realce ou codificação.                                  |

Mensagens são próprias para exibição/log operacional, mas não incluem a exceção original. Não dependa do texto para automação; use `error.code`.

## Ciclo de vida do runtime

### `warmupScanner`

```ts
function warmupScanner(): Promise<void>;
```

Inicializa antecipadamente o runtime OpenCV compartilhado. Diferente de `scanDocument` e `detectDocument`, essa função não transforma falha em resultado estruturado; sua Promise pode rejeitar se o runtime não carregar.

Use-a no startup quando a latência da primeira digitalização não puder incluir o cold start:

```js
await warmupScanner();
```

### `releaseScannerResources`

```ts
function releaseScannerResources(): void;
```

Limpa o cache de operações do `sharp` ao fim de um lote e restaura os limites anteriores do cache. O cache é global a todos os usos de `sharp` no processo. O heap WebAssembly do OpenCV permanece alocado e scans posteriores continuam funcionando.

```js
try {
  await warmupScanner();
  // processar o lote
} finally {
  releaseScannerResources();
}
```

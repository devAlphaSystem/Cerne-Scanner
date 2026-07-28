# API

Referência completa da superfície pública de `cerne-scanner`. Para receitas de
uso, veja [EXEMPLOS.md](EXEMPLOS.md); para a linha de comando, veja
[CLI.md](CLI.md).

## Superfície exportada

```ts
import {
  // Operações
  detectDocument,
  scanDocument,
  warmupScanner,
  // Tipos
  type DetectOptions,
  type DetectionMetadata,
  type DetectionMethod,
  type DetectionResult,
  type DocumentCorners,
  type DocumentDetection,
  type EncodedScanData,
  type EnhancementMode,
  type InputImageFormat,
  type OutputEncoding,
  type OutputFormat,
  type OutputOptions,
  type PaperSize,
  type PerformanceProfile,
  type Point,
  type ScanErrorCode,
  type ScanErrorInfo,
  type ScanInput,
  type ScanMetadata,
  type ScanOptions,
  type ScanOutputInfo,
  type ScanResult,
  type ScanStatus,
} from "cerne-scanner";
```

Tudo o mais é interno. `ResolvedOptions`, `InvalidOptionsError`, `ScanFailure`,
`getOpenCv` e os módulos de `document/`, `detection/`, `geometry/`, `output/` e
`processing/` não fazem parte do contrato público e podem mudar sem aviso.

Não existe API de lote nem de composição de PDF multipágina. Cada chamada
processa uma imagem.

---

## Entradas

`ScanInput` aceita:

| Forma                      | Observação                                 |
| -------------------------- | ------------------------------------------ |
| `string` com caminho local | Caminho resolvido pelo sistema de arquivos |
| `string` com URL           | Somente `http://` e `https://` completos   |
| `ArrayBuffer`              | Bytes copiados para memória própria        |
| `Uint8Array` / `Buffer`    | Bytes copiados; `Buffer` é um `Uint8Array` |

Assinaturas reconhecidas: JPEG, PNG, WebP, TIFF, AVIF e HEIF. A decisão usa os
bytes; extensão, `Content-Type` e nome do arquivo não influenciam a aceitação. A
imagem é orientada conforme EXIF antes de detectar ou validar cantos.

A decodificação depende dos codecs disponíveis no `sharp`/`libvips`. Em
particular, HEIC baseado em HEVC normalmente exige um `libvips` global compilado
com suporte adicional; sem ele, o contêiner pode ser reconhecido e ainda assim
retornar `INVALID_IMAGE`.

Cada entrada deve ter uma única página ou quadro estático. PDF é suportado
somente como **saída**.

---

## Operações

### `scanDocument(input, options?)`

```ts
function scanDocument<TEncoding extends OutputEncoding = "buffer">(input: ScanInput, options?: ScanOptions<TEncoding>): Promise<ScanResult<TEncoding>>;
```

Carrega a imagem, encontra ou valida os cantos, corrige a perspectiva, aplica o
realce e codifica a saída solicitada. O genérico associa `output.encoding` ao
tipo de `data`:

```ts
const binario = await scanDocument("./foto.jpg");
// binario.data: Buffer | null

const textual = await scanDocument("./foto.jpg", {
  output: { format: "jpeg", encoding: "base64" },
});
// textual.data: string | null
```

`ScanResult` não é uma união discriminada. Mesmo depois de verificar
`result.success`, confira `Buffer.isBuffer(result.data)`,
`typeof result.data === "string"` ou `result.data !== null` antes de consumir o
valor.

Falhas de validação, carregamento, detecção, transformação e codificação são
convertidas em `result.error`; não rejeitam a promise como fluxo normal.

### `detectDocument(input, options?)`

```ts
function detectDocument(input: ScanInput, options?: DetectOptions): Promise<DetectionResult>;
```

Executa carregamento, inspeção e seleção do quadrilátero, mas não corrige a
perspectiva, não aplica realce e não codifica saída. `DetectOptions` é:

```ts
type DetectOptions = Omit<ScanOptions, "output" | "enhancement" | "paperSize" | "maxOutputPixels">;
```

`paddingRatio` permanece no tipo compartilhado, porém só é aplicado por
`scanDocument`; não altera os cantos devolvidos por `detectDocument`.

Falhas também chegam estruturadas em `DetectionResult.error`.

### `warmupScanner()`

```ts
function warmupScanner(): Promise<void>;
```

Inicializa antecipadamente o runtime OpenCV.js compartilhado pelo processo.
Use antes de receber a primeira tarefa quando a latência de inicialização
importar:

```ts
await warmupScanner();
```

Diferentemente das duas operações de resultado estruturado, essa promise pode
ser rejeitada se o runtime não puder ser carregado. A promise do runtime é
armazenada; se rejeitar, novas chamadas no mesmo processo recebem a mesma
rejeição em vez de tentar inicializar novamente. A exceção não é sanitizada como
`ScanErrorInfo` e deve permanecer em diagnóstico interno.

---

## Opções

### `ScanOptions`

| Opção                   | Tipo                               | Padrão              | Faixa/valores                      |
| ----------------------- | ---------------------------------- | ------------------- | ---------------------------------- |
| `performance`           | `PerformanceProfile`               | `"balanced"`        | `fast`, `balanced`, `accurate`     |
| `output.format`         | `OutputFormat`                     | `"png"`             | `png`, `jpeg`, `webp`, `pdf`       |
| `output.encoding`       | `OutputEncoding`                   | `"buffer"`          | `buffer`, `base64`, `data-url`     |
| `output.quality`        | `number`                           | `92`                | inteiro `1..100`                   |
| `enhancement`           | `EnhancementMode`                  | `"color"`           | quatro modos                       |
| `paperSize`             | `PaperSize`                        | `"detected"`        | `detected`, `auto`, `a4`, `letter` |
| `manualCorners`         | `DocumentCorners`                  | nenhum              | quadrilátero válido                |
| `minConfidence`         | `number`                           | `0.58`              | `0..1`                             |
| `minDocumentAreaRatio`  | `number`                           | `0.12`              | `0.02..0.95`                       |
| `paddingRatio`          | `number`                           | `0.003`             | `0..0.05`                          |
| `allowFrameFallback`    | `boolean`                          | `true`              | —                                  |
| `detectionMaxDimension` | `number`                           | do perfil           | inteiro `320..4096`                |
| `maxFileSizeBytes`      | `number`                           | `41943040` (40 MiB) | inteiro `1..1073741824`            |
| `maxInputPixels`        | `number`                           | do perfil           | inteiro `250000..250000000`        |
| `maxOutputPixels`       | `number`                           | do perfil           | inteiro `250000..100000000`        |
| `timeoutMs`             | `number`                           | do perfil           | inteiro `0..3600000`; `0` desliga  |
| `requestHeaders`        | `Readonly<Record<string, string>>` | nenhum              | somente com URL                    |
| `signal`                | `AbortSignal`                      | nenhum              | cancelamento cooperativo           |

Tipos inválidos e números fora da faixa produzem
`error.code === "INVALID_OPTIONS"`. Opções de limite marcadas como inteiras
recusam frações. `minConfidence`, `minDocumentAreaRatio` e `paddingRatio`
aceitam números finitos fracionários.

Em JavaScript, chaves desconhecidas no objeto principal ou em `output` são
ignoradas silenciosamente. Um erro como `timeoutMS` aplica o padrão em vez de
falhar; use TypeScript ou valide a configuração da aplicação. Propriedades
exclusivas de `scanDocument` também podem ser aceitas em runtime por
`detectDocument`, mas não produzem saída nem efeito visual nessa operação.

### Perfis de desempenho

| Perfil     | `detectionMaxDimension` | `maxInputPixels` | `maxOutputPixels` | `timeoutMs` |
| ---------- | ----------------------- | ---------------- | ----------------- | ----------- |
| `fast`     | 960                     | 60.000.000       | 20.000.000        | 20.000      |
| `balanced` | 1.440                   | 100.000.000      | 32.000.000        | 60.000      |
| `accurate` | 2.048                   | 160.000.000      | 50.000.000        | 120.000     |

O perfil fornece padrões e seleciona a profundidade do algoritmo. Valores
informados explicitamente prevalecem. Em linhas gerais:

- `fast` usa um mapa de bordas, menos candidatos e não refina o quadrilátero;
- `balanced` usa mapas adicionais, mais candidatos e refinamento de borda;
- `accurate` adiciona um mapa local, sempre executa a busca por linhas e usa
  interpolação cúbica na correção; os outros perfis usam interpolação linear e
  só recorrem às linhas quando o melhor contorno fica abaixo do limiar interno.

### Saída e qualidade

```ts
interface OutputOptions<TEncoding extends OutputEncoding = OutputEncoding> {
  format?: "png" | "jpeg" | "webp" | "pdf";
  encoding?: TEncoding;
  quality?: number;
}
```

`quality` controla JPEG, WebP e o JPEG incorporado ao PDF. PNG é sem perdas e
ignora essa opção. No modo `black-white`, o PDF incorpora PNG e também ignora
`quality`.

Base64 aumenta o texto em aproximadamente um terço em relação aos bytes; Data
URL acrescenta ainda o prefixo do tipo de mídia. Para imagens grandes, prefira
`buffer` e fluxo binário da aplicação.

### Realce

| Modo          | Tratamento                                          |
| ------------- | --------------------------------------------------- |
| `none`        | Mantém as cores corrigidas sem realce tonal         |
| `color`       | Contraste local conservador e nitidez, mantendo cor |
| `grayscale`   | Escala de cinza, contraste local e nitidez          |
| `black-white` | Escala de cinza, contraste e limiarização binária   |

Transparência é achatada sobre fundo branco durante a decodificação.

### Proporção do papel

- `detected`: preserva a proporção calculada a partir dos quatro lados.
- `a4`: força a proporção `210 / 297`, mantendo retrato ou paisagem.
- `letter`: força a proporção `8.5 / 11`.
- `auto`: encaixa em A4 ou Carta somente se o erro relativo da proporção for de
  no máximo 2,5%; caso contrário mantém `detected`.

`maxOutputPixels` pode reduzir largura e altura, preservando a proporção. O
valor efetivamente resolvido aparece em `metadata.paperSize`.

PDF é sempre uma página raster. A página usa dimensões A4 ou Carta quando esse
foi o papel resolvido; no modo `detected`, a maior dimensão usa o comprimento de
uma folha A4 e a outra acompanha a proporção da imagem.

### `manualCorners`

```ts
interface Point {
  x: number;
  y: number;
}

interface DocumentCorners {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}
```

As coordenadas pertencem à imagem **depois da orientação EXIF**. Os quatro
pontos precisam ser finitos, distintos e formar um quadrilátero convexo e
geometricamente utilizável. A validação admite uma tolerância de até 1% do maior
eixo fora dos limites declarados da imagem.

Quando os cantos são fornecidos:

- a busca automática é ignorada;
- `method` vale `"manual"`;
- `confidence` vale `1` e `edgeSupport` vale `0`;
- `candidatesEvaluated` vale `0`;
- `minConfidence` e `minDocumentAreaRatio` não filtram o quadrilátero.

Nesse caminho, `confidence: 1` significa que o pacote confiou na geometria
fornecida; não mede foco, legibilidade nem qualidade da fotografia. Para
`touchesFrame`, "tocar" significa entrar numa margem de 1,2% do menor eixo, não
apenas coincidir com o último pixel. Esses casos ainda produzem
`status: "partial"`.

`paddingRatio` expande uma cópia interna dos cantos usada no warp. Os cantos em
`result.detection` continuam sendo os originais detectados ou fornecidos.

### `requestHeaders`

Aceito somente quando `input` é uma URL HTTP/HTTPS e somente com valores string.
Nomes são normalizados para minúsculas e validados pelo Node.js. São recusados:

- nomes duplicados quando comparados sem diferenciar maiúsculas;
- objetos com protótipo diferente de `Object.prototype` ou `null`;
- os cabeçalhos reservados pelo componente de download:

```text
accept-encoding, connection, content-length, expect, host, if-range,
keep-alive, proxy-connection, range, te, trailer, transfer-encoding, upgrade
```

O pacote não realiza login nem mantém cookies. A aplicação chamadora responde
pelas credenciais e pelo estado da sessão.

---

## Resultado de digitalização

```ts
interface ScanResult<TEncoding extends OutputEncoding = "buffer"> {
  status: "success" | "partial" | "not_found" | "error";
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

### Como `status` é decidido

| Condição                                          | `status`      | `success` |
| ------------------------------------------------- | ------------- | --------- |
| Saída produzida com quatro bordas internas        | `"success"`   | `true`    |
| Saída produzida, mas a detecção toca o quadro     | `"partial"`   | `true`    |
| Quadro inteiro preservado como fallback           | `"partial"`   | `true`    |
| Detecção completa sem quadrilátero aceito         | `"not_found"` | `false`   |
| Falha de entrada, opção, recurso ou processamento | `"error"`     | `false`   |

`partial` é saída utilizável com uma ressalva geométrica; examine `warnings` e
decida se o documento precisa de revisão. `not_found` é uma conclusão normal,
sem `error`.

Se a correção ou codificação falhar depois da detecção, o resultado de erro pode
preservar `confidence`, `detection` e os avisos já conhecidos, mas `data` e
`output` voltam `null`.

### `data` e `ScanOutputInfo`

```ts
type EncodedScanData<TEncoding extends OutputEncoding> = TEncoding extends "buffer" ? Buffer : string;

interface ScanOutputInfo<TEncoding extends OutputEncoding> {
  format: OutputFormat;
  encoding: TEncoding;
  mimeType: string;
  byteLength: number;
  width: number;
  height: number;
}
```

`byteLength` mede os bytes codificados antes de Base64 ou Data URL. `width` e
`height` são as dimensões do raster corrigido, inclusive quando o contêiner é
PDF.

`data` contém o documento digitalizado completo e pode conter informação
sensível. Não registre o resultado inteiro em logs sem remover esse campo.

---

## Resultado de detecção

```ts
interface DetectionResult {
  status: ScanStatus;
  success: boolean;
  detection: DocumentDetection | null;
  metadata: DetectionMetadata;
  warnings: string[];
  error: ScanErrorInfo | null;
}
```

As mesmas regras de `status` se aplicam, mas `success` indica a presença de um
quadrilátero, não de bytes codificados. Não existem `data`, `output` nem campos
de transformação.

---

## Detecção

### `DocumentDetection`

| Campo                 | Significado                                                  |
| --------------------- | ------------------------------------------------------------ |
| `corners`             | Cantos em pixels da imagem de origem orientada por EXIF      |
| `confidence`          | Escore de `0` a `1`, com semântica dependente do método      |
| `method`              | `contour`, `lines`, `frame` ou `manual`                      |
| `areaRatio`           | Fração da imagem encerrada pelo quadrilátero                 |
| `edgeSupport`         | Fração de amostras da borda sustentada pelos mapas de aresta |
| `touchesFrame`        | Indica que ao menos um canto está próximo da margem          |
| `candidatesEvaluated` | Quantidade de quadriláteros examinados antes da seleção      |

Métodos:

- `contour`: quadrilátero aproximado a partir de contornos fechados;
- `lines`: interseção de linhas externas detectadas;
- `frame`: imagem inteira preservada como fallback parcial;
- `manual`: cantos fornecidos pelo chamador.

Para `contour` e `lines`, o escore combina área, suporte de borda, contraste,
ângulos, paralelismo, centralidade e proporção. Em `frame`, combina brilho,
distribuição de pixels escuros e aparência de página; em `manual`, vale `1`
porque os pontos vieram do chamador. É uma heurística determinística, **não**
uma probabilidade calibrada nem uma medida uniforme entre métodos. O contrato
atual não publica uma versão de confiança; valide método e limiar em fotografias
representativas antes de automatizar rejeições.

`allowFrameFallback: false` desliga somente o método `frame`. Um contorno,
detecção por linhas ou quadrilátero manual que toque a margem continua podendo
retornar `partial`.

---

## Metadados

### `DetectionMetadata`

| Campo             | Significado                                              |
| ----------------- | -------------------------------------------------------- |
| `performance`     | Perfil resolvido                                         |
| `inputFormat?`    | `jpeg`, `png`, `webp`, `tiff`, `avif` ou `heif`          |
| `fileSizeBytes`   | Tamanho carregado; zero quando a inspeção não completou  |
| `sourceWidth`     | Largura da imagem orientada; zero em erro precoce        |
| `sourceHeight`    | Altura da imagem orientada; zero em erro precoce         |
| `detectionWidth`  | Largura do raster de análise ou da origem no modo manual |
| `detectionHeight` | Altura do raster de análise ou da origem no modo manual  |
| `durationMs`      | Tempo total decorrido                                    |
| `complete`        | `true` somente em `success` ou `not_found`               |

`inputFormat` é omitido quando a falha acontece antes de uma inspeção completa.

### `ScanMetadata`

Além dos campos de detecção:

| Campo                 | Significado                                                 |
| --------------------- | ----------------------------------------------------------- |
| `outputWidth`         | Largura corrigida, ou zero sem saída                        |
| `outputHeight`        | Altura corrigida, ou zero sem saída                         |
| `paperSize`           | Papel resolvido; sem saída, modo solicitado ou fallback     |
| `enhancement`         | Realce resolvido                                            |
| `loadDurationMs`      | Carregamento e inspeção                                     |
| `detectionDurationMs` | Busca automática; zero em cantos manuais ou fase incompleta |
| `transformDurationMs` | Decodificação da região e correção de perspectiva           |
| `encodeDurationMs`    | Realce e codificação da saída                               |

Zero significa que a duração da fase não foi registrada, não necessariamente
que nenhum trabalho ocorreu. Por exemplo, se a codificação falhar depois do
warp, o resultado de erro volta com `transformDurationMs: 0`. `durationMs` mede
a operação inteira e pode ser maior que a soma dos campos individuais.

---

## Erros

```ts
interface ScanErrorInfo {
  code: ScanErrorCode;
  message: string;
}
```

| Código               | Quando ocorre                                                   |
| -------------------- | --------------------------------------------------------------- |
| `INVALID_INPUT`      | Tipo, caminho, URL ou conteúdo de entrada inválido              |
| `FILE_NOT_FOUND`     | Caminho local inexistente                                       |
| `FILE_TOO_LARGE`     | Excede `maxFileSizeBytes`, declarado ou recebido                |
| `DOWNLOAD_ERROR`     | Falha de rede, HTTP, corpo ou redirecionamento                  |
| `INVALID_OPTIONS`    | Opção, cabeçalho, sinal ou canto fora do contrato               |
| `UNSUPPORTED_FORMAT` | Assinatura não suportada ou imagem animada/multipágina          |
| `INVALID_IMAGE`      | Metadados ou raster não puderam ser decodificados com segurança |
| `TIMEOUT`            | `timeoutMs` esgotado                                            |
| `ABORTED`            | `signal` disparado                                              |
| `RESOURCE_LIMIT`     | Limite de pixels, eixo, memória ou dimensão atingido            |
| `PROCESSING_ERROR`   | Falha inesperada convertida em resultado estruturado            |

Mensagens estruturadas não reproduzem URL, consulta, caminho, cabeçalhos,
bytes de entrada nem exceções internas. Isso não torna `ScanResult` inteiro
apropriado para logs: em caso de sucesso, `data` contém a saída digitalizada.

---

## Documentos remotos

Somente URLs `http://` e `https://`, sem usuário ou senha embutidos. O download
segue respostas 301, 302, 303, 307 e 308, com no máximo cinco
redirecionamentos.

Redirecionamentos de mesma origem preservam `requestHeaders`. Quando a origem
muda — ou há rebaixamento de HTTPS para HTTP — todos os cabeçalhos do chamador
são removidos antes da próxima solicitação. `accept-encoding` é fixado como
`identity` pelo pacote.

`maxFileSizeBytes` é aplicado ao `Content-Length` válido e aos bytes recebidos.
`timeoutMs` e `signal` governam a operação inteira de forma cooperativa. Download
e leitura local recebem um sinal abortável; fases de Sharp, OpenCV.js, PDF e
representação textual que não aceitam esse sinal só são verificadas entre pontos
de controle. Portanto, o prazo não é um teto rígido de tempo de parede. Falhas
usam `DOWNLOAD_ERROR`, `FILE_TOO_LARGE`, `TIMEOUT` ou `ABORTED`, conforme a
causa.

> **O pacote não é um filtro de SSRF.** A URL e seus redirecionamentos podem
> alcançar qualquer endereço acessível ao processo. Quando forem necessárias
> regras de host, DNS/IP ou redirecionamento, faça o download com um cliente
> controlado pela aplicação e entregue os bytes ao Scanner.

---

## Imagens, limites e segurança

Antes da decodificação completa, o pacote valida assinatura, tamanho,
metadados, orientação, número de páginas, largura, altura e área declarada.
Cada eixo da imagem orientada é limitado a 32.767 pixels, além de
`maxInputPixels`.

A detecção automática usa uma cópia reduzida até `detectionMaxDimension`. Para a
correção, somente a região em torno dos cantos é decodificada, e ela pode ser
reduzida conforme o orçamento de saída. `maxOutputPixels` limita o raster final.

Não há interface de streaming. Arquivo, resposta HTTP, rasters intermediários e
saída codificada são materializados em memória; Base64 e Data URL criam ainda
uma representação textual. Os limites são aplicados por chamada e não somam o
consumo de execuções concorrentes. Controle a concorrência na aplicação,
especialmente ao elevar os tetos máximos de bytes e pixels.

- Execução somente por CPU; nenhum backend de GPU é usado.
- A rede serve apenas ao download da entrada. Detecção, correção e codificação
  são locais.
- Não há OCR, extração de texto, camada PDF pesquisável ou interpretação do
  documento.
- Não há cache próprio nem persistência automática em disco.
- A memória é devolvida ao coletor de lixo sem garantia de sobrescrita segura
  dos buffers depois do uso.
- Imagens animadas ou multipágina são recusadas.
- PDF, SVG, GIF e vídeo não são entradas aceitas.
- Fotos cortadas, escuras, desfocadas, com reflexo ou sem contraste suficiente
  podem terminar legitimamente em `not_found` ou `partial`.

O Scanner só avalia geometria visual. Uma saída `success` não comprova que todo
o conteúdo está legível, que o documento é autêntico ou que a fotografia não
perdeu informação fora da folha detectada.

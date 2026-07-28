# CLI

O pacote registra o binário `cerne-scanner`. A saída padrão contém **somente
JSON**; os bytes binários são gravados no caminho indicado por `--output` ou
representados como texto por `--encoding`.

## Uso

```text
cerne-scanner <imagem-ou-url> (--output <arquivo> | --encoding base64|data-url) [opções]
```

Exatamente **uma** fonte por execução e exatamente **uma** forma de entrega:

- `--output <arquivo>` grava PNG, JPEG, WebP ou PDF;
- `--encoding base64|data-url` inclui a saída textual no JSON.

As duas opções são mutuamente exclusivas. A CLI não aceita stdin, bytes em
memória, lote nem modo somente detecção; ela sempre chama `scanDocument` para um
caminho local ou URL HTTP/HTTPS.

```bash
cerne-scanner ./foto.jpg --output ./scan.png --pretty
```

A CLI reconhece assinaturas de JPEG, PNG, WebP, TIFF, AVIF e HEIF. O formato é
decidido pelos bytes, não pela extensão. PDF é somente saída. HEIC baseado em
HEVC requer suporte adicional no `libvips`; sem o codec, retorna `INVALID_IMAGE`.

## Opções

| Opção                     | Valor                                       | Padrão            | Efeito                                             |
| ------------------------- | ------------------------------------------- | ----------------- | -------------------------------------------------- |
| `--output <arquivo>`      | caminho                                     | nenhum            | Grava os bytes sem colocá-los no JSON              |
| `--format <formato>`      | `png`, `jpeg`, `webp`, `pdf`                | extensão ou `png` | Seleciona o contêiner                              |
| `--encoding <modo>`       | `base64`, `data-url`                        | nenhum            | Devolve os bytes como texto no JSON                |
| `--performance <perfil>`  | `fast`, `balanced`, `accurate`              | `balanced`        | Seleciona profundidade e limites                   |
| `--enhancement <modo>`    | `none`, `color`, `grayscale`, `black-white` | `color`           | Aplica realce depois da correção                   |
| `--paper-size <papel>`    | `detected`, `auto`, `a4`, `letter`          | `detected`        | Controla a proporção final                         |
| `--quality <n>`           | inteiro `1..100`                            | `92`              | Qualidade JPEG/WebP e raster JPEG do PDF           |
| `--min-confidence <n>`    | `0..1`                                      | `0.58`            | Confiança mínima da detecção automática            |
| `--padding <n>`           | `0..0.05`                                   | `0.003`           | Expande os cantos antes do recorte                 |
| `--corners <pontos>`      | `x,y;x,y;x,y;x,y`                           | automático        | Usa TL, TR, BR e BL da imagem orientada            |
| `--detection-size <n>`    | inteiro `320..4096`                         | do perfil         | Limita o maior eixo do raster de análise           |
| `--max-file-size <bytes>` | inteiro `1..1073741824`                     | `41943040`        | Limita a entrada local ou remota                   |
| `--max-input-pixels <n>`  | inteiro `250000..250000000`                 | do perfil         | Limita a área da imagem orientada                  |
| `--max-output-pixels <n>` | inteiro `250000..100000000`                 | do perfil         | Limita a área do raster corrigido                  |
| `--timeout-ms <n>`        | inteiro `0..3600000`                        | do perfil         | Limita download e processamento; `0` desliga       |
| `--no-frame-fallback`     | —                                           | desligado         | Impede preservar o quadro inteiro como fallback    |
| `--force`                 | —                                           | desligado         | Permite substituir o arquivo de `--output`         |
| `--pretty`                | —                                           | desligado         | Indenta o JSON com dois espaços                    |
| `--help`                  | —                                           | —                 | Imprime o descritor de ajuda em JSON e sai com `0` |

Os padrões dependentes do perfil são:

| Perfil     | Detecção | Entrada     | Saída      | Prazo |
| ---------- | -------- | ----------- | ---------- | ----- |
| `fast`     | 960 px   | 60 milhões  | 20 milhões | 20 s  |
| `balanced` | 1.440 px | 100 milhões | 32 milhões | 60 s  |
| `accurate` | 2.048 px | 160 milhões | 50 milhões | 120 s |

Valores explícitos prevalecem sobre o perfil. `--min-confidence` e `--padding`
aceitam frações; qualidade, dimensões, bytes, pixels e prazo precisam ser
inteiros.

O prazo é cooperativo. Download e leitura podem ser abortados; fases de imagem
que não observam o sinal só verificam a interrupção entre pontos de controle.
`--timeout-ms` não é um teto rígido de tempo de parede.

`minDocumentAreaRatio`, `requestHeaders` e `signal` existem somente na API.
A sintaxe aceita é `--opção valor`; não há opções curtas,
`--opção=valor` nem marcador `--` para encerrar a análise de argumentos. Um
caminho iniciado por `--` é interpretado como opção.

## Formato inferido pelo arquivo

Com `--output`, estas extensões selecionam o formato automaticamente:

| Extensão        | Formato |
| --------------- | ------- |
| `.png`          | PNG     |
| `.jpg`, `.jpeg` | JPEG    |
| `.webp`         | WebP    |
| `.pdf`          | PDF     |

Uma extensão conhecida em conflito com `--format` é erro de argumento:

```bash
# Inválido: a extensão pede PNG e a opção pede PDF.
cerne-scanner ./foto.jpg --output ./scan.png --format pdf
```

Para uma extensão desconhecida, informe `--format`; sem a opção, o padrão é
PNG. A extensão da **entrada** não participa dessa decisão.

## Arquivo de saída

Por padrão, a CLI cria um arquivo novo e recusa substituir um caminho existente.
Use `--force` somente quando a substituição for intencional:

```bash
cerne-scanner ./foto.jpg --output ./scan.webp --force
```

A CLI não cria diretórios. O diretório pai de `--output` precisa existir. O
arquivo só é gravado quando `scanDocument` produz saída, inclusive quando o
resultado é `partial`.

Com `--force`, a gravação trunca o arquivo existente e não é uma troca atômica;
uma falha do sistema de arquivos pode deixá-lo vazio ou incompleto. Sem
`--output`, `--force` é aceito, mas não tem efeito.

Quando `--output` é usado:

- o JSON omite `data`;
- `outputWritten` vale `true` em uma gravação bem-sucedida;
- `outputWritten` vale `false` em `not_found` ou erro de processamento;
- quando há saída, `output` ainda descreve formato, tipo de mídia, bytes e
  dimensões;
- o caminho de saída não é reproduzido no JSON.

Falha de gravação retorna código `PROCESSING_ERROR` e não deixa o comando sair
com sucesso.

## Cantos manuais

```text
--corners x1,y1;x2,y2;x3,y3;x4,y4
```

Informe quatro pontos na convenção superior esquerdo, superior direito, inferior
direito e inferior esquerdo (`TL,TR,BR,BL`). O Scanner reordena os pontos para
essa sequência canônica durante a validação. As coordenadas pertencem à imagem
depois da orientação EXIF.

O ponto e vírgula separa comandos em shells comuns; coloque o valor inteiro
entre aspas:

```bash
cerne-scanner ./foto.jpg \
  --corners "120,90;1780,130;1710,2440;160,2380" \
  --output ./scan.png
```

Cantos precisam ser finitos, distintos, suficientemente separados e formar um
quadrilátero convexo, não degenerado e bem condicionado. A validação admite uma
tolerância de até 1% do maior eixo em torno dos limites da imagem.

Cantos manuais ignoram a detecção automática. Nessa execução,
`--min-confidence`, `--detection-size` e `--no-frame-fallback` não alteram o
resultado; `--padding` continua sendo aplicado antes da correção. Se os cantos
tocarem a margem da imagem, o resultado continua sendo `partial`.

## Códigos de saída

| Código | Significado                                                 |
| ------ | ----------------------------------------------------------- |
| `0`    | Saída produzida, inclusive `status: "partial"`, ou `--help` |
| `2`    | `status: "not_found"` — nenhuma folha aceita                |
| `1`    | Erro de argumento, carregamento, processamento ou gravação  |

Quando não há falha própria da CLI, `result.success: true` produz código `0`.
Portanto, `partial` sai com `0`: houve um arquivo, mas a geometria pede revisão.
Uma falha ao gravar `--output` prevalece sobre o scan e produz `1`. Confira
`status` e `warnings` quando a completude importar.

Erros do analisador de argumentos — opção desconhecida, valor ausente ou não
numérico, quantidade de fontes, forma de entrega e conflito de formato —
produzem JSON com `error.code === "INVALID_INPUT"`. Valores fora da faixa,
inteiros fracionários e cantos geometricamente inválidos chegam ao Scanner como
`INVALID_OPTIONS`. Não há diagnóstico solto em stderr.

## Sem credenciais na CLI

A CLI não aceita cabeçalhos, cookies nem usuário/senha na URL. Para imagens
privadas, use a API com `requestHeaders`:

```ts
await scanDocument(url, {
  requestHeaders: { Authorization: "Bearer <token>" },
});
```

Evite tokens na string de consulta da linha de comando: argumentos podem
aparecer no histórico do terminal e na lista de processos. A CLI também não
aplica política de SSRF; use apenas URLs públicas já controladas.

## Exemplos

PNG com opções padrão:

```bash
cerne-scanner ./foto.jpg --output ./scan.png --pretty
```

PDF A4 em escala de cinza:

```bash
cerne-scanner ./foto.webp \
  --output ./scan.pdf \
  --paper-size a4 \
  --enhancement grayscale \
  --quality 90 \
  --pretty
```

Documento preto e branco, sem fallback do quadro:

```bash
cerne-scanner ./pagina.png \
  --output ./scan.png \
  --enhancement black-white \
  --no-frame-fallback
```

URL pública com prazo próprio:

```bash
cerne-scanner https://documents.example.com/public/foto.avif \
  --output ./scan.jpg \
  --timeout-ms 30000
```

JPEG como Base64 no JSON:

```bash
cerne-scanner ./foto.tiff --encoding base64 --format jpeg --quality 85
```

Data URL pronta para transporte textual:

```bash
cerne-scanner ./foto.avif --encoding data-url --format webp
```

## Consumindo a saída

Somente o Base64:

```bash
cerne-scanner ./foto.jpg --encoding base64 --format png | jq -r '.data'
```

Status, método e confiança depois de gravar o arquivo:

```bash
cerne-scanner ./foto.jpg --output ./scan.png \
  | jq '{status, outputWritten, method: .detection.method, confidence}'
```

No PowerShell, reconstruindo um JPEG recebido como Base64:

```powershell
$resultado = cerne-scanner ./foto.png --encoding base64 --format jpeg |
  ConvertFrom-Json

if ($resultado.success) {
  [IO.File]::WriteAllBytes(
    "scan.jpg",
    [Convert]::FromBase64String($resultado.data)
  )
}
```

Ramificando por código de saída:

```bash
cerne-scanner ./foto.jpg --output ./scan.png > resultado.json
case $? in
  0) jq -r '.status' resultado.json ;;
  2) echo "nenhuma folha detectada" ;;
  *) jq -r '.error.code // "erro"' resultado.json ;;
esac
```

Base64 e Data URL contêm o documento completo, aumentam consumo de memória e
podem expor conteúdo sensível. Não registre o JSON integral dessas modalidades.

## Ajuda

```bash
cerne-scanner --help
```

Devolve um descritor JSON com `name`, `usage`, `inputFormats`, `outputFormats`,
`examples` e a lista de `options`. `--help` tem precedência sobre qualquer outro
argumento e sempre sai com `0`.

# Referência da CLI

## Visão geral

O binário `cerne-scanner` processa uma imagem por execução. Ele recebe somente caminho local ou URL HTTP(S), não bytes em memória, e exige uma destas formas de saída:

- `--output <arquivo>` para gravar bytes;
- `--encoding base64` ou `--encoding data-url` para incluir texto no JSON do `stdout`.

Bytes binários nunca são enviados ao `stdout`. Assim, logs e automações podem tratar toda resposta da CLI como JSON.

## Sintaxe

```text
cerne-scanner <imagem-ou-url> (--output <arquivo> | --encoding base64|data-url) [opcoes]
```

Exemplos:

```bash
cerne-scanner ./foto.jpg --output ./scan.png --pretty
cerne-scanner ./foto.jpg --output ./scan.pdf --paper-size a4 --enhancement color
cerne-scanner https://example.com/documento.webp --encoding base64 --format jpeg
```

Use aspas quando caminhos ou URLs contiverem espaços ou caracteres interpretados pelo shell.

## Ajuda

```bash
cerne-scanner --help --pretty
```

`--help` imprime um objeto JSON com nome, sintaxe, formatos, opções e exemplos, e retorna código 0. Quando `--help` está presente, os demais argumentos não são processados.

## Opções

| Opção                 | Valor                                       | Padrão/efeito                                                      |
| --------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `--output`            | `<arquivo>`                                 | Grava a saída binária; obrigatório quando não há encoding textual. |
| `--format`            | `png`, `jpeg`, `webp`, `pdf`                | Inferido da extensão conhecida de `--output`; senão `png`.         |
| `--encoding`          | `base64`, `data-url`                        | Inclui `data` textual no JSON; incompatível com `--output`.        |
| `--performance`       | `fast`, `balanced`, `accurate`              | `balanced`.                                                        |
| `--enhancement`       | `none`, `color`, `grayscale`, `black-white` | `color`.                                                           |
| `--paper-size`        | `detected`, `auto`, `a4`, `letter`          | `detected`.                                                        |
| `--quality`           | inteiro 1..100                              | 92; JPEG, WebP e raster JPEG do PDF.                               |
| `--min-confidence`    | número 0..1                                 | 0,58.                                                              |
| `--min-success-area`  | número 0..0,95                              | 0,20; abaixo disso o candidato automático vira `partial`.          |
| `--padding`           | número 0..0,05                              | 0,003.                                                             |
| `--corners`           | `x,y;x,y;x,y;x,y`                           | Cantos TL, TR, BR e BL da imagem orientada por EXIF.               |
| `--detection-size`    | inteiro 320..4096                           | Padrão do perfil.                                                  |
| `--max-file-size`     | inteiro em bytes                            | 40 MiB; faixa de 1 byte a 1 GiB.                                   |
| `--max-input-pixels`  | inteiro                                     | Padrão do perfil; faixa 250.000..250.000.000.                      |
| `--max-output-pixels` | inteiro                                     | Padrão do perfil; faixa 250.000..100.000.000.                      |
| `--timeout-ms`        | inteiro 0..3600000                          | Padrão do perfil; zero desativa deadline.                          |
| `--no-frame-fallback` | sem valor                                   | Define `allowFrameFallback: false`.                                |
| `--force`             | sem valor                                   | Permite substituir o arquivo de `--output`.                        |
| `--pretty`            | sem valor                                   | Indenta JSON com dois espaços.                                     |
| `--help`              | sem valor                                   | Imprime o descritor JSON e encerra com código 0.                   |

As faixas são validadas pela mesma camada da API. Um valor numericamente legível, mas fora da faixa ou não inteiro quando exigido, gera um resultado `INVALID_OPTIONS`.

Opções disponíveis somente na API e não expostas pela CLI:

- `minDocumentAreaRatio`;
- `requestHeaders`;
- `signal`.

## Regras de arquivo e formato

### Inferência por extensão

As extensões reconhecidas são:

| Extensão        | Formato |
| --------------- | ------- |
| `.png`          | PNG     |
| `.jpg`, `.jpeg` | JPEG    |
| `.webp`         | WebP    |
| `.pdf`          | PDF     |

Quando a extensão é reconhecida e `--format` informa outro contêiner, a CLI rejeita os argumentos. Para uma extensão desconhecida, o formato padrão é PNG, a menos que `--format` seja explícito.

### Proteção contra substituição

Sem `--force`, o arquivo é aberto em modo exclusivo. Se já existir, a CLI não o altera e devolve `PROCESSING_ERROR`. Com `--force`, a escrita pode substituir o destino.

A escrita ocorre somente quando `scanDocument` devolve `success: true`, incluindo status `partial`.

## Cantos manuais

```bash
cerne-scanner ./foto.jpg --output ./scan.png --corners "120,80;1820,110;1760,1320;90,1290"
```

Os quatro pares são interpretados como `topLeft`, `topRight`, `bottomRight` e `bottomLeft`. O núcleo reordena e valida o quadrilátero, mas forneça a ordem documentada para manter o comando legível. Coordenadas são da imagem depois da orientação EXIF, não do raster reduzido de detecção.

## JSON de resposta

### Saída textual

Com `--encoding`, a CLI imprime o `ScanResult` completo. Exemplo estrutural abreviado:

```json
{
  "status": "success",
  "success": true,
  "confidence": 0.82,
  "data": "...base64...",
  "output": {
    "format": "jpeg",
    "encoding": "base64",
    "mimeType": "image/jpeg",
    "byteLength": 123456,
    "width": 1654,
    "height": 2339
  },
  "detection": {},
  "metadata": {},
  "warnings": [],
  "error": null
}
```

### Saída em arquivo

Com `--output`, `data` é omitido do JSON e a CLI acrescenta:

```json
{
  "outputWritten": true
}
```

Os demais campos de resultado permanecem disponíveis. `outputWritten` acompanha `result.success` depois que a escrita terminou sem erro.

### Erro de argumentos

Falhas de parsing usam a forma:

```json
{
  "status": "error",
  "success": false,
  "error": {
    "code": "INVALID_INPUT",
    "message": "..."
  }
}
```

Opção desconhecida, falta de valor, quantidade de fontes diferente de uma e combinação inválida de saída terminam antes do scanner.

## Códigos de saída do processo

| Código | Condição                                                                            |
| -----: | ----------------------------------------------------------------------------------- |
|    `0` | Ajuda, ou scan com `result.success: true`, inclusive `partial`.                     |
|    `1` | Argumentos inválidos, erro de processamento/escrita ou outro resultado sem sucesso. |
|    `2` | `status: "not_found"`.                                                              |

Não use apenas o código 0 para concluir que a folha foi detectada integralmente: examine `status`. `partial` sai com código 0 porque há um artefato produzido.

## Exemplos operacionais

### JPEG com qualidade explícita

```bash
cerne-scanner ./entrada.png --output ./saida.jpg --quality 88 --enhancement color --pretty
```

### PDF A4 em preto e branco

```bash
cerne-scanner ./foto.webp --output ./documento.pdf --paper-size a4 --enhancement black-white
```

Nesse modo, o PDF incorpora PNG binário em vez de raster JPEG; `--quality` não altera essa imagem lossless.

### Data URL para integração textual

```bash
cerne-scanner ./foto.jpg --encoding data-url --format webp --quality 82
```

### Detecção mais completa sem fallback de quadro

```bash
cerne-scanner ./foto.jpg --output ./scan.png --performance accurate --no-frame-fallback
```

### Arquivo existente com substituição intencional

```bash
cerne-scanner ./foto.jpg --output ./scan.png --force
```

## Uso em automação

- Leia somente `stdout` como JSON.
- Trate códigos 0, 1 e 2 separadamente.
- Em código 0, diferencie `success` de `partial` pelo campo `status`.
- Não registre o campo `data` quando ele contiver documento sensível.
- Prefira `--output` para arquivos grandes: Base64 aumenta o tamanho textual e mantém a string na memória.
- Gere nomes de saída exclusivos quando vários processos rodarem em paralelo.
- A CLI não aceita cabeçalhos HTTP; para uma URL autenticada, use a API programática com `requestHeaders`, valide protocolo, origem e destinos de rede e não registre credenciais nem o conteúdo processado.

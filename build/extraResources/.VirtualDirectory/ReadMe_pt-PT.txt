# Guia do Diretório Virtual

## Visão Geral

`.VirtualDirectory` é um diretório virtual gerado automaticamente por esta aplicação, utilizado para exibir uma estrutura de arquivos organizada inteligentemente. Mantém uma correspondência um-para-um com os arquivos originais, mas utiliza convenções de nomenclatura inteligentes.

## Objetivo

O principal objetivo deste diretório virtual é permitir o gerenciamento de arquivos multidimensional. Quando estiver satisfeito com o resultado final, você pode copiar os arquivos dentro deste diretório para qualquer localização para a próxima geração do diretório virtual.

## Características

Os arquivos no diretório virtual podem ser simplesmente entendidos como referências ou aliases de arquivos, com as seguintes características:

1. Não ocupa espaço adicional no disco físico
2. Compartilha os mesmos blocos de dados com os arquivos originais
3. Modificações nos arquivos serão sincronizadas com os arquivos originais
4. Excluir arquivos não afetará os arquivos originais
5. Se o arquivo original for excluído, este arquivo efetivamente substitui o arquivo original e também deve ser excluído
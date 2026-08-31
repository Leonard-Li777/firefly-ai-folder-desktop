# Instrucciones del Directorio Virtual

## Descripción General

`.VirtualDirectory` es un directorio virtual generado automáticamente por esta aplicación, utilizado para mostrar una estructura de archivos organizada inteligentemente. Mantiene una correspondencia uno a uno con los archivos originales, pero utiliza convenciones de nomenclatura inteligentes.

## Propósito

El propósito principal de este directorio virtual es permitir la gestión de archivos multidimensional. Cuando esté satisfecho con el resultado final, puede copiar los archivos dentro de este directorio a cualquier ubicación para la próxima generación del directorio virtual.

## Características

Los archivos en el directorio virtual pueden entenderse simplemente como referencias o alias de archivos, con las siguientes características:

1. No ocupa espacio adicional en el disco físico
2. Comparte los mismos bloques de datos con los archivos originales
3. Las modificaciones a los archivos se sincronizarán con los archivos originales
4. Eliminar archivos no afectará los archivos originales
5. Si el archivo original se elimina, este archivo reemplaza efectivamente al archivo original y también debe eliminarse
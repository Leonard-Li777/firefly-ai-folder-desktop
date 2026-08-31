# Instructions du Répertoire Virtuel

## Aperçu

`.VirtualDirectory` est un répertoire virtuel généré automatiquement par cette application, utilisé pour afficher une structure de fichiers intelligemment organisée. Il maintient une correspondance un-à-un avec les fichiers originaux, mais utilise des conventions de nommage intelligentes.

## Objectif

L'objectif principal de ce répertoire virtuel est de permettre une gestion de fichiers multidimensionnelle. Lorsque vous êtes satisfait du résultat final, vous pouvez copier les fichiers de ce répertoire vers n'importe quel emplacement pour la prochaine génération de répertoire virtuel.

## Caractéristiques

Les fichiers du répertoire virtuel peuvent être simplement compris comme des références ou des alias de fichiers, avec les caractéristiques suivantes :

1. Aucun espace disque physique supplémentaire n'est occupé
2. Partage les mêmes blocs de données avec les fichiers originaux
3. Les modifications apportées aux fichiers seront synchronisées avec les fichiers originaux
4. La suppression de fichiers n'affectera pas les fichiers originaux
5. Si le fichier original est supprimé, ce fichier remplace effectivement le fichier original et devrait également être supprimé
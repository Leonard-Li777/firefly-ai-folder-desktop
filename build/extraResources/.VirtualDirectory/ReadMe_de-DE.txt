# Anleitung für Virtuelles Verzeichnis

## Übersicht

`.VirtualDirectory` ist ein automatisch generiertes virtuelles Verzeichnis dieser Anwendung, das zur Anzeige einer intelligent organisierten Dateistruktur verwendet wird. Es behält eine Eins-zu-Eins-Beziehung zu den Originaldateien bei, verwendet jedoch intelligente Benennungskonventionen.

## Zweck

Der Hauptzweck dieses virtuellen Verzeichnisses ist die Ermöglichung einer mehrdimensionalen Dateiverwaltung. Wenn Sie mit dem Endergebnis zufrieden sind, können Sie die Dateien in diesem Verzeichnis an einen beliebigen Ort kopieren, um die nächste virtuelle Verzeichnisgenerierung durchzuführen.

## Merkmale

Die Dateien im virtuellen Verzeichnis können einfach als Dateireferenzen oder Aliase verstanden werden und haben folgende Eigenschaften:

1. Kein zusätzlicher physikalischer Speicherplatz wird beansprucht
2. Gemeinsame Nutzung derselben Datenblöcke mit den Originaldateien
3. Änderungen an Dateien werden mit den Originaldateien synchronisiert
4. Das Löschen von Dateien beeinflusst die Originaldateien nicht
5. Wenn die Originaldatei gelöscht wird, ersetzt diese Datei effektiv die Originaldatei und sollte ebenfalls gelöscht werden
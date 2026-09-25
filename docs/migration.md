# Migrazioni e compatibilità

## Principi

- Il modello memoria e gli endpoint hanno versione esplicita quando il significato cambia.
- Le revisioni esistenti non vengono modificate retroattivamente.
- Le migrazioni devono essere idempotenti e eseguibili su un’istanza già avviata.
- Ogni modifica a contratti OpenAPI, MCP o export deve aggiornare test e changelog.

## Modello dati

Le modifiche a tabelle PostgreSQL devono mantenere la compatibilità con le versioni supportate oppure fornire una procedura di migrazione e un backup verificato. Le proiezioni Redis e Neo4j possono essere ricostruite dopo una migrazione autoritativa.

## API e MCP

Prima di rimuovere un endpoint o un tool:

1. annunciare la deprecazione nel changelog;
2. mantenere il comportamento per la finestra di supporto;
3. fornire una alternativa o una procedura di migrazione;
4. rimuovere il simbolo solo in una versione maggiore.

## Release e rollback

Prima di ogni release eseguire la checklist di `RELEASING.md`, salvare un export canonico e un dump PostgreSQL verificato. Il rollback deve usare un database target separato, ricostruire le proiezioni e verificare readiness prima di rientrare nel traffico.

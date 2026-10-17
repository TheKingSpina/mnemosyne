# Privacy e gestione dei dati

## Dati locali

PostgreSQL conserva sessioni, eventi, memorie, revisioni, conflitti, job e forget ledger. I dati vengono esclusi dalla persistenza quando il forget viene confermato, fatta eccezione per il forget ledger minimo necessario a proteggere i restore futuri.

Redis contiene una cache derivata e Neo4j contiene una proiezione ricostruibile. Devono essere svuotati o ricostruiti durante il recovery e non sono fonti autorevoli.

## Provider esterni

Il worker locale non chiama provider remoti. Se sono configurati `OPENROUTER_API_KEY` e `OPENROUTER_MODEL`, il testo necessario all’estrazione può essere inviato al provider selezionato. L’operatore deve verificare:

- finalità e base giuridica del trattamento;
- periodo di retention del provider;
- localizzazione e eventuali sotto-processori;
- necessità di disattivare il provider remoto;
- idoneità dei dati prima dell’invio.

L’analizzatore di potatura aggiunge un secondo percorso di egress, spento per default e
per natura diverso dall’estrazione: non invia eventi di sessione, ma batch con flag
uniforme di memorie marcate a mano dal proprietario (`local_only` mai, `anonymized` come
riassunto volutamente lossy senza identificatori né contenuto grezzo, `public` intero).
Nessuna inferenza del flag, mai marcature mescolate nello stesso batch. Le sue proposte
non scrivono sulle memorie: l’esecuzione la decide la retention col veto deterministico.
La checklist qui sopra vale a maggior ragione, perché riguarda testo già concentrato,
non chat.

Il progetto non abilita telemetria remota.

## Esportazione

Gli export canonici e i dump PostgreSQL possono contenere dati personali. Devono essere trattati come artefatti sensibili, cifrati quando necessario e copiati solo su storage protetto. I manifest contengono metadati operativi e conteggi, non il contenuto del corpus.

## Retention

La retention applicativa rimuove eventi, candidate e snapshot secondo il profilo configurato. Non rimuove il forget ledger. La retention dei file di backup è separata e viene eseguita dal tooling solo per artifact riconosciuti e verificati.

## Responsabilità dell’operatore

L’operatore deve proteggere host, accessi, token, chiavi, backup, log, browser, rete e provider. Prima di un deployment remoto deve applicare HTTPS, rete privata, policy di retention e un piano di risposta agli incidenti.

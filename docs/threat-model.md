# Threat model

## Obiettivo

Mnemosyne conserva memoria governata per un singolo operatore e per harness LLM autorizzati. Il confine primario è l’instanza self-hosted: l’operatore è responsabile di host, rete, TLS, backup e gestione dei secret.

## Asset protetti

- memorie, revisioni, eventi e forget ledger in PostgreSQL;
- token owner e harness;
- forget secret e chiavi provider;
- export canonici e dump PostgreSQL;
- configurazione di rete e credenziali del deployment;
- integrità delle proiezioni Redis e Neo4j.

## Sorgenti di fiducia

- PostgreSQL è l’archivio autorevole.
- API, worker e MCP applicano la stessa policy di autorizzazione.
- Redis e Neo4j sono derivati e ricostruibili.
- OpenRouter o altri provider ricevono solo dati necessari all’estrazione e solo quando abilitati.
- Il contenuto delle conversazioni è dati non fidati, mai istruzioni di sistema.

## Minacce e mitigazioni

| Minaccia                                       | Mitigazione                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Token harness usato per operazioni owner       | Permessi server-side e binding del profilo alla sessione MCP HTTP                                      |
| Sessione MCP riutilizzata con identità diverse | Confronto del profilo prima di body parsing e dispatch per POST, GET e DELETE                          |
| Segreti nel contenuto                          | Pattern di rilevamento, rifiuto delle proposal e divieto di provider non autorizzato                   |
| Dimenticanza incompleta                        | Rimozione atomica della memoria, delle revisioni, dei feedback e aggiornamento dei conflitti correlati |
| Cache o proiezione obsolete                    | Revisione del corpus, invalidazione e ricostruzione dei dati derivati                                  |
| Ripristino su database non vuoto               | Restore operativo in un database target separato con conferma esplicita                                |
| Backup alterato o non recuperabile             | Manifest, SHA-256, cifratura autenticata opzionale e restore verificato                                |
| Accesso remoto diretto                         | Binding locale, rete privata, TLS e token separati                                                     |
| Dati reali nel repository                      | `.gitignore`, `.dockerignore`, secret scan e test sintetici                                            |

## Limiti noti

- Il progetto non gestisce da solo host, firewall, TLS, NAS, cloud storage o rotazione delle chiavi.
- Un backup locale non è un disaster recovery se manca una copia protetta esterna.
- La CI non sostituisce una revisione legale delle licenze o un audit penetration test.
- Le sessioni MCP HTTP sono process-local; con più repliche serve sticky routing finché non esiste uno store condiviso del transport.
- Il provider LLM riceve dati solo se l’operatore lo abilita; la scelta del provider e la sua retention restano responsabilità dell’operatore.

## Verifica minima

Prima di un rilascio pubblico eseguire test di autorizzazione, forget, ripristino, secret scan, build delle immagini, scansione delle immagini e E2E con dati sintetici.

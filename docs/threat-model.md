# Threat model

## Obiettivo

Mnemosyne conserva memoria governata per un singolo operatore e per harness LLM autorizzati. Il confine primario è l’instanza self-hosted: l’operatore è responsabile di host, rete, TLS, backup e gestione dei secret.

## Asset protetti

- memorie, revisioni, eventi e forget ledger in PostgreSQL;
- token owner e harness;
- token per client emessi e le loro revoghe;
- forget secret e chiavi provider;
- export canonici e dump PostgreSQL;
- configurazione di rete e credenziali del deployment;
- integrità delle proiezioni Redis e Neo4j.

## Sorgenti di fiducia

- PostgreSQL è l’archivio autorevole.
- API, worker e MCP applicano la stessa policy di autorizzazione.
- I token statici del deployment restano autorità anche quando esistono token per client: la policy prova prima quelli e usa i secondi solo se i primi non risolvono.
- Redis e Neo4j sono derivati e ricostruibili.
- OpenRouter o altri provider ricevono solo dati necessari all’estrazione e solo quando abilitati.
- Il contenuto delle conversazioni è dati non fidati, mai istruzioni di sistema.

## Minacce e mitigazioni

| Minaccia                                       | Mitigazione                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Token harness usato per operazioni owner       | Permessi server-side e binding del profilo alla sessione MCP HTTP                                                  |
| Sessione MCP riutilizzata con identità diverse | Confronto del profilo prima di body parsing e dispatch per POST, GET e DELETE                                      |
| Segreti nel contenuto                          | Pattern di rilevamento, rifiuto delle proposal e divieto di provider non autorizzato                               |
| Dimenticanza incompleta                        | Rimozione atomica della memoria, delle revisioni, dei feedback e aggiornamento dei conflitti correlati             |
| Cache o proiezione obsolete                    | Revisione del corpus, invalidazione e ricostruzione dei dati derivati                                              |
| Ripristino su database non vuoto               | Restore operativo in un database target separato con conferma esplicita                                            |
| Backup alterato o non recuperabile             | Manifest, SHA-256, cifratura autenticata opzionale e restore verificato                                            |
| Accesso remoto diretto                         | Binding locale, rete privata, TLS e token separati                                                                 |
| Token per client divulgato                     | Nel database finisce solo l’hash SHA-256 più un prefisso; il testo in chiaro esiste una volta e non è recuperabile |
| Client concesso che dovrebbe essere revocato   | Revoca per nome che invalida l’hash immediatamente, indipendente dai token statici e dagli altri client            |
| Riuso di un nome client attivo                 | `409` invece di rotazione silenziosa, per non invalidare una credenziale già in uso                                |
| Credenziale emessa ripresa in un log di replay | Le route credenziali sono escluse dal percorso idempotente, quindi il token non finisce in `idempotency_keys`      |
| Header malformato su un endpoint anonimo       | Una credenziale presente viene sempre verificata: `401` esplicito invece di un downgrade silenzioso                |
| Dati reali nel repository                      | `.gitignore`, `.dockerignore`, secret scan e test sintetici                                                        |

## Limiti noti

- Il progetto non gestisce da solo host, firewall, TLS, NAS, cloud storage o rotazione delle chiavi.
- Un backup locale non è un disaster recovery se manca una copia protetta esterna.
- La CI non sostituisce una revisione legale delle licenze o un audit penetration test.
- Le sessioni MCP HTTP sono process-local; con più repliche serve sticky routing finché non esiste uno store condiviso del transport.
- Con `MNEMOSYNE_MCP_REQUIRE_TOKEN=false` il perimetro è la ACL del tailnet, non l’applicazione: ogni dispositivo autorizzato sul tailnet raggiunge l’endpoint. Con `MNEMOSYNE_MCP_ANONYMOUS_PROFILE=harness` i tool distruttivi non vengono registrati, ma chi può raggiungere il servizio può comunque aprire sessioni, proporre memorie e leggerle.
- I token per client hanno tutti ruolo `owner`: emetterne uno equivale a dare il massimo privilegio. Un ruolo intermedio richiederebbe un modello di permessi per utente, non ancora presente.
- Un token emesso non può essere recuperato in caso di perdita: va riemesso, e riemettere con lo stesso nome è una rotazione.
- Il provider LLM riceve dati solo se l’operatore lo abilita; la scelta del provider e la sua retention restano responsabilità dell’operatore.

## Verifica minima

Prima di un rilascio pubblico eseguire test di autorizzazione, forget, ripristino, secret scan, build delle immagini, scansione delle immagini e E2E con dati sintetici.

Quando l’autenticazione MCP è disattivata, il perimetro non è più codificato qui dentro ma in una ACL esterna: va verificato che i dispositivi ammessi sul tailnet siano quelli previsti, e va ripetuta la verifica dopo ogni revisione della configurazione del deployment.

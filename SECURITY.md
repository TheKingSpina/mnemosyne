# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Report it privately to the project maintainer through GitHub's private vulnerability reporting feature for this repository. Include:

- affected version or commit;
- reproduction steps using synthetic data only;
- impact and affected component;
- any suggested mitigation.

Do not include real credentials, conversations, memory contents, or backup files.

## Security boundaries

- The software is self-hosted; the operator is responsible for host and network security.
- Do not expose the development API or MCP server directly to the Internet.
- Use authenticated private networking and TLS for remote access.
- REST and Streamable HTTP use separate `MNEMOSYNE_OWNER_TOKEN` and `MNEMOSYNE_HARNESS_TOKEN` credentials; do not run either interface unauthenticated.
- Streamable HTTP sessions are bound to the authenticated owner or harness profile, expire when idle, and reject untrusted origins when `MCP_ALLOWED_HOSTS` or `MCP_ALLOWED_ORIGINS` is configured. Session state is process-local; use one replica or sticky routing.
- Administrative operations are authorized server-side; hiding a tool from a client is not treated as access control.
- The owner web console is an administrative surface; keep it local or behind the same private network and HTTPS controls as the API. It proxies API calls server-side and keeps the owner token in browser session storage, not local storage.
- Keep provider keys and forget secrets outside the repository and database.
- Use synthetic data in tests and reports.
- Back up PostgreSQL securely and test restoration regularly.
- `npm run backup:postgres` supports verified publication, optional authenticated
  encryption, manifests, checksums, and retention. Use `npm run restore:postgres`
  only with an explicit target database and a verified artifact.
- Keep the passphrase file outside the repository and copy verified artifacts to
  protected external storage before relying on them operationally.

## Supported versions

La versione `0.1.0` è il primo candidato supportato. Le versioni future saranno elencate qui dopo il tag di release; `main` rimane il canale di sviluppo. La checklist e le procedure sono in [`RELEASING.md`](RELEASING.md).

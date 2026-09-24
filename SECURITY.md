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
- Administrative operations are authorized server-side; hiding a tool from a client is not treated as access control.
- The owner web console is an administrative surface; keep it local or behind the same private network and HTTPS controls as the API.
- Keep provider keys and forget secrets outside the repository and database.
- Use synthetic data in tests and reports.
- Back up PostgreSQL securely and test restoration regularly.

## Supported versions

The security policy for released versions will be maintained here as the project reaches its first release. Until then, use the latest `main` commit only for development and do not treat it as a production release.

# Security Policy

Report vulnerabilities in Theorem privately so maintainers can investigate before public disclosure.
This policy covers the code in this repository, including the agents and React packages.

## Supported Versions

Use the latest stable release of each package to receive security fixes.

| Version | Security updates |
| --- | --- |
| Latest stable release | Supported |
| Earlier releases | Not supported |
| Prereleases and unreleased code | Not supported |

Please report vulnerabilities in earlier releases if they also affect the latest stable release.

## Reporting a Vulnerability

Please submit a report through [GitHub private vulnerability reporting](https://github.com/masudl-hub/theoremai/security/advisories/new).
Do not include vulnerability details in public issues, discussions, or pull requests.

Include the following details when available:

- The affected package, version, and runtime.
- A description of the vulnerability and its security impact.
- The configuration needed to reproduce it.
- Reproduction steps or a minimal example.
- Relevant logs with credentials and personal data removed.
- Any known workaround or suggested fix.

Use test credentials and synthetic data in examples.
If the issue affects an application that uses Theorem, identify the behavior that comes from Theorem.

## What to Expect

Maintainers aim to acknowledge reports within 7 days and provide updates every 14 days while a report remains open.
These are response targets, not guaranteed deadlines.

Maintainers review the report and ask for more details when needed.
If they accept it, they coordinate a fix and disclosure with you through the private report.
If they decline it, they explain the reason in the private report.

Please coordinate public disclosure with maintainers so users can receive a fix or mitigation first.

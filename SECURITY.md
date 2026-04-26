# Security

## Reporting a vulnerability

If you discover a security vulnerability in 2200, please report it privately rather than opening a public issue.

**Email:** doug@mrdoug.com

We aim to acknowledge reports within 72 hours and coordinate disclosure once a fix is available.

## Scope

In scope:

- The 2200 runtime (supervisor, Agent loop, Identity loader, Brain, baseline tools, plan/run/perm wrapping).
- The Skill ingestion pipeline.
- The Extensions framework and its permission model.
- Credential storage, SecretRef indirection, and the model-provider abstraction.
- Bundled MCP servers shipped as part of the baseline tool set.
- The mobile and web client API surfaces (when those land).

Out of scope:

- Issues caused by user-modified runtime code, where the issue does not exist in unmodified upstream.
- Issues in [OpenPub](https://github.com/douglashardman/openpub) or [OpenSCUT](https://github.com/douglashardman/openscut) at the protocol layer; report those upstream.
- Third-party MCP servers not bundled with 2200.
- Self-hosted instances running outside the supported deployment patterns.

## What to include in a report

- Affected version (commit SHA or release tag)
- Reproduction steps
- Impact assessment (data exposure, privilege escalation, service disruption, etc.)
- Suggested mitigation if you have one

## Coordinated disclosure

The standing posture is coordinated disclosure with a 90-day window from acknowledgement. Critical issues are handled with shorter windows when warranted. Researchers acting in good faith are credited in the changelog and any associated advisory.

## What 2200 commits to

- Acknowledge reports within 72 hours.
- Communicate clearly about validation, fix timeline, and disclosure.
- Credit researchers who follow this process.
- Publish security advisories with CVE assignment when applicable, after fixes are available.

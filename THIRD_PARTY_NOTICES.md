# Third-party notices

This file lists code lifted into 2200 from external projects, along with the upstream license and the portions covered.

Empty for now. Per the [License posture section in AGENTS.md](AGENTS.md#license-posture), every code-lift gets recorded here with:

- Source project, URL, and license
- Specific files or functions lifted
- Original copyright notice (preserved)
- Brief note on what was changed, if anything

## Format template

When a code-lift happens, add an entry like the following:

```
## <Source project>

- **URL:** https://github.com/<org>/<repo>
- **License:** <SPDX identifier>
- **Lifted:** <files or functions>
- **Original copyright:** Copyright (c) <year> <holder>
- **Notes:** <what changed, why we lifted, what we adapted>
```

## Pattern lifts (no obligation, listed for credit)

These are architectural patterns lifted by understanding rather than by code copy. Not legally required to list, but credit is given where credit is due.

- **OpenClaw** (MIT, Copyright 2025 Peter Steinberger): supervisor model, plan/run/perm wrapping discipline, Skills runtime model, baseline tool shape, profile/state-dir affordance, BOOT.md per-Agent ritual.
- **Perplexity Computer** (closed source, public materials only): "always-on helpful Agent" UX shape, integration health monitoring patterns.

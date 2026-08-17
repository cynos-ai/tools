# Compatibility matrix

Tools supports Node.js `>=22` and the following Pi host ranges:

| Host baseline | `@earendil-works/pi-coding-agent` | `@earendil-works/pi-tui` | Purpose |
| --- | --- | --- | --- |
| Minimum | `0.80.2` | `0.80.2` | Lowest version allowed by the published peer range |
| Current | `0.80.10` | `0.80.10` | Version pinned by the development lockfile |
| Latest | npm `latest` | npm `latest` | Early warning for the newest published host |

The compatibility workflow runs the minimum and current baselines on Node 22
and Node 24. It runs the floating `latest` host on Node 24. Every cell installs
the requested Pi host before running typecheck, unit tests, build smoke, package
validation, and the production dependency audit.

`latest` is intentionally a scheduled/manual signal rather than a required
branch-protection check: a new upstream Pi release must not block an unrelated
Tools pull request. A failure still requires investigation before updating the
supported-current baseline.

When the Pi peer range or development dependency changes, update this table and
`.github/workflows/compatibility.yml` in the same change.

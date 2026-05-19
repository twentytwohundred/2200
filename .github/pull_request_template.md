## Summary

<!-- One paragraph: what this PR does and why. Focus on the why. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor (no behavior change)
- [ ] Documentation update
- [ ] Decision record
- [ ] Tooling / infrastructure
- [ ] Security fix

## Related epic / decision record

<!-- Link to the wiki epic spec, the decision record, or the issue this PR implements. -->

## Upgrade-readiness check

For changes touching persisted state, runtime processes, Extensions, credentials, internal APIs, or task handling, confirm the relevant disciplines from the [upgrade-readiness convention](https://github.com/twentytwohundred/wiki/blob/main/conventions/upgrade-readiness.md):

- [ ] Schema versioning applied to any new persisted artifact
- [ ] State-on-disk discipline preserved
- [ ] Restart-safe behavior verified
- [ ] Extension version compatibility declared (if applicable)
- [ ] Credential indirection (SecretRef) used (if applicable)
- [ ] Idempotent task handling preserved
- [ ] Versioned internal APIs respected (if applicable)

## License posture

- [ ] No code lifted from external projects, OR
- [ ] Code lifts are recorded in `THIRD_PARTY_NOTICES.md` with upstream license and original copyright notice preserved

## Test plan

- [ ] Unit tests added or updated
- [ ] Integration tests added or updated
- [ ] Manual verification (describe below)

<!-- Manual verification notes: -->

## Screenshots / Recordings

<!-- For UI changes. Skip otherwise. -->

## Co-author trailer

<!-- For work done with Claude assistance, include in commits:
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
-->

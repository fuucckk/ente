# Ensu release process

> The following assumes main is `0.1.16-beta`, we want to release `0.1.16` and move main to `0.1.17-beta`.

## Normal development

Nightly builds of `main` are automatically created every weekday morning (IST), and can also be created by running the workflow manually. These builds are attached to the `ensu-v0.1.16-beta` prerelease; each nightly keeps updating the same prerelease.

## Cut a release branch

```sh
git switch main
git pull
git switch -c release/ensu-v0.1.16
git push -u origin release/ensu-v0.1.16
```

Pushing the release branch creates a new build, updating the `ensu-v0.1.16-beta` prerelease.

Scheduled nightly builds are skipped while a release branch exists.

## Move main to next beta

```bash
git switch main
git pull
git switch -c ensu-v0.1.17-beta
node .github/scripts/ensu-version.mjs set --version 0.1.17 --channel beta
git commit -am "Start Ensu 0.1.17 beta"
git push -u origin ensu-v0.1.17-beta
```

Open and merge a PR from `ensu-v0.1.17-beta` into `main`.

## Candidate builds during QA

Cherry pick fixes to the release branch and push to trigger a new build.

```bash
git switch release/ensu-v0.1.16
git cherry-pick <fix-sha>
git push
```

The push updates the `ensu-v0.1.16-beta` prerelease.

## Promote release

First change the local release branch to stable:

```bash
git switch release/ensu-v0.1.16
node .github/scripts/ensu-version.mjs set --version 0.1.16 --channel stable
git commit -am "Mark Ensu 0.1.16 stable"
```

Then tag that commit and push the tag:

```bash
git tag ensu-v0.1.16
git push origin ensu-v0.1.16
```

The workflow creates draft release `ensu-v0.1.16` and removes
`ensu-v0.1.16-beta`.

## Cleanup

Remove the release branch to resume normal nightly builds of `main`.

```sh
git push origin --delete release/ensu-v0.1.16
git branch -d release/ensu-v0.1.16
```

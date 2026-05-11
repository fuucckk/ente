# Ensu release process

> The following assumes main is `0.1.16-beta`, we want to release `0.1.16` and move main to `0.1.17-beta`.

## Normal development

Nightly builds of `main` are automatically created every weekday morning (IST), and can also be created by running the workflow manually. These builds are attached to the `ensu-v0.1.16-beta` prerelease; each nightly keeps updating the same prerelease.

## Cut a release branch

```sh
git switch main
git pull
git switch -c release/ensu-v0.1.16
git push -u origin HEAD
```

Pushing the release branch creates a new build, updating the `ensu-v0.1.16-beta` prerelease.

Scheduled nightly builds are skipped while a release branch exists.

## Move main to next beta

```bash
git switch main
git pull
git switch -c ensu-v0.1.17-beta
node .github/scripts/ensu-version.mjs set 0.1.17-beta
git commit -am "Start Ensu 0.1.17 beta"
git push -u origin HEAD
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

## Draft release

Tag the release branch commit you want to ship:

```bash
git switch release/ensu-v0.1.16
git pull
git tag ensu-v0.1.16
git push origin ensu-v0.1.16
```

The workflow creates draft release `ensu-v0.1.16`, removes `ensu-v0.1.16-beta`, and deletes the release branch.

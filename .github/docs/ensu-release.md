# Ensu release process

> The following assumes main is `0.1.16-beta`, we want to release `0.1.16` and move main to `0.1.17-beta`.

## Normal development

Nightly builds of `main` are automatically created every weekday morning (IST), and can also be created by running the `ensu-release` workflow manually. These builds are attached to the draft `ensu-v0.1.16-beta` GitHub release; each nightly keeps updating the same draft.

> [!NOTE]
>
> All builds (nightly and RC) are also uploaded to Play Store internal testing (Android) and TestFlight (iOS).

## Cut a release branch

```sh
git switch main
git pull
git switch -c release/ensu-v0.1.16
node .github/scripts/ensu-version.mjs set 0.1.16
git commit -am "Ensu v0.1.16"
git push -u origin HEAD
```

Pushing the release branch creates a draft `ensu-v0.1.16-rc` GitHub release (with a matching tag) and removes the `ensu-v0.1.16-beta` draft.

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

## Update the RC if needed

Cherry pick fixes to the release branch and push to replace the current RC.

```bash
git switch release/ensu-v0.1.16
git cherry-pick <fix-sha>
git push
```

## Finalize release

Run the workflow on the release branch with the `finalize` flag:

```bash
gh workflow run ensu-release.yml --ref release/ensu-v0.1.16 -f finalize=true
```

This does not create another build. It tags the RC commit as `ensu-v0.1.16`, moves the GitHub draft from `ensu-v0.1.16-rc` to `ensu-v0.1.16`, removes the RC tag, and deletes the release branch.

## Retries

The workflow is safe to retry for transient failures.

Nightly and RC runs update fixed drafts (`ensu-v0.1.16-beta` and `ensu-v0.1.16-rc`). Re-running failed jobs, or triggering the workflow again, updates the same draft.

Finalize does not build. It can be re-run on the release branch until it succeeds; branch deletion is the last step.

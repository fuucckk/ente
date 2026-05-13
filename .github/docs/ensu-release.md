# Ensu release process

> The following assumes main is `0.1.16-beta`, we want to release `0.1.16` and move main to `0.1.17-beta`.

## Normal development

Nightly builds of `main` are automatically created every weekday morning (IST), and can also be created by running `ensu-build.yml` manually. These builds are attached to the draft `ensu-v0.1.16-beta` GitHub release; each nightly keeps updating the same draft.

> [!NOTE]
>
> All builds (nightly and RC) are also uploaded to Play Store internal testing (Android) and TestFlight (iOS).

## Start release

```bash
gh workflow run ensu-release.yml \
  -f action=start \
  -f version=0.1.16
```

This removes the `ensu-v0.1.16-beta` draft and tag, then:

1. Creates `release/ensu-v0.1.16` with the version set to `0.1.16`
2. Pushes the branch, which triggers `ensu-build.yml` and creates the draft `ensu-v0.1.16-rc` release

The workflow also opens a PR to move `main` to `0.1.17-beta`. Merge that PR after it is created. Scheduled nightlies are skipped while the release branch exists.

## Update the RC if needed

Cherry pick fixes to the release branch and push to replace the current RC.

```bash
git switch release/ensu-v0.1.16
git cherry-pick <fix-sha>
git push
```

## Finalize release

```bash
gh workflow run ensu-release.yml \
  -f action=finalize \
  -f version=0.1.16
```

This does not create another build. It tags the last RC commit as `ensu-v0.1.16`, moves the GitHub draft from `ensu-v0.1.16-rc` to `ensu-v0.1.16`, removes the RC tag, and deletes the release branch.

## Retries

Both workflows are safe to retry for transient failures.

For `ensu-build.yml`, both nightly or RC builds update fixed drafts (`ensu-v0.1.16-beta` and `ensu-v0.1.16-rc`). Re-running failed jobs, or triggering `ensu-build.yml` again, updates the same draft.

For `ensu-release.yml`, retries resume the same release state. `action=start` keeps using the existing release branch and next-beta PR. `action=finalize` does not build, and deletes the release branch only after the final draft is ready.
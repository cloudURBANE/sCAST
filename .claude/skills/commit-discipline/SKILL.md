---
name: commit-discipline
description: Create small verified commits for one logical task while excluding unrelated work and summarizing exact files and reasons. Use after a requested fix is verified and before committing or pushing in a dirty or shared repository.
---

# Commit One Verified Change

Goal: produce a reviewable commit that contains one completed, verified task.

1. Finish one logical task and load safe-edit-verify.
2. Inspect git status and the complete diff.
3. Identify unrelated or pre-existing changes and leave them unstaged.
4. Stage only the files and hunks belonging to the task.
5. Review the staged diff and confirm it matches the evidence-backed fix.
6. Commit with a concise message describing the behavioral change.
7. Report the commit hash, exact files changed, why each changed, verification commands, and remaining risks.

Do not combine cleanup, formatting churn, generated noise, or another task with the fix. Do not amend, rebase, push, or alter another contributor's work unless explicitly authorized. If commits are not requested or not part of the established workflow, stop after a verified diff and provide the same file-and-reason summary.

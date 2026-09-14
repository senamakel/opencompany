//! Giving each dispatched task its own checkout.
//!
//! ## Why not one shared directory
//!
//! block/buzz points every local agent at one `REPOS` directory and relies on
//! there being effectively one live workspace at a time. That does not survive
//! this product's headline requirement: N connected hosts means N companies can
//! dispatch work to this machine at once, and two agents editing one tree is a
//! data race with no attribution — whoever wrote last wins, and neither task's
//! diff means anything afterwards.
//!
//! It also makes `parallelism` a lie. Configuring three concurrent workers is
//! pointless if the filesystem caps you at one.
//!
//! A worktree per task fixes all three: concurrent tasks cannot collide, each
//! has a branch and therefore a reviewable diff, and cancelling one is a
//! discard rather than an unpick.
//!
//! ## What is deliberately not automatic
//!
//! **Nothing with uncommitted changes is ever removed.** A task that failed
//! half way has left the only copy of whatever it did, and reclaiming disk is
//! never worth destroying that. `release` refuses, says so, and leaves the
//! directory for a person.
//!
//! A target that is not a git repository is **not** an error either. Plenty of
//! real work happens outside version control, and refusing it would make the
//! feature unavailable exactly where an operator is most likely to be
//! experimenting. Such a task gets a plain directory and no isolation
//! guarantee, which is reported rather than hidden.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum WorktreeError {
    #[error("git failed: {0}")]
    Git(String),
    #[error("could not prepare {path}: {reason}")]
    Io { path: PathBuf, reason: String },
    #[error("{path} has uncommitted changes and was left alone")]
    Dirty { path: PathBuf },
}

/// How a task's directory was obtained.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Isolation {
    /// A real git worktree on its own branch. Concurrent tasks cannot collide.
    Worktree,
    /// A plain directory, because the target is not a git repository. Usable,
    /// but two tasks pointed at it would interfere — reported so the console
    /// can say so rather than implying a guarantee that is not there.
    PlainDirectory,
}

/// A directory a task works in.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkspace {
    pub path: PathBuf,
    pub isolation: Isolation,
    /// The branch created for this task, when it is a worktree.
    pub branch: Option<String>,
}

/// Prepares a workspace for `task_id` from `repo`.
///
/// `root` is where worktrees are kept — one directory per (connection, company,
/// task), so two hosts dispatching a task of the same name cannot land in one
/// place.
pub async fn acquire(
    root: &Path,
    repo: &Path,
    task_id: &str,
) -> Result<TaskWorkspace, WorktreeError> {
    let path = root.join(task_id);
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|e| WorktreeError::Io {
            path: root.to_path_buf(),
            reason: e.to_string(),
        })?;

    if !is_git_repo(repo).await {
        tokio::fs::create_dir_all(&path)
            .await
            .map_err(|e| WorktreeError::Io {
                path: path.clone(),
                reason: e.to_string(),
            })?;
        return Ok(TaskWorkspace {
            path,
            isolation: Isolation::PlainDirectory,
            branch: None,
        });
    }

    let branch = format!("oc/{task_id}");
    // `-b` creates the branch, so two tasks never share one. A worktree that
    // already exists (a retried task) is reused rather than failing the run.
    if path.exists() {
        return Ok(TaskWorkspace {
            path,
            isolation: Isolation::Worktree,
            branch: Some(branch),
        });
    }
    git(
        repo,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            &path.display().to_string(),
        ],
    )
    .await?;

    Ok(TaskWorkspace {
        path,
        isolation: Isolation::Worktree,
        branch: Some(branch),
    })
}

/// Removes a task's workspace, **unless it holds uncommitted work**.
///
/// The refusal is the point. Reclaiming disk is never worth destroying the only
/// copy of what a failed task produced.
pub async fn release(repo: &Path, workspace: &TaskWorkspace) -> Result<(), WorktreeError> {
    if workspace.isolation == Isolation::PlainDirectory {
        // Never removed: nothing here tracked what was in it, so nothing here
        // can know whether it mattered.
        return Ok(());
    }
    if is_dirty(&workspace.path).await {
        return Err(WorktreeError::Dirty {
            path: workspace.path.clone(),
        });
    }
    git(
        repo,
        &["worktree", "remove", &workspace.path.display().to_string()],
    )
    .await?;
    Ok(())
}

async fn is_git_repo(path: &Path) -> bool {
    matches!(
        git(path, &["rev-parse", "--is-inside-work-tree"]).await,
        Ok(out) if out.trim() == "true"
    )
}

/// Whether a worktree holds changes nothing has recorded.
///
/// `--porcelain` covers untracked files too, which matters: a task whose whole
/// output is a new file has produced exactly one untracked entry and nothing
/// else, and treating that as clean would delete its only result.
async fn is_dirty(path: &Path) -> bool {
    match git(path, &["status", "--porcelain"]).await {
        Ok(out) => !out.trim().is_empty(),
        // Unreadable: assume dirty. The safe direction — refusing to remove
        // something we cannot inspect beats removing it.
        Err(_) => true,
    }
}

async fn git(cwd: &Path, args: &[&str]) -> Result<String, WorktreeError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| WorktreeError::Git(e.to_string()))?;
    if !output.status.success() {
        return Err(WorktreeError::Git(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(test)]
mod test {
    use super::*;

    async fn repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@t.test"],
            vec!["config", "user.name", "T"],
        ] {
            git(&repo, &args).await.unwrap();
        }
        std::fs::write(repo.join("README.md"), "hello").unwrap();
        git(&repo, &["add", "."]).await.unwrap();
        git(&repo, &["commit", "-q", "-m", "first"]).await.unwrap();
        (dir, repo)
    }

    #[tokio::test]
    async fn two_tasks_get_directories_that_cannot_collide() {
        // The whole reason this exists. Shared-directory designs put both of
        // these in one place and let whoever writes last win.
        let (dir, repo) = repo().await;
        let root = dir.path().join("work");

        let a = acquire(&root, &repo, "task-a").await.unwrap();
        let b = acquire(&root, &repo, "task-b").await.unwrap();

        assert_ne!(a.path, b.path);
        assert_eq!(a.isolation, Isolation::Worktree);
        assert_eq!(b.isolation, Isolation::Worktree);
        // A branch each, so each task's work is a reviewable diff.
        assert_ne!(a.branch, b.branch);

        // Genuinely independent trees: a write in one is invisible in the other.
        std::fs::write(a.path.join("only-a.txt"), "x").unwrap();
        assert!(!b.path.join("only-a.txt").exists());
    }

    #[tokio::test]
    async fn a_clean_worktree_is_removed_on_release() {
        let (dir, repo) = repo().await;
        let root = dir.path().join("work");
        let workspace = acquire(&root, &repo, "task-clean").await.unwrap();
        assert!(workspace.path.exists());

        release(&repo, &workspace)
            .await
            .expect("a clean tree is removed");
        assert!(!workspace.path.exists());
    }

    #[tokio::test]
    async fn uncommitted_work_is_never_destroyed() {
        // A task that failed half way has left the only copy of whatever it
        // did. Disk is cheaper than that.
        let (dir, repo) = repo().await;
        let root = dir.path().join("work");
        let workspace = acquire(&root, &repo, "task-dirty").await.unwrap();
        std::fs::write(
            workspace.path.join("README.md"),
            "edited but never committed",
        )
        .unwrap();

        let refused = release(&repo, &workspace).await;
        assert!(
            matches!(refused, Err(WorktreeError::Dirty { .. })),
            "{refused:?}"
        );
        assert!(workspace.path.exists(), "the work must still be there");
    }

    #[tokio::test]
    async fn a_brand_new_untracked_file_counts_as_work() {
        // A task whose whole output is one new file shows up only as an
        // untracked entry. A dirty check that ignored those would delete
        // exactly the tasks that succeeded.
        let (dir, repo) = repo().await;
        let root = dir.path().join("work");
        let workspace = acquire(&root, &repo, "task-new").await.unwrap();
        std::fs::write(workspace.path.join("result.md"), "the answer").unwrap();

        assert!(matches!(
            release(&repo, &workspace).await,
            Err(WorktreeError::Dirty { .. })
        ));
    }

    #[tokio::test]
    async fn a_target_that_is_not_a_repository_still_gets_a_directory() {
        // Plenty of real work is not in git, and refusing it would make this
        // unavailable where someone is most likely to be experimenting. The
        // weaker guarantee is reported rather than hidden.
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("not-a-repo");
        std::fs::create_dir_all(&plain).unwrap();

        let workspace = acquire(&dir.path().join("work"), &plain, "task-plain")
            .await
            .unwrap();
        assert_eq!(workspace.isolation, Isolation::PlainDirectory);
        assert!(workspace.branch.is_none());
        assert!(workspace.path.is_dir());

        // And releasing it removes nothing, because nothing here tracked what
        // was in it.
        release(&plain, &workspace).await.unwrap();
        assert!(workspace.path.exists());
    }

    #[tokio::test]
    async fn retrying_a_task_reuses_its_workspace() {
        // A retry must not fail because the previous attempt's directory is
        // still there — and must not silently start somewhere else either.
        let (dir, repo) = repo().await;
        let root = dir.path().join("work");
        let first = acquire(&root, &repo, "task-retry").await.unwrap();
        std::fs::write(first.path.join("progress.txt"), "half done").unwrap();

        let second = acquire(&root, &repo, "task-retry").await.unwrap();
        assert_eq!(first.path, second.path);
        assert!(second.path.join("progress.txt").exists());
    }
}

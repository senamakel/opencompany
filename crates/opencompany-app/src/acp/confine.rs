//! Keeping a harness inside the directory it was given.
//!
//! An ACP agent asks its *client* to read and write files — `fs/read_text_file`
//! and `fs/write_text_file` are client methods, served here. So the desktop is
//! the thing standing between a model's idea of a path and the operator's disk,
//! and this module is that boundary.
//!
//! ## Why it is in Rust and not in the webview
//!
//! The console renders the permission prompt, but it must never be the thing
//! that *enforces* the answer. A renderer decides what a person sees; a
//! compromised or merely buggy one would then decide what a model can read. The
//! check lives here, below the UI, so that a path escaping the session
//! directory is refused whether or not anything was rendered.
//!
//! ## Why canonicalisation is not optional
//!
//! `starts_with` on a raw path is the classic wrong answer. `/repo/../etc/passwd`
//! passes it. So does a symlink at `/repo/link` pointing anywhere. Both are
//! ordinary things to find in a working tree, and the second is not even
//! hostile — `node_modules` and build caches are full of links.
//!
//! So the root is canonicalised once, the target is canonicalised, and the
//! comparison happens between two resolved paths. A file that does not exist yet
//! — the common case for a write — has its *parent* resolved instead, because
//! there is nothing yet to resolve and the parent is what decides where the new
//! file lands.

use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfineError {
    #[error("the path is not absolute; ACP requires absolute paths")]
    NotAbsolute,
    #[error("the session root does not exist or cannot be resolved")]
    UnusableRoot,
    #[error("the parent directory does not exist")]
    NoParent,
    #[error("that path is outside the session's directory")]
    Escapes,
    #[error("that path is a directory, not a file")]
    IsDirectory,
}

/// A directory a harness session is allowed to touch, and nothing else.
#[derive(Clone, Debug)]
pub struct Confinement {
    /// Canonical, so every comparison is between resolved paths.
    root: PathBuf,
}

impl Confinement {
    /// Confines to `root`, resolving it once.
    ///
    /// Resolved at construction rather than per check: a root that is itself
    /// behind a symlink would otherwise compare unequal to every canonical
    /// target under it, and refuse everything — a failure that looks like the
    /// boundary working.
    pub fn new(root: &Path) -> Result<Self, ConfineError> {
        let root = root
            .canonicalize()
            .map_err(|_| ConfineError::UnusableRoot)?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolves `path` for reading, or refuses it.
    pub fn resolve_read(&self, path: &Path) -> Result<PathBuf, ConfineError> {
        self.require_absolute(path)?;
        let resolved = path.canonicalize().map_err(|_| ConfineError::Escapes)?;
        self.require_inside(&resolved)?;
        Ok(resolved)
    }

    /// Resolves `path` for writing, or refuses it.
    ///
    /// The file need not exist — that is the normal case for a write — so the
    /// **parent** is what gets resolved. A parent that is a symlink out of the
    /// tree is caught by exactly the same comparison, which is the point: a
    /// write to `<root>/link/escape.txt` where `link` leaves the root must be
    /// refused, and it is only visible after resolution.
    ///
    /// ## The dangling link
    ///
    /// Resolving the parent is not sufficient on its own, because a *dangling*
    /// symlink does not canonicalize. `<root>/link -> /outside/planted.txt`
    /// with no `planted.txt` yet fails `path.canonicalize()`, takes the
    /// does-not-exist-yet branch, and its parent is the root — so every check
    /// passes and the returned path is `<root>/link`. `fs::write` then follows
    /// the link and creates the file outside the root, which is the escape this
    /// module exists to refuse. The final component is therefore checked with
    /// `symlink_metadata`, which does not follow.
    ///
    /// What remains, and is not closeable here: a link planted between this
    /// resolution and the caller's `open`. Closing that needs `O_NOFOLLOW` on
    /// the write itself, which is the caller's syscall to make.
    pub fn resolve_write(&self, path: &Path) -> Result<PathBuf, ConfineError> {
        self.require_absolute(path)?;
        if let Ok(resolved) = path.canonicalize() {
            // Already exists: resolve it directly, so an existing symlink is
            // followed before the check rather than after.
            self.require_inside(&resolved)?;
            // A directory is never what a write means, and a path ending in
            // `..` resolves to one. Answering `Ok` would hand the caller a
            // target whose write fails at the OS with a much less obvious
            // message than this one.
            if resolved.is_dir() {
                return Err(ConfineError::IsDirectory);
            }
            return Ok(resolved);
        }

        let parent = path.parent().ok_or(ConfineError::NoParent)?;
        let name = path.file_name().ok_or(ConfineError::NoParent)?;
        let parent = parent.canonicalize().map_err(|_| ConfineError::NoParent)?;
        self.require_inside(&parent)?;

        // The final component reached here because it did not canonicalize.
        // That is usually "no such file", which is the ordinary case for a
        // write — but it is also what a dangling symlink looks like, and a
        // write through one lands wherever it points. `symlink_metadata` is the
        // one stat that does not follow, so it can tell the two apart.
        let target = parent.join(name);
        if std::fs::symlink_metadata(&target).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(ConfineError::Escapes);
        }
        Ok(target)
    }

    fn require_absolute(&self, path: &Path) -> Result<(), ConfineError> {
        // ACP mandates absolute paths. Accepting a relative one would silently
        // resolve it against this *process's* working directory, which has
        // nothing to do with the session.
        if path.is_absolute() {
            Ok(())
        } else {
            Err(ConfineError::NotAbsolute)
        }
    }

    fn require_inside(&self, resolved: &Path) -> Result<(), ConfineError> {
        // Component-wise, not string-prefix: `/repo-secrets` has `/repo` as a
        // string prefix but is a different directory, and `starts_with` on
        // `Path` compares whole components.
        if resolved.starts_with(&self.root) {
            Ok(())
        } else {
            Err(ConfineError::Escapes)
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        outside: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(outside.join("secrets.txt"), "sshhh").unwrap();
        Fixture {
            _dir: dir,
            root: root.canonicalize().unwrap(),
            outside: outside.canonicalize().unwrap(),
        }
    }

    fn confine(f: &Fixture) -> Confinement {
        Confinement::new(&f.root).unwrap()
    }

    #[test]
    fn a_file_inside_the_root_resolves() {
        let f = fixture();
        let c = confine(&f);
        assert_eq!(
            c.resolve_read(&f.root.join("src/main.rs")).unwrap(),
            f.root.join("src/main.rs")
        );
    }

    #[test]
    fn a_traversal_out_of_the_root_is_refused() {
        // The reason `starts_with` on an unresolved path is the wrong check.
        let f = fixture();
        let c = confine(&f);
        let escape = f.root.join("../outside/secrets.txt");
        assert_eq!(c.resolve_read(&escape), Err(ConfineError::Escapes));
    }

    #[test]
    fn a_symlink_leaving_the_root_is_refused() {
        // Not a hostile construction: working trees are full of links. A check
        // that compared before resolving would follow this one straight out.
        let f = fixture();
        let link = f.root.join("escape");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&f.outside, &link).unwrap();
        #[cfg(not(unix))]
        return;

        let c = confine(&f);
        assert_eq!(
            c.resolve_read(&link.join("secrets.txt")),
            Err(ConfineError::Escapes)
        );
    }

    #[test]
    fn a_write_through_a_symlinked_parent_is_refused() {
        // The write path resolves the PARENT, so this is the case that would
        // slip through if it resolved nothing.
        let f = fixture();
        let link = f.root.join("out");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&f.outside, &link).unwrap();
        #[cfg(not(unix))]
        return;

        let c = confine(&f);
        assert_eq!(
            c.resolve_write(&link.join("planted.txt")),
            Err(ConfineError::Escapes)
        );
    }

    #[test]
    fn a_write_through_a_dangling_symlink_is_refused() {
        // The case the parent-resolution branch does NOT catch on its own. A
        // link whose target does not exist yet fails `canonicalize`, so the
        // path looks exactly like an ordinary new file — and its parent really
        // is the root. Without the `symlink_metadata` check this returns
        // `Ok(<root>/planted.txt)` and the caller's `fs::write` follows the
        // link out of the tree and creates the file there.
        let f = fixture();
        let link = f.root.join("planted.txt");
        let escapee = f.outside.join("planted.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&escapee, &link).unwrap();
        #[cfg(not(unix))]
        return;

        assert!(
            !escapee.exists(),
            "the link must dangle for this to be the case"
        );
        let c = confine(&f);
        assert_eq!(c.resolve_write(&link), Err(ConfineError::Escapes));

        // And the same link pointing back INSIDE the root is still refused
        // rather than silently rewritten to its target: this layer resolves
        // paths, and quietly retargeting a write is a decision, not a
        // resolution.
        let inward = f.root.join("inward.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(f.root.join("src/fresh.rs"), &inward).unwrap();
        assert_eq!(c.resolve_write(&inward), Err(ConfineError::Escapes));
    }

    #[test]
    fn a_new_file_inside_the_root_is_allowed_to_be_written() {
        // The common case: the file does not exist yet, so there is nothing to
        // canonicalise and the parent decides.
        let f = fixture();
        let c = confine(&f);
        let fresh = f.root.join("src/new.rs");
        assert_eq!(c.resolve_write(&fresh).unwrap(), fresh);
    }

    #[test]
    fn a_write_into_a_directory_that_does_not_exist_is_refused() {
        // Refused rather than created: creating intermediate directories on a
        // model's say-so is a decision, and it is not this layer's to make.
        let f = fixture();
        let c = confine(&f);
        assert_eq!(
            c.resolve_write(&f.root.join("nope/deeper/file.txt")),
            Err(ConfineError::NoParent)
        );
    }

    #[test]
    fn a_sibling_whose_name_merely_starts_with_the_root_is_refused() {
        // `/tmp/x/repo-secrets` has `/tmp/x/repo` as a *string* prefix. Path
        // comparison is component-wise, and this asserts it stays that way.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        let sibling = dir.path().join("repo-secrets");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sibling.join("k.txt"), "x").unwrap();

        let c = Confinement::new(&root).unwrap();
        assert_eq!(
            c.resolve_read(&sibling.join("k.txt")),
            Err(ConfineError::Escapes)
        );
    }

    #[test]
    fn a_relative_path_is_refused_rather_than_resolved_against_the_process() {
        // ACP mandates absolute paths. Resolving a relative one here would use
        // *this process's* working directory, which has nothing to do with the
        // session — and would differ depending on how the app was launched.
        let f = fixture();
        let c = confine(&f);
        assert_eq!(
            c.resolve_read(Path::new("src/main.rs")),
            Err(ConfineError::NotAbsolute)
        );
        assert_eq!(
            c.resolve_write(Path::new("src/new.rs")),
            Err(ConfineError::NotAbsolute)
        );
    }

    #[test]
    fn the_root_itself_resolves_even_when_reached_through_a_link() {
        // A root behind a symlink (macOS `/tmp` is one) must not refuse
        // everything under it — a boundary that rejects all is easy to mistake
        // for a boundary that works.
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir_all(real.join("sub")).unwrap();
        std::fs::write(real.join("sub/f.txt"), "x").unwrap();
        let linked = dir.path().join("linked");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &linked).unwrap();
        #[cfg(not(unix))]
        return;

        let c = Confinement::new(&linked).unwrap();
        assert!(c.resolve_read(&linked.join("sub/f.txt")).is_ok());
    }

    #[test]
    fn a_trailing_parent_component_resolves_to_a_directory_and_is_refused() {
        // `<root>/src/..` is the root — genuinely *inside* the confinement, so
        // this is not an escape. It is a directory, and a write to a directory
        // is never what an agent meant.
        let f = fixture();
        let c = confine(&f);
        assert_eq!(
            c.resolve_write(&f.root.join("src/..")),
            Err(ConfineError::IsDirectory)
        );
        // The escape it is easy to confuse this with: one level higher does
        // leave the root, and that is refused as an escape.
        assert_eq!(
            c.resolve_write(&f.root.join("..")),
            Err(ConfineError::Escapes)
        );
    }

    #[test]
    fn an_existing_directory_is_never_a_write_target() {
        let f = fixture();
        let c = confine(&f);
        assert_eq!(
            c.resolve_write(&f.root.join("src")),
            Err(ConfineError::IsDirectory)
        );
    }
}

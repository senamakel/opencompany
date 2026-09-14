# Local instances

The desktop shell runs a roster of hosts on one machine. This file covers the
roster, what an empty data root means for onboarding, and how to run the shell
in development. The shell's other halves — the proxy, the keychain, the
embedded host itself — are in [`desktop.md`](desktop.md).

## Several hosts on one machine

`crates/opencompany-app/src/local.rs` is the layer above `embedded.rs`: `embedded` starts
*one* host over *one* data root and says nothing about which roots exist;
`LocalHosts` is the roster of the roots an operator asked for, and which of them
are listening. Two hosts cannot share a root (`prepare_instance` locks it,
because two would overwrite each other's companies), so a second local company
is a **second root**, not a second process over the first.

The roster is `<data-dir>/instances.json`:

```json
{
  "instances": [
    { "id": "default", "label": "This computer", "autostart": true },
    { "id": "acme", "label": "Acme", "root": "instances/acme", "autostart": true }
  ]
}
```

- **`id`** is minted from the label and is the directory name under
  `instances/`. Renaming changes the label and never the id, so the data stays.
- **`root` absent means the data dir itself** — the `default` instance, where
  every install predating this file already keeps its company. Moving it under
  `instances/default/` would be a migration whose failure mode is "my company is
  gone", in exchange for symmetry.
- **`autostart`** records the last explicit start or stop, so a stopped instance
  is not silently restarted by the next launch.

A `root` that escapes the data dir — absolute, or containing `..` — is dropped
when the roster is read: it is a plain file an operator can edit, and a
hand-edit must not point a host and its lock somewhere this application never
chose.

Commands: `oc_local_instances` lists, `oc_create_local_instance` adds a root and
starts it, `oc_start_local_instance` / `oc_stop_local_instance` take and release
one, `oc_rename_local_instance` changes only the label, and
`oc_forget_local_instance` drops a row **leaving its data on disk**. The distinct
`oc_delete_local_instance` command permanently deletes a desktop-created
instance's root. The desktop's “On this computer” screen exposes the latter
behind an explicit confirmation. The default instance cannot be deleted because
its root is the application data directory itself. Stopping frees the root for
an `opencompany serve` in a terminal.

An instance that fails to start is a row carrying its reason, never a launch
that fails: one busy root must not stop the other instances, or the multi-host
case would be worse than the single-host one it replaces.

### Which empty root gets a company, and which gets the wizard

**None of them.** Every instance the desktop starts takes
`embedded::FirstRun::RunSetupWizard`: it adopts what its root already holds and
seeds nothing, the one at the data root included. `local::start_at` hard-codes
that arm, and `embedded::FirstRun::SeedStarterCompany` survives only for callers
that want a populated host without walking a wizard — the test suites.

That reversed an earlier split, in which the instance at the data root seeded a
starter company from the default preset and only an operator-created instance
got the wizard. Commit `a37854eaf`, *"fix(desktop): open the first-run wizard
instead of seeding a company"*, records why: seeding made `/spec` report
`setup_complete`, `ConnectionConsole` enters its setup phase from that field and
nothing else, and no settings link re-opens the wizard — so the one install that
most needs onboarding became the one install that could never reach it.

[Issue #632](https://github.com/tinyhumansai/opencompany/issues/632)'s guarantee
survives as a guarantee about *reachability* rather than about seeding: the
wizard is anonymous on loopback while the registry is empty, its model step is
skippable, and finishing it seeds a template. Still enterable with no terminal
and no credential — it asks first, which is the point.

An install that already has a company is unaffected either way: seeding was only
ever the fallback half of `bootstrap_companies`, reached when adoption came back
empty.

Seeding was never merely "adds a company", which is why it went. `AppSpec`
reports `setup_complete: stamp || !registry.is_empty()`, and the console opens
`views/setup/SetupWizard.tsx` only on `setup_complete: false` — so a seeded
company **suppresses the wizard permanently**, one silent answer to every
question it would have asked. Two tests in `local.rs` pin the current behaviour
by reading `/spec` over HTTP rather than counting companies, including one for
the instance at the data root.

`RunSetupWizard` skips the *seed* half of `bootstrap_companies` and keeps the
*adopt* half (`desktop::adopt_companies`). Adoption is not optional for either
host: a company the wizard writes is a bundle on disk, and skipping adoption
would mean an instance that came back from every relaunch serving an empty
registry — and reporting setup outstanding again, once per launch.

`oc_embedded` survives as the `default` instance's row, because the shell and
the console ship independently — a `pnpm dev` console against an older `cargo`
build, or a current console against an older shell, degrades to the one-host
behaviour instead of to an unhandled command.

### First run

On the `SeedStarterCompany` branch — `embedded::start`, which is the wrapper
`start_with` exposes for it, and which **no launched application takes** (see
above; it is there for the test suites) —
`opencompany::desktop::bootstrap_companies` runs before the bind, because a host
with an empty registry cannot be signed into
([issue #632](https://github.com/tinyhumansai/opencompany/issues/632)). Sign-in
is per-company — `/api/v1/companies/{id}/auth/…`, or the sole-company alias —
so an empty registry leaves the console rendering a login form for a company
that does not exist.

That is why a *created* instance is not left at an empty registry either: it
takes the `RunSetupWizard` branch, where the wizard is what puts a company
there. The rest of this section describes the seeding branch.

The two ways a company normally reaches the registry are both closed to a
packaged application. Nobody types `serve --company <dir>` at a double-clicked
app, and `POST /api/v1/companies` demands the `platform` scope, which
`PlatformScope` grants only against a configured `platform_auth` — a prosumer
host has no machine credential to hand out, deliberately. So the desktop
bootstraps its own:

1. **Adopt** every company bundle the data root already holds, skipping
   `archived` ones (archiving removes a company from the registry on purpose,
   and re-registering it at the next launch would undo that quietly). The
   bundle is the only authority — a desktop company has no source directory to
   re-read — and `RuntimeBuilder::build` carries the persisted record's
   console-created desks, agents and workflows forward.
2. **Seed** the `DEFAULT_PRESET_ID` preset when there were none, stamping the
   preset slug as the record's template provenance. Fallback rather than
   unconditional: seeding on every launch would hand the operator a second
   starter company per run.

`AppConfig.auth_mode_override` is `Some(AuthMode::None)`, so **no company on
this host has a sign-in** — see [sign-in modes](auth-modes.md#none) for what
that mode is and [the desktop client](desktop.md#no-sign-in-at-all) for why it
is the right one here. There is no `admin_email`, no bootstrap roster in the
seeded manifest, and nothing to type on first launch.

The mode is a **default, not a ceiling**. `prepare_instance` reports the data
root's `config.toml` `auth_mode`, and the shell falls back to `none` only when
the file names nothing — an operator who picks `email` in setup, to share their
instance with a colleague, keeps that choice across the quit. Without that read
the shell would build its `AppConfig` by hand and the file could never win,
which is the "configuration silently ignored" failure the setup surface exists
to prevent.

Note where the mode is set: on the **host**, not in the preset manifests. Two
reasons. It reaches every company on the root — the starter preset, one the
wizard designed, and any left by an install predating this — because
`RuntimeBuilder::with_auth_mode_override` outranks a manifest's own
`[users].mode`, so an existing install migrates by relaunching. And
`validate_users` flags `[users].admins` under `mode = "none"` as granting
nothing, which both seeding paths treat as a hard error; the override never
rewrites `manifest.users.mode`, so there is nothing to flag.

## Running the shell in development

A debug build loads `devUrl` rather than the embedded bundle, so without a
console dev server the window is blank. Use:

```bash
OPENCOMPANY_DATA_DIR=$PWD/target/desktop-dev ./scripts/desktop-dev.sh
```

It starts the dev server (reusing one already on `:5173`), waits for it to
answer, and runs the shell from `crates/opencompany-app/`.

**Not** `build.beforeDevCommand`. The Tauri CLI runs that hook from a directory
it *derives* by scanning for a `package.json`, and which one it picks is not
stable — on a macOS checkout it lands in `frontend/`, on CI's runner it landed
in `vendor/openhuman/`. No relative path is correct from both, so both hooks
are deliberately empty and `ci.yml` packages from two different working
directories to keep them that way (issue #616). A script can do what the hook
cannot: derive every path from its own location.

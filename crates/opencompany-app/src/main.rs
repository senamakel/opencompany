// Prevents a console window opening alongside the app on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `OPENHUMAN_WORKSPACE` must be exported HERE, before anything else starts.
    //
    // The library path deliberately does not do it: `journal::prepare`'s
    // `set_var` is only sound before any other thread exists, and by the time
    // Tauri's runtime, webview process and plugin threads are up, `setenv`
    // racing a concurrent `getenv` is undefined behaviour on glibc rather than
    // a stale read. `main` is the one moment this process is single-threaded.
    //
    // Resolved the same way the embedded host will resolve it, so the value
    // exported here and the root it later probes are the same directory.
    let data_dir = opencompany_desktop_lib::default_data_dir();
    if std::env::var_os("OPENHUMAN_WORKSPACE").is_none() {
        // SAFETY: first statement of `main`, before any thread is spawned and
        // before Tauri or tokio exist. Nothing else can be reading the
        // environment yet.
        unsafe { std::env::set_var("OPENHUMAN_WORKSPACE", data_dir.join("openhuman")) };
    }

    opencompany_desktop_lib::run();
}

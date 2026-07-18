fn main() {
    // Expose the rustc version that compiled us as an env var the code can read
    // via env!("RUSTC_VERSION"). Falls back to "unknown" if rustc is missing.
    let version = std::process::Command::new(
        std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string()),
    )
    .arg("--version")
    .output()
    .ok()
    .and_then(|o| String::from_utf8(o.stdout).ok())
    .map(|s| s.trim().to_string())
    .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=RUSTC_VERSION={}", version);

    tauri_build::build()
}

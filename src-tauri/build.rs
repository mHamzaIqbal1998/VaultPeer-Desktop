fn main() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let source = manifest_dir.join("icons/source.png");
    let icon_path = manifest_dir.join("icons/icon.ico");

    for rel in [
        "icons/source.png",
        "icons/icon.ico",
        "icons/32x32.png",
        "icons/64x64.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        "tauri.conf.json",
    ] {
        println!("cargo:rerun-if-changed={rel}");
    }

    // Always regenerate icon.ico from source.png using the same `ico` crate
    // Tauri uses at runtime. Hand-edited or PNG-in-ICO files are rejected by
    // MSVC's rc.exe / windres, leaving a stale icon embedded in the .exe.
    if source.exists() {
        regenerate_icon_ico(&source, &icon_path);
    }

    // Explorer picks the icon resource with the lowest numeric ID. Tauri embeds
    // at 32512 (historical mistake); add ID 1 so File Explorer uses our icon.
    let rc_icon = rc_path_for_resource_compiler(&icon_path);
    let windows = tauri_build::WindowsAttributes::new()
        .window_icon_path(&icon_path)
        .append_rc_content(format!(r#"1 ICON "{}""#, rc_icon));

    let attrs = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attrs).expect("failed to run build script");
}

fn regenerate_icon_ico(source: &std::path::Path, out: &std::path::Path) {
    use ico::{IconDir, IconDirEntry, IconImage, ResourceType};
    use image::imageops::FilterType;

    let img = image::open(source).unwrap_or_else(|e| {
        panic!("failed to open {}: {e}", source.display());
    });

    // Tauri docs: 16, 24, 32, 48, 64, 256 — with 32 px listed first.
    let sizes = [32u32, 16, 24, 48, 64, 256];
    let mut icon_dir = IconDir::new(ResourceType::Icon);
    for size in sizes {
        let resized = img.resize_exact(size, size, FilterType::Lanczos3);
        let rgba = resized.to_rgba8();
        let icon_image = IconImage::from_rgba_data(size, size, rgba.into_raw());
        icon_dir.add_entry(
            IconDirEntry::encode_as_bmp(&icon_image).expect("encode icon layer as BMP"),
        );
    }

    let file = std::fs::File::create(out).unwrap_or_else(|e| {
        panic!("failed to create {}: {e}", out.display());
    });
    icon_dir.write(file).unwrap_or_else(|e| {
        panic!("failed to write {}: {e}", out.display());
    });
}

fn rc_path_for_resource_compiler(path: &std::path::Path) -> String {
    let canonical = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    canonical
        .to_string_lossy()
        .replace('\\', "/")
}

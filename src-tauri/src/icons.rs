use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx};
use windows::Win32::UI::Shell::*;
use windows::core::PCWSTR;

fn file_data_url(path: &str) -> Option<String> {
    let lower = path.to_lowercase();
    let mime = if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        return None;
    };
    let bytes = std::fs::read(path).ok()?;
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

pub fn icon_for(target: &str) -> Option<String> {
    let target = target.trim().trim_matches('"');
    if let Some(url) = file_data_url(target) {
        return Some(url);
    }
    if let Some(appid) = target.strip_prefix("steam://rungameid/") {
        let root = crate::games::steam_root()?;
        let art = crate::games::find_art(&root, appid.trim_end_matches('/'))?;
        return file_data_url(&art);
    }
    if target.contains("://") {
        return None;
    }
    shell_icon(target, 128)
}

fn shell_icon(path: &str, size: i32) -> Option<String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
        let factory: IShellItemImageFactory = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).ok()?;
        let hbmp = factory
            .GetImage(SIZE { cx: size, cy: size }, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK)
            .ok()?;

        let mut bmp = BITMAP::default();
        GetObjectW(HGDIOBJ(hbmp.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bmp as *mut _ as *mut _));
        let (w, h) = (bmp.bmWidth, bmp.bmHeight);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // 上から下へ
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let dc = GetDC(None);
        let lines = GetDIBits(dc, hbmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
        ReleaseDC(None, dc);
        let _ = DeleteObject(HGDIOBJ(hbmp.0));
        if lines == 0 || w <= 0 || h <= 0 {
            return None;
        }

        // BGRA（乗算済みアルファ）→ RGBA（ストレートアルファ）
        for px in buf.chunks_exact_mut(4) {
            let a = px[3] as u32;
            let (b, g, r) = (px[0] as u32, px[1] as u32, px[2] as u32);
            let un = |c: u32| if a == 0 { 0 } else { (c * 255 / a).min(255) as u8 };
            px[0] = un(r);
            px[1] = un(g);
            px[2] = un(b);
        }

        let mut png_bytes = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut png_bytes, w as u32, h as u32);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut writer = enc.write_header().ok()?;
            writer.write_image_data(&buf).ok()?;
        }
        Some(format!("data:image/png;base64,{}", STANDARD.encode(png_bytes)))
    }
}

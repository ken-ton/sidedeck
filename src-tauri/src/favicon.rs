use base64::{Engine, engine::general_purpose::STANDARD};
use std::io::Read;
use std::time::Duration;
use url::Url;

const MAX_HTML: u64 = 1024 * 1024;
const MAX_ICON: u64 = 2 * 1024 * 1024;

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(8))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) SideDeck")
        .build()
}

fn get(agent: &ureq::Agent, url: &Url, max: u64) -> Option<(String, Vec<u8>, Url)> {
    let res = agent.get(url.as_str()).call().ok()?;
    let final_url = Url::parse(res.get_url()).unwrap_or_else(|_| url.clone());
    let mime = res.content_type().to_string();
    let mut buf = Vec::new();
    res.into_reader().take(max).read_to_end(&mut buf).ok()?;
    Some((mime, buf, final_url))
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let i = from + i;
        from = i + name.len();
        // 単語の途中（data-href など）は除く
        if i > 0 && !lower.as_bytes()[i - 1].is_ascii_whitespace() {
            continue;
        }
        let rest = tag[from..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else { continue };
        let rest = rest.trim_start();
        return match rest.chars().next()? {
            q @ ('"' | '\'') => rest[1..].split(q).next(),
            _ => rest.split(|c: char| c.is_whitespace() || c == '>').next(),
        };
    }
    None
}

/// <link rel="icon"> などの候補を、大きそうな順に並べる
fn candidates(html: &str, base: &Url) -> Vec<Url> {
    let lower = html.to_ascii_lowercase();
    let mut found: Vec<(u32, Url)> = Vec::new();
    let mut from = 0;
    while let Some(i) = lower[from..].find("<link") {
        let start = from + i;
        let end = lower[start..].find('>').map(|e| start + e).unwrap_or(lower.len());
        from = end;
        let tag = &html[start..end];
        let Some(rel) = attr(tag, "rel").map(|r| r.to_ascii_lowercase()) else { continue };
        let rels: Vec<&str> = rel.split_whitespace().collect();
        let apple = rels.iter().any(|r| r.starts_with("apple-touch-icon"));
        if !apple && !rels.contains(&"icon") {
            continue;
        }
        let Some(href) = attr(tag, "href").and_then(|h| base.join(&h.replace("&amp;", "&")).ok()) else { continue };
        let size = attr(tag, "sizes")
            .and_then(|s| s.split(['x', 'X']).next()?.parse::<u32>().ok())
            .unwrap_or(if apple { 180 } else if href.path().ends_with(".svg") { 512 } else { 32 });
        found.push((size, href));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, u)| u).collect()
}

fn image_mime(mime: &str, url: &Url, bytes: &[u8]) -> Option<String> {
    let mime = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if mime.starts_with("image/") {
        return Some(mime);
    }
    let path = url.path().to_ascii_lowercase();
    let guessed = if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(&[0, 0, 1, 0]) || path.ends_with(".ico") {
        "image/x-icon"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else {
        return None;
    };
    Some(guessed.into())
}

pub fn fetch(target: &str) -> Option<String> {
    let page = Url::parse(target).ok().filter(|u| matches!(u.scheme(), "http" | "https"))?;
    let agent = agent();
    let mut list = Vec::new();
    if let Some((mime, html, final_url)) = get(&agent, &page, MAX_HTML) {
        if mime.contains("html") {
            list = candidates(&String::from_utf8_lossy(&html), &final_url);
        }
        list.extend(final_url.join("/favicon.ico").ok());
    }
    list.extend(page.join("/favicon.ico").ok());
    for url in list {
        let Some((mime, bytes, final_url)) = get(&agent, &url, MAX_ICON) else { continue };
        if bytes.is_empty() {
            continue;
        }
        if let Some(mime) = image_mime(&mime, &final_url, &bytes) {
            return Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_largest_icon() {
        let base = Url::parse("https://example.com/a/b").unwrap();
        let html = r#"<link rel="icon" href="/f16.png" sizes="16x16"><LINK REL='apple-touch-icon' HREF='touch.png'><link data-href="x" rel="shortcut icon" href="https://cdn.example.com/f.ico">"#;
        let c: Vec<String> = candidates(html, &base).into_iter().map(|u| u.to_string()).collect();
        assert_eq!(c, ["https://example.com/a/touch.png", "https://cdn.example.com/f.ico", "https://example.com/f16.png"]);
    }

    #[test]
    #[ignore]
    fn fetches_favicon() {
        for u in ["https://github.com", "https://www.youtube.com/", "https://store.steampowered.com/"] {
            println!("{u} -> {:?}", fetch(u).map(|d| d[..40.min(d.len())].to_string()));
        }
    }
}

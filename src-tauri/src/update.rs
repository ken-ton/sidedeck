use serde::Serialize;
use std::time::Duration;

const LATEST: &str = "https://api.github.com/repos/ken-ton/sidedeck/releases/latest";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub version: String,
    pub url: String,
}

fn parse(v: &str) -> Option<Vec<u64>> {
    v.trim().trim_start_matches('v').split('.').map(|p| p.parse().ok()).collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    matches!((parse(latest), parse(current)), (Some(l), Some(c)) if l > c)
}

pub fn check(current: &str) -> Result<Option<Update>, String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).user_agent("SideDeck").build();
    let body = agent
        .get(LATEST)
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())?;
    let res: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let tag = res["tag_name"].as_str().ok_or("tag_name がありません")?;
    let url = res["html_url"].as_str().unwrap_or("https://github.com/ken-ton/sidedeck/releases/latest");
    Ok(is_newer(tag, current).then(|| Update { version: tag.trim_start_matches('v').into(), url: url.into() }))
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn compares_versions() {
        assert!(is_newer("v0.4.10", "0.4.9"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        assert!(!is_newer("v0.4.2", "0.4.2"));
        assert!(!is_newer("v0.4.1", "0.4.2"));
        assert!(!is_newer("nightly", "0.4.2"));
    }
}

#[cfg(test)]
mod live {
    #[test]
    #[ignore]
    fn checks_github() {
        println!("{:?}", super::check("0.0.1").map(|u| u.map(|u| (u.version, u.url))));
    }
}

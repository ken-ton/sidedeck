use base64::Engine;
use serde::Serialize;
use std::sync::Mutex;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as Manager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    title: String,
    artist: String,
    playing: bool,
    /// data URL
    thumbnail: Option<String>,
}

/// サムネイルは曲が変わったときだけ読み直す（曲名・アーティスト → data URL）
static THUMB: Mutex<Option<(String, Option<String>)>> = Mutex::new(None);

pub fn get() -> windows::core::Result<Option<NowPlaying>> {
    let manager = Manager::RequestAsync()?.get()?;
    let Ok(session) = manager.GetCurrentSession() else {
        return Ok(None);
    };
    let props = session.TryGetMediaPropertiesAsync()?.get()?;
    let title = props.Title()?.to_string();
    let artist = props.Artist()?.to_string();
    if title.is_empty() && artist.is_empty() {
        return Ok(None);
    }
    let playing = session.GetPlaybackInfo()?.PlaybackStatus()? == Status::Playing;
    let key = format!("{}\u{0}{title}\u{0}{artist}", session.SourceAppUserModelId()?);
    let mut cache = THUMB.lock().unwrap();
    let thumbnail = match cache.as_ref() {
        Some((k, Some(t))) if *k == key => Some(t.clone()),
        _ => {
            // 曲が変わった直後は画像がまだないことがあるので、取れなかったときは次に取り直す
            let t = props.Thumbnail().ok().and_then(|r| read_thumbnail(&r).ok());
            *cache = Some((key, t.clone()));
            t
        }
    };
    Ok(Some(NowPlaying { title, artist, playing, thumbnail }))
}

fn read_thumbnail(r: &IRandomAccessStreamReference) -> windows::core::Result<String> {
    let stream = r.OpenReadAsync()?.get()?;
    let size = stream.Size()? as u32;
    let content_type = stream.ContentType()?.to_string();
    // Apple Music は "image/jpeg,image/jpe,image/jpg" のように並べて返す
    let content_type = content_type.split([',', ';']).next().unwrap_or_default().trim().to_string();
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
    reader.LoadAsync(size)?.get()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf)?;
    let mime = if content_type.starts_with("image/") && !content_type.contains(' ') { content_type } else { "image/png".into() };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(buf)))
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore]
    fn reads_now_playing() {
        let np = super::get().unwrap();
        println!("{:?}", np.map(|n| (n.title, n.artist, n.playing, n.thumbnail.map(|t| t[..40].to_string()))));
    }
}
